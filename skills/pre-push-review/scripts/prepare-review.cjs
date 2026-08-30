#!/usr/bin/env node
'use strict';

/**
 * Build the two immutable inputs for the pre-push compliance reviewer.
 *
 * Every subprocess receives a fixed executable and an argv array. Repository-controlled paths,
 * branch names, and commit metadata are never interpreted by a shell.
 */

const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
} = require('node:fs');
const path = require('node:path');
const {
  collectHeadInstructions,
  collectWorkspaceInstructions,
} = require('./instruction-snapshots.cjs');

const OUTPUT_MARKER = 'STE_AI_REVIEW_INPUT_V1';
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_BYTES = 8 * 1024 * 1024;
const MAX_PATCH_BYTES = 512 * 1024;
const MAX_CHANGED_PATHS = 2_000;
const MAX_REPOSITORY_PATHS = 50_000;
const MAX_UNTRACKED_FILES = 128;
const MAX_UNTRACKED_FILE_BYTES = 256 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 512 * 1024;
const MAX_SOURCE_FILE_BYTES = 256 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 512 * 1024;
const MAX_SERIALIZED_OUTPUT_BYTES = 96 * 1024;
const COLLECTION_TIMEOUT_MS = 30_000;
const TRANSPORT_CHUNK_CHARACTERS = 255;
const TRANSPORT_CHUNK_PREFIX = 'STE_AI_REVIEW_JSON_CHUNK ';
const TRANSPORT_END_MARKER = 'STE_AI_REVIEW_JSON_END';

let collectionDeadline = Number.POSITIVE_INFINITY;
const trustedExecutables = new Map();

function resolveTrustedExecutable(name, reviewedDirectory) {
  const pathEntries = (process.env['PATH'] ?? '').split(path.delimiter);
  for (const entry of pathEntries) {
    if (entry === '' || !path.isAbsolute(entry)) continue;
    const candidate = path.join(entry, name);
    try {
      accessSync(candidate, constants.X_OK);
      const canonical = realpathSync(candidate);
      if (canonical === reviewedDirectory || isContained(reviewedDirectory, canonical)) continue;
      return canonical;
    } catch {
      // Continue to the next absolute PATH entry.
    }
  }
  throw new Error(`cannot resolve a trusted ${name} executable outside the reviewed directory`);
}

function discoverRepositoryEnvelope(initialCwd) {
  let current = initialCwd;
  let envelope;
  for (;;) {
    try {
      lstatSync(path.join(current, '.git'));
      envelope = current;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error(`cannot inspect repository boundary ${current}: ${error.message}`, {
          cause: error,
        });
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (envelope === undefined) {
    throw new Error('cannot find a .git repository boundary without executing Git');
  }
  return realpathSync(envelope);
}

function run(command, args, cwd) {
  const remaining = collectionDeadline - Date.now();
  if (remaining <= 0)
    throw new Error(`review input collection exceeded ${COLLECTION_TIMEOUT_MS}ms`);
  const executable = trustedExecutables.get(command);
  if (executable === undefined) throw new Error(`trusted executable is unresolved: ${command}`);
  const trustedPath = [...new Set([...trustedExecutables.values()].map(path.dirname))].join(
    path.delimiter,
  );
  const environment = {
    ...process.env,
    PATH: trustedPath,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
  };
  delete environment.GIT_EXEC_PATH;
  delete environment.GIT_EXTERNAL_DIFF;
  return spawnSync(executable, args, {
    cwd,
    encoding: null,
    env: environment,
    maxBuffer: MAX_COMMAND_BYTES,
    shell: false,
    timeout: Math.min(COMMAND_TIMEOUT_MS, remaining),
    windowsHide: true,
  });
}

function runGit(cwd, args) {
  return run(
    'git',
    ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
    cwd,
  );
}

function decodeUtf8(buffer, label) {
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) {
    throw new Error(`${label} is not valid UTF-8`);
  }
  return text;
}

function commandFailure(result) {
  if (result.error !== undefined) return result.error.message;
  const stderr = result.stderr === null ? '' : result.stderr.toString('utf8').trim();
  return stderr || `command exited with status ${String(result.status)}`;
}

function requireSuccess(result, label) {
  if (result.status !== 0 || result.error !== undefined || result.stdout === null) {
    throw new Error(`${label}: ${commandFailure(result)}`);
  }
  return decodeUtf8(result.stdout, label);
}

function splitNullDelimited(buffer, label) {
  const values = [];
  let start = 0;
  for (;;) {
    const end = buffer.indexOf(0, start);
    if (end === -1) break;
    if (end > start) values.push(decodeUtf8(buffer.subarray(start, end), label));
    start = end + 1;
  }
  if (start !== buffer.length) throw new Error(`${label} is not NUL terminated`);
  return values;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function boundedPathList(result, label, source, maximum = MAX_CHANGED_PATHS) {
  if (result.status !== 0 || result.stdout === null || result.error !== undefined) {
    source.complete = false;
    source.diagnostics.push(`${label}: ${commandFailure(result)}`);
    return [];
  }
  try {
    const paths = [...new Set(splitNullDelimited(result.stdout, label))];
    if (paths.length > maximum) {
      source.complete = false;
      source.diagnostics.push(`${label} exceeds ${maximum} paths`);
      return paths.slice(0, maximum);
    }
    return paths;
  } catch (error) {
    source.complete = false;
    source.diagnostics.push(error.message);
    return [];
  }
}

function contentRecord(relativePath, buffer, kind, source, byteState) {
  if (
    buffer.length > MAX_SOURCE_FILE_BYTES ||
    byteState.total + buffer.length > MAX_SOURCE_TOTAL_BYTES
  ) {
    source.complete = false;
    source.diagnostics.push(`changed file is too large to review: ${relativePath}`);
    return { path: relativePath, kind: 'omitted', size: buffer.length };
  }
  byteState.total += buffer.length;
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  try {
    return {
      path: relativePath,
      kind,
      content: decodeUtf8(buffer, `changed file ${relativePath}`),
      sha256,
    };
  } catch {
    source.complete = false;
    source.diagnostics.push(`changed file is binary and cannot be reviewed: ${relativePath}`);
    return { path: relativePath, kind: 'binary', size: buffer.length, sha256 };
  }
}

function markChangedSymlinkIncomplete(source, relativePath) {
  source.complete = false;
  const message = `changed path is a symbolic link with unavailable whole-file content: ${relativePath}`;
  if (!source.diagnostics.includes(message)) source.diagnostics.push(message);
}

function readBoundedRegularFile(filePath, maximumBytes) {
  const descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('target is not a regular file');
    if (stat.size > maximumBytes) return { omittedSize: stat.size };
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let total = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, total, buffer.length - total, null);
      if (count === 0) break;
      total += count;
      if (total > maximumBytes) return { omittedSize: total };
    }
    return { buffer: buffer.subarray(0, total) };
  } finally {
    closeSync(descriptor);
  }
}

function captureHeadFiles(root, headOid, changedPaths, source) {
  const files = [];
  const byteState = { total: 0 };
  for (const relativePath of changedPaths) {
    const treeResult = runGit(root, ['ls-tree', '-z', headOid, '--', `:(literal)${relativePath}`]);
    if (treeResult.status !== 0 || treeResult.stdout === null || treeResult.error !== undefined) {
      source.complete = false;
      source.diagnostics.push(
        `cannot inspect HEAD file ${relativePath}: ${commandFailure(treeResult)}`,
      );
      files.push({ path: relativePath, kind: 'unreadable' });
      continue;
    }
    const entries = splitNullDelimited(treeResult.stdout, `HEAD file ${relativePath}`);
    if (entries.length === 0) {
      files.push({ path: relativePath, kind: 'deleted' });
      continue;
    }
    const tab = entries[0].indexOf('\t');
    const metadata = tab === -1 ? [] : entries[0].slice(0, tab).split(' ');
    const [mode, type, oid] = metadata;
    if (tab === -1 || type !== 'blob' || !/^[0-9a-f]{40,64}$/i.test(oid ?? '')) {
      source.complete = false;
      source.diagnostics.push(`HEAD path is not a reviewable file: ${relativePath}`);
      files.push({ path: relativePath, kind: type === 'commit' ? 'submodule' : 'unreadable' });
      continue;
    }
    const sizeResult = runGit(root, ['cat-file', '-s', oid]);
    if (sizeResult.status !== 0 || sizeResult.stdout === null || sizeResult.error !== undefined) {
      source.complete = false;
      source.diagnostics.push(
        `cannot size HEAD file ${relativePath}: ${commandFailure(sizeResult)}`,
      );
      files.push({ path: relativePath, kind: 'unreadable' });
      continue;
    }
    const size = Number(sizeResult.stdout.toString('ascii').trim());
    if (!Number.isSafeInteger(size) || size < 0) {
      source.complete = false;
      source.diagnostics.push(`HEAD file has an invalid size: ${relativePath}`);
      files.push({ path: relativePath, kind: 'unreadable' });
      continue;
    }
    if (size > MAX_SOURCE_FILE_BYTES || byteState.total + size > MAX_SOURCE_TOTAL_BYTES) {
      source.complete = false;
      source.diagnostics.push(`changed file is too large to review: ${relativePath}`);
      files.push({ path: relativePath, kind: 'omitted', size });
      continue;
    }
    const blobResult = runGit(root, ['cat-file', 'blob', oid]);
    if (blobResult.status !== 0 || blobResult.stdout === null || blobResult.error !== undefined) {
      source.complete = false;
      source.diagnostics.push(
        `cannot read HEAD file ${relativePath}: ${commandFailure(blobResult)}`,
      );
      files.push({ path: relativePath, kind: 'unreadable' });
      continue;
    }
    if (mode === '120000') {
      try {
        markChangedSymlinkIncomplete(source, relativePath);
        files.push({
          path: relativePath,
          kind: 'symlink',
          target: decodeUtf8(blobResult.stdout, `symbolic link ${relativePath}`),
        });
      } catch (error) {
        source.complete = false;
        source.diagnostics.push(error.message);
        files.push({ path: relativePath, kind: 'unreadable' });
      }
    } else {
      files.push(contentRecord(relativePath, blobResult.stdout, 'text', source, byteState));
    }
  }
  return files;
}

function captureIndexFiles(root, changedPaths, source, markSymlinks = true) {
  const files = [];
  const byteState = { total: 0 };
  for (const relativePath of changedPaths) {
    const indexResult = runGit(root, [
      'ls-files',
      '--stage',
      '-z',
      '--',
      `:(literal)${relativePath}`,
    ]);
    if (
      indexResult.status !== 0 ||
      indexResult.stdout === null ||
      indexResult.error !== undefined
    ) {
      source.complete = false;
      source.diagnostics.push(
        `cannot inspect index file ${relativePath}: ${commandFailure(indexResult)}`,
      );
      files.push({ path: relativePath, kind: 'unreadable' });
      continue;
    }
    const entries = splitNullDelimited(indexResult.stdout, `index file ${relativePath}`);
    if (entries.length === 0) {
      files.push({ path: relativePath, kind: 'deleted' });
      continue;
    }
    if (entries.length !== 1) {
      source.complete = false;
      source.diagnostics.push(`index file has unresolved stages: ${relativePath}`);
      files.push({ path: relativePath, kind: 'unmerged' });
      continue;
    }
    const tab = entries[0].indexOf('\t');
    const metadata = tab === -1 ? [] : entries[0].slice(0, tab).split(' ');
    const [mode, oid, stage] = metadata;
    if (tab === -1 || stage !== '0' || !/^[0-9a-f]{40,64}$/i.test(oid ?? '')) {
      source.complete = false;
      source.diagnostics.push(`index path is not a reviewable file: ${relativePath}`);
      files.push({ path: relativePath, kind: mode === '160000' ? 'submodule' : 'unreadable' });
      continue;
    }
    if (mode === '160000') {
      source.complete = false;
      source.diagnostics.push(`index path is a submodule: ${relativePath}`);
      files.push({ path: relativePath, kind: 'submodule' });
      continue;
    }
    const sizeResult = runGit(root, ['cat-file', '-s', oid]);
    if (sizeResult.status !== 0 || sizeResult.stdout === null || sizeResult.error !== undefined) {
      source.complete = false;
      source.diagnostics.push(
        `cannot size index file ${relativePath}: ${commandFailure(sizeResult)}`,
      );
      files.push({ path: relativePath, kind: 'unreadable' });
      continue;
    }
    const size = Number(sizeResult.stdout.toString('ascii').trim());
    if (!Number.isSafeInteger(size) || size < 0) {
      source.complete = false;
      source.diagnostics.push(`index file has an invalid size: ${relativePath}`);
      files.push({ path: relativePath, kind: 'unreadable' });
      continue;
    }
    if (size > MAX_SOURCE_FILE_BYTES || byteState.total + size > MAX_SOURCE_TOTAL_BYTES) {
      source.complete = false;
      source.diagnostics.push(`changed file is too large to review: ${relativePath}`);
      files.push({ path: relativePath, kind: 'omitted', size });
      continue;
    }
    const blobResult = runGit(root, ['cat-file', 'blob', oid]);
    if (blobResult.status !== 0 || blobResult.stdout === null || blobResult.error !== undefined) {
      source.complete = false;
      source.diagnostics.push(
        `cannot read index file ${relativePath}: ${commandFailure(blobResult)}`,
      );
      files.push({ path: relativePath, kind: 'unreadable' });
      continue;
    }
    if (mode === '120000') {
      try {
        if (markSymlinks) markChangedSymlinkIncomplete(source, relativePath);
        files.push({
          path: relativePath,
          kind: 'symlink',
          target: decodeUtf8(blobResult.stdout, `index symbolic link ${relativePath}`),
        });
      } catch (error) {
        source.complete = false;
        source.diagnostics.push(error.message);
        files.push({ path: relativePath, kind: 'unreadable' });
      }
    } else {
      files.push(contentRecord(relativePath, blobResult.stdout, 'text', source, byteState));
    }
  }
  return files;
}

function captureWorkspaceFiles(root, changedPaths, source, markSymlinks = true) {
  const files = [];
  const byteState = { total: 0 };
  for (const relativePath of changedPaths) {
    const nativePath = path.resolve(root, relativePath);
    if (!isContained(root, nativePath) || nativePath === root) {
      source.complete = false;
      source.diagnostics.push(`changed path escapes the repository: ${relativePath}`);
      files.push({ path: relativePath, kind: 'unreadable' });
      continue;
    }
    try {
      const stat = lstatSync(nativePath);
      if (stat.isSymbolicLink()) {
        if (markSymlinks) markChangedSymlinkIncomplete(source, relativePath);
        files.push({
          path: relativePath,
          kind: 'symlink',
          target: decodeUtf8(
            readlinkSync(nativePath, { encoding: 'buffer' }),
            `symbolic link ${relativePath}`,
          ),
        });
        continue;
      }
      if (!stat.isFile()) {
        source.complete = false;
        source.diagnostics.push(`changed path is not a regular file: ${relativePath}`);
        files.push({ path: relativePath, kind: 'unreadable' });
        continue;
      }
      const canonicalPath = realpathSync(nativePath);
      if (!isContained(root, canonicalPath)) {
        source.complete = false;
        source.diagnostics.push(`changed file resolves outside the repository: ${relativePath}`);
        files.push({ path: relativePath, kind: 'unreadable' });
        continue;
      }
      const maximumBytes = Math.min(
        MAX_SOURCE_FILE_BYTES,
        MAX_SOURCE_TOTAL_BYTES - byteState.total,
      );
      const bounded = readBoundedRegularFile(canonicalPath, Math.max(0, maximumBytes));
      if (bounded.buffer === undefined) {
        source.complete = false;
        source.diagnostics.push(`changed file is too large to review: ${relativePath}`);
        files.push({ path: relativePath, kind: 'omitted', size: bounded.omittedSize });
        continue;
      }
      files.push(contentRecord(relativePath, bounded.buffer, 'text', source, byteState));
    } catch (error) {
      if (error?.code === 'ENOENT') files.push({ path: relativePath, kind: 'deleted' });
      else {
        source.complete = false;
        source.diagnostics.push(`cannot read changed file ${relativePath}: ${error.message}`);
        files.push({ path: relativePath, kind: 'unreadable' });
      }
    }
  }
  return files;
}

function untrackedFingerprint(records) {
  return JSON.stringify(
    records.map((record) => ({
      path: record.path,
      kind: record.kind,
      sha256: record.sha256,
      size: record.size,
      target: record.target,
    })),
  );
}

function fileStateFingerprint(records) {
  return JSON.stringify(
    records.map((record) => ({
      path: record.path,
      kind: record.kind,
      sha256: record.sha256,
      size: record.size,
      target: record.target,
    })),
  );
}

function instructionFingerprint(snapshot) {
  return JSON.stringify({
    complete: snapshot.complete,
    diagnostics: snapshot.diagnostics,
    files: snapshot.files.map((record) => ({
      path: record.path,
      canonicalPath: record.canonicalPath,
      routes: record.routes,
      sha256: createHash('sha256').update(record.content).digest('hex'),
    })),
  });
}

function pauseForRaceTest() {
  if (process.env['NODE_ENV'] !== 'test') return;
  const requested = Number(process.env['STE_AI_REVIEW_TEST_PAUSE_MS'] ?? '0');
  if (!Number.isFinite(requested) || requested <= 0) return;
  const duration = Math.min(requested, 5_000);
  if (typeof process.send === 'function') process.send('ste-ai-review-snapshot-ready');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

function isStandardInstructionPath(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized === 'AGENTS.md' || normalized.endsWith('/AGENTS.md')) return true;
  if (normalized === 'CLAUDE.md' || normalized.endsWith('/CLAUDE.md')) return true;
  if (normalized === '.claude/CLAUDE.md') return true;
  return (
    /(?:^|\/)\.claude(?:\/rules(?:\/.*)?)?$/.test(normalized) ||
    /(?:^|\/)\.cursor(?:\/rules(?:\/.*)?)?$/.test(normalized) ||
    /(?:^|\/)\.agents(?:\/rules(?:\/.*)?)?$/.test(normalized)
  );
}

function validateCommit(cwd, candidate) {
  if (!/^[0-9a-f]{40,64}$/i.test(candidate)) return undefined;
  const result = runGit(cwd, ['rev-parse', '--verify', `${candidate}^{commit}`]);
  if (result.status !== 0 || result.stdout === null || result.error !== undefined) return undefined;
  const oid = result.stdout.toString('utf8').trim();
  return /^[0-9a-f]{40,64}$/i.test(oid) ? oid : undefined;
}

function fallbackBase(root) {
  const symbolic = runGit(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (symbolic.status !== 0 || symbolic.stdout === null || symbolic.error !== undefined) {
    return undefined;
  }
  const reference = symbolic.stdout.toString('utf8').trim();
  const resolved = runGit(root, ['rev-parse', '--verify', `${reference}^{commit}`]);
  if (resolved.status !== 0 || resolved.stdout === null || resolved.error !== undefined) {
    return undefined;
  }
  const oid = resolved.stdout.toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/i.test(oid)) return undefined;
  return { oid, source: reference };
}

function resolveBase(root) {
  const diagnostics = [];
  const pullRequest = run('gh', ['pr', 'view', '--json', 'baseRefOid'], root);
  if (pullRequest.status === 0 && pullRequest.stdout !== null && pullRequest.error === undefined) {
    try {
      const parsed = JSON.parse(decodeUtf8(pullRequest.stdout, 'pull request response'));
      const oid = validateCommit(root, parsed?.baseRefOid);
      if (oid !== undefined) return { complete: true, diagnostics, oid, source: 'pull-request' };
      diagnostics.push('pull request base is missing or is not a local commit');
      return { complete: false, diagnostics };
    } catch (error) {
      diagnostics.push(`pull request response is invalid: ${error.message}`);
      return { complete: false, diagnostics };
    }
  }

  const detail = commandFailure(pullRequest);
  const noPullRequest = /no pull requests found|could not resolve to a pullrequest/i.test(detail);
  const fallback = fallbackBase(root);
  if (fallback === undefined) {
    diagnostics.push(
      noPullRequest
        ? 'no pull request or validated remote default base is available'
        : `pull request lookup failed and no validated fallback is available: ${detail}`,
    );
    return { complete: false, diagnostics };
  }

  if (!noPullRequest) {
    diagnostics.push(`pull request lookup failed; remote default is not authoritative: ${detail}`);
    return {
      complete: false,
      diagnostics,
      oid: fallback.oid,
      source: `unverified-${fallback.source}`,
    };
  }
  return { complete: true, diagnostics, oid: fallback.oid, source: fallback.source };
}

function boundedPatch(result, label, source) {
  if (result.status !== 0 || result.stdout === null || result.error !== undefined) {
    source.complete = false;
    source.diagnostics.push(`${label}: ${commandFailure(result)}`);
    return '';
  }
  if (result.stdout.length > MAX_PATCH_BYTES) {
    source.complete = false;
    source.diagnostics.push(`${label} exceeds ${MAX_PATCH_BYTES} bytes`);
    return '';
  }
  try {
    return decodeUtf8(result.stdout, label);
  } catch (error) {
    source.complete = false;
    source.diagnostics.push(error.message);
    return '';
  }
}

function verificationPatch(root, args, label) {
  const result = runGit(root, args);
  if (
    result.status !== 0 ||
    result.stdout === null ||
    result.error !== undefined ||
    result.stdout.length > MAX_PATCH_BYTES
  ) {
    return undefined;
  }
  try {
    return decodeUtf8(result.stdout, label);
  } catch {
    return undefined;
  }
}

function readUntracked(root, relativePath, workspace, byteState, markSymlinks = true) {
  const record = { path: relativePath };
  const nativePath = path.resolve(root, relativePath);
  if (!isContained(root, nativePath) || nativePath === root) {
    workspace.complete = false;
    workspace.diagnostics.push(`untracked path escapes the repository: ${relativePath}`);
    return { ...record, kind: 'unreadable' };
  }

  try {
    const stat = lstatSync(nativePath);
    if (stat.isSymbolicLink()) {
      if (markSymlinks) markChangedSymlinkIncomplete(workspace, relativePath);
      return {
        ...record,
        kind: 'symlink',
        target: decodeUtf8(
          readlinkSync(nativePath, { encoding: 'buffer' }),
          `untracked symbolic link ${relativePath}`,
        ),
      };
    }
    if (!stat.isFile()) {
      workspace.complete = false;
      workspace.diagnostics.push(`untracked path is not a regular file: ${relativePath}`);
      return { ...record, kind: 'unreadable' };
    }

    const canonicalPath = realpathSync(nativePath);
    if (!isContained(root, canonicalPath)) {
      workspace.complete = false;
      workspace.diagnostics.push(`untracked file resolves outside the repository: ${relativePath}`);
      return { ...record, kind: 'unreadable' };
    }
    const maximumBytes = Math.min(
      MAX_UNTRACKED_FILE_BYTES,
      MAX_UNTRACKED_TOTAL_BYTES - byteState.total,
    );
    const bounded = readBoundedRegularFile(canonicalPath, Math.max(0, maximumBytes));
    if (bounded.buffer === undefined) {
      workspace.complete = false;
      workspace.diagnostics.push(`untracked file is too large to review: ${relativePath}`);
      return { ...record, kind: 'omitted', size: bounded.omittedSize };
    }

    const content = bounded.buffer;
    byteState.total += content.length;
    const sha256 = createHash('sha256').update(content).digest('hex');
    try {
      return {
        ...record,
        kind: 'text',
        content: decodeUtf8(content, `untracked file ${relativePath}`),
        sha256,
      };
    } catch {
      workspace.complete = false;
      workspace.diagnostics.push(
        `untracked file is binary and cannot be reviewed: ${relativePath}`,
      );
      return { ...record, kind: 'binary', size: content.length, sha256 };
    }
  } catch (error) {
    workspace.complete = false;
    workspace.diagnostics.push(`cannot read untracked path ${relativePath}: ${error.message}`);
    return { ...record, kind: 'unreadable' };
  }
}

function incompleteSource(message, workspace = false) {
  const source = {
    complete: false,
    diagnostics: [message],
    changedPaths: [],
    files: [],
    instructions: { complete: false, diagnostics: [message], files: [] },
  };
  if (workspace) {
    return {
      ...source,
      trackedPatch: '',
      stagedPatch: '',
      unstagedPatch: '',
      untracked: [],
      indexFiles: [],
    };
  }
  return { ...source, baseOid: null, baseSource: null, patch: '' };
}

function writeOutput(output) {
  let serialized = JSON.stringify(output);
  if (Buffer.byteLength(serialized) > MAX_SERIALIZED_OUTPUT_BYTES) {
    const message = `prepared review input exceeds ${MAX_SERIALIZED_OUTPUT_BYTES} serialized bytes`;
    serialized = JSON.stringify({
      schemaVersion: 1,
      complete: false,
      fatal: message,
      committed: incompleteSource(message),
      workspace: incompleteSource(message, true),
    });
  }
  const transportLines = [OUTPUT_MARKER];
  let chunk = '';
  for (const character of serialized) {
    if (chunk !== '' && chunk.length + character.length > TRANSPORT_CHUNK_CHARACTERS) {
      transportLines.push(`${TRANSPORT_CHUNK_PREFIX}${chunk}`);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk !== '') transportLines.push(`${TRANSPORT_CHUNK_PREFIX}${chunk}`);
  transportLines.push(TRANSPORT_END_MARKER);
  process.stdout.write(`${transportLines.join('\n')}\n`);
}

function main() {
  if (process.platform === 'win32') {
    throw new Error('the pre-push reviewer does not support native Windows sessions');
  }
  collectionDeadline = Date.now() + COLLECTION_TIMEOUT_MS;
  const initialCwd = realpathSync(process.cwd());
  const repositoryEnvelope = discoverRepositoryEnvelope(initialCwd);
  trustedExecutables.set('git', resolveTrustedExecutable('git', repositoryEnvelope));
  const rootResult = runGit(initialCwd, ['rev-parse', '--show-toplevel']);
  const rootText = requireSuccess(rootResult, 'repository root').trim();
  const root = realpathSync(rootText);
  if (root !== repositoryEnvelope && !isContained(repositoryEnvelope, root)) {
    throw new Error('Git resolved a repository root outside the discovered .git boundary');
  }
  trustedExecutables.set('gh', resolveTrustedExecutable('gh', repositoryEnvelope));
  const branch = requireSuccess(
    runGit(root, ['branch', '--show-current']),
    'current branch',
  ).trim();
  const headBefore = requireSuccess(
    runGit(root, ['rev-parse', '--verify', 'HEAD^{commit}']),
    'HEAD',
  ).trim();

  const committed = {
    complete: true,
    diagnostics: [],
    baseOid: null,
    baseSource: null,
    patch: '',
    changedPaths: [],
    files: [],
    instructions: { complete: true, diagnostics: [], files: [] },
  };
  const base = resolveBase(root);
  committed.complete = base.complete;
  committed.diagnostics.push(...base.diagnostics);
  if (base.oid !== undefined) {
    committed.baseOid = base.oid;
    committed.baseSource = base.source;
    committed.patch = boundedPatch(
      runGit(root, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--binary',
        `${base.oid}...${headBefore}`,
        '--',
      ]),
      'committed patch',
      committed,
    );
    committed.changedPaths = boundedPathList(
      runGit(root, [
        'diff',
        '--name-only',
        '-z',
        '--no-renames',
        `${base.oid}...${headBefore}`,
        '--',
      ]),
      'committed changed paths',
      committed,
    );
  }
  committed.files = captureHeadFiles(root, headBefore, committed.changedPaths, committed);
  committed.instructions = collectHeadInstructions({
    root,
    headOid: headBefore,
    changedPaths: committed.changedPaths,
    runGit,
    commandFailure,
  });
  if (!committed.instructions.complete) committed.complete = false;
  const committedInstructionPaths = new Set(
    committed.instructions.files.flatMap((record) => [record.path, record.canonicalPath]),
  );
  const changedCommittedInstructions = committed.changedPaths.filter(
    (changedPath) =>
      committedInstructionPaths.has(changedPath) || isStandardInstructionPath(changedPath),
  );
  if (changedCommittedInstructions.length > 0) {
    committed.complete = false;
    committed.diagnostics.push(
      `committed changes governing instructions: ${changedCommittedInstructions.join(', ')}`,
    );
  }

  const workspace = {
    complete: true,
    diagnostics: [],
    trackedPatch: '',
    stagedPatch: '',
    unstagedPatch: '',
    untracked: [],
    changedPaths: [],
    files: [],
    indexFiles: [],
    instructions: { complete: true, diagnostics: [], files: [] },
  };
  const statusBefore = runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (
    statusBefore.status !== 0 ||
    statusBefore.stdout === null ||
    statusBefore.error !== undefined
  ) {
    workspace.complete = false;
    workspace.diagnostics.push(`initial workspace status: ${commandFailure(statusBefore)}`);
  }
  workspace.trackedPatch = boundedPatch(
    runGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', headBefore, '--']),
    'tracked workspace patch',
    workspace,
  );
  workspace.stagedPatch = boundedPatch(
    runGit(root, [
      'diff',
      '--cached',
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      headBefore,
      '--',
    ]),
    'staged workspace patch',
    workspace,
  );
  workspace.unstagedPatch = boundedPatch(
    runGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--']),
    'unstaged workspace patch',
    workspace,
  );
  const stagedPaths = boundedPathList(
    runGit(root, ['diff', '--cached', '--name-only', '-z', '--no-renames', headBefore, '--']),
    'staged workspace paths',
    workspace,
  );
  const unstagedPaths = boundedPathList(
    runGit(root, ['diff', '--name-only', '-z', '--no-renames', '--']),
    'unstaged workspace paths',
    workspace,
  );
  const untrackedResult = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z', '--']);
  let untrackedNames = [];
  if (
    untrackedResult.status !== 0 ||
    untrackedResult.stdout === null ||
    untrackedResult.error !== undefined
  ) {
    workspace.complete = false;
    workspace.diagnostics.push(`untracked inventory: ${commandFailure(untrackedResult)}`);
  } else {
    try {
      const names = splitNullDelimited(untrackedResult.stdout, 'untracked path');
      if (names.length > MAX_UNTRACKED_FILES) {
        workspace.complete = false;
        workspace.diagnostics.push(`untracked inventory exceeds ${MAX_UNTRACKED_FILES} files`);
      }
      untrackedNames = names.slice(0, MAX_UNTRACKED_FILES);
      const byteState = { total: 0 };
      workspace.untracked = untrackedNames.map((name) =>
        readUntracked(root, name, workspace, byteState),
      );
    } catch (error) {
      workspace.complete = false;
      workspace.diagnostics.push(error.message);
    }
  }
  workspace.changedPaths = [...new Set([...stagedPaths, ...unstagedPaths, ...untrackedNames])];
  if (workspace.changedPaths.length > MAX_CHANGED_PATHS) {
    workspace.complete = false;
    workspace.diagnostics.push(`workspace changed paths exceed ${MAX_CHANGED_PATHS} paths`);
    workspace.changedPaths = workspace.changedPaths.slice(0, MAX_CHANGED_PATHS);
  }
  const trackedWorkspacePaths = [...new Set([...stagedPaths, ...unstagedPaths])];
  workspace.files = captureWorkspaceFiles(root, trackedWorkspacePaths, workspace);
  workspace.indexFiles = captureIndexFiles(root, stagedPaths, workspace);

  const allowedResult = runGit(root, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
  ]);
  const allowedPaths = new Set(
    boundedPathList(
      allowedResult,
      'shared repository path inventory',
      workspace,
      MAX_REPOSITORY_PATHS,
    ),
  );
  workspace.instructions = collectWorkspaceInstructions({
    root,
    changedPaths: workspace.changedPaths,
    allowedPaths,
  });
  if (!workspace.instructions.complete) workspace.complete = false;
  const instructionPaths = new Set(
    [...committed.instructions.files, ...workspace.instructions.files].flatMap((record) => [
      record.path,
      record.canonicalPath,
    ]),
  );
  const changedInstructions = workspace.changedPaths.filter(
    (changedPath) => instructionPaths.has(changedPath) || isStandardInstructionPath(changedPath),
  );
  if (changedInstructions.length > 0) {
    workspace.complete = false;
    workspace.diagnostics.push(
      `workspace changes governing instructions: ${changedInstructions.join(', ')}`,
    );
  }

  pauseForRaceTest();

  const statusAfter = runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (
    statusBefore.stdout === null ||
    statusAfter.stdout === null ||
    statusAfter.status !== 0 ||
    statusAfter.error !== undefined ||
    !statusBefore.stdout.equals(statusAfter.stdout)
  ) {
    workspace.complete = false;
    workspace.diagnostics.push('workspace changed while review input was collected');
  }
  const trackedAfterText = verificationPatch(
    root,
    ['diff', '--no-ext-diff', '--no-textconv', '--binary', headBefore, '--'],
    'tracked workspace verification',
  );
  const stagedAfterText = verificationPatch(
    root,
    ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', headBefore, '--'],
    'staged workspace verification',
  );
  const unstagedAfterText = verificationPatch(
    root,
    ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--'],
    'unstaged workspace verification',
  );
  if (
    trackedAfterText !== workspace.trackedPatch ||
    stagedAfterText !== workspace.stagedPatch ||
    unstagedAfterText !== workspace.unstagedPatch
  ) {
    workspace.complete = false;
    workspace.diagnostics.push('tracked workspace content changed during collection');
  }

  const untrackedAfter = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z', '--']);
  const verificationSource = { complete: true, diagnostics: [] };
  let untrackedAfterNames = [];
  if (
    untrackedAfter.status === 0 &&
    untrackedAfter.stdout !== null &&
    untrackedAfter.error === undefined
  ) {
    try {
      untrackedAfterNames = splitNullDelimited(untrackedAfter.stdout, 'verified untracked path');
    } catch {
      verificationSource.complete = false;
    }
  } else {
    verificationSource.complete = false;
  }
  let untrackedAfterRecords = [];
  if (untrackedAfterNames.length <= MAX_UNTRACKED_FILES) {
    const verificationBytes = { total: 0 };
    untrackedAfterRecords = untrackedAfterNames.map((name) =>
      readUntracked(root, name, verificationSource, verificationBytes, false),
    );
  } else {
    verificationSource.complete = false;
  }
  if (
    !verificationSource.complete ||
    untrackedFingerprint(untrackedAfterRecords) !== untrackedFingerprint(workspace.untracked)
  ) {
    workspace.complete = false;
    workspace.diagnostics.push('untracked workspace content changed during collection');
  }

  const emittedStateVerification = { complete: true, diagnostics: [] };
  const workspaceFilesAfter = captureWorkspaceFiles(
    root,
    trackedWorkspacePaths,
    emittedStateVerification,
    false,
  );
  const indexFilesAfter = captureIndexFiles(root, stagedPaths, emittedStateVerification, false);
  if (
    !emittedStateVerification.complete ||
    fileStateFingerprint(workspaceFilesAfter) !== fileStateFingerprint(workspace.files) ||
    fileStateFingerprint(indexFilesAfter) !== fileStateFingerprint(workspace.indexFiles)
  ) {
    workspace.complete = false;
    workspace.diagnostics.push('emitted workspace file state changed during collection');
  }

  const allowedAfterResult = runGit(root, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
  ]);
  const instructionVerification = { complete: true, diagnostics: [] };
  const allowedAfterPaths = new Set(
    boundedPathList(
      allowedAfterResult,
      'verified shared repository path inventory',
      instructionVerification,
      MAX_REPOSITORY_PATHS,
    ),
  );
  const workspaceInstructionsAfter = collectWorkspaceInstructions({
    root,
    changedPaths: workspace.changedPaths,
    allowedPaths: allowedAfterPaths,
  });
  if (
    !instructionVerification.complete ||
    [...allowedAfterPaths].toSorted((left, right) => left.localeCompare(right)).join('\0') !==
      [...allowedPaths].toSorted((left, right) => left.localeCompare(right)).join('\0') ||
    instructionFingerprint(workspaceInstructionsAfter) !==
      instructionFingerprint(workspace.instructions)
  ) {
    workspace.complete = false;
    workspace.diagnostics.push('workspace instruction state changed during collection');
  }

  const headAfter = runGit(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (
    headAfter.status !== 0 ||
    headAfter.stdout === null ||
    headAfter.error !== undefined ||
    headAfter.stdout.toString('utf8').trim() !== headBefore
  ) {
    committed.complete = false;
    workspace.complete = false;
    committed.diagnostics.push('HEAD changed while review input was collected');
  }
  const branchAfter = runGit(root, ['branch', '--show-current']);
  if (
    branchAfter.status !== 0 ||
    branchAfter.stdout === null ||
    branchAfter.error !== undefined ||
    branchAfter.stdout.toString('utf8').trim() !== branch
  ) {
    committed.complete = false;
    workspace.complete = false;
    committed.diagnostics.push('branch changed while review input was collected');
  }

  const output = {
    schemaVersion: 1,
    complete: committed.complete && workspace.complete,
    repositoryRoot: root,
    branch,
    headOid: headBefore,
    committed,
    workspace,
  };
  writeOutput(output);
}

try {
  main();
} catch (error) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  writeOutput({
    schemaVersion: 1,
    complete: false,
    fatal: message,
    committed: incompleteSource(message),
    workspace: incompleteSource(message, true),
  });
}
