'use strict';

const {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} = require('node:fs');
const path = require('node:path');

const MAX_INSTRUCTION_FILES = 256;
const MAX_INSTRUCTION_FILE_BYTES = 256 * 1024;
const MAX_INSTRUCTION_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_DEPTH = 4;
const MAX_IMPORT_EDGES = 512;
const MAX_RULE_DIRECTORY_ENTRIES = 4_096;

const RULE_DIRECTORIES = [
  { suffix: '.claude/rules', extension: '.md', category: 'claude-rule' },
  { suffix: '.cursor/rules', extension: '.mdc', category: 'cursor-rule' },
  { suffix: '.agents/rules', extension: '.md', category: 'agent-rule' },
];

function decodeUtf8(buffer, label) {
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) {
    throw new Error(`${label} is not valid UTF-8`);
  }
  return text;
}

function splitNullDelimitedBuffers(buffer, label) {
  const values = [];
  let start = 0;
  for (;;) {
    const end = buffer.indexOf(0, start);
    if (end === -1) break;
    if (end > start) values.push(buffer.subarray(start, end));
    start = end + 1;
  }
  if (start !== buffer.length) throw new Error(`${label} is not NUL terminated`);
  return values;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizeRepoPath(candidate) {
  if (typeof candidate !== 'string' || candidate.includes('\0')) return undefined;
  if (
    path.posix.isAbsolute(candidate) ||
    (process.platform === 'win32' && path.win32.isAbsolute(candidate))
  )
    return undefined;
  const normalized = path.posix.normalize(candidate);
  if (normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized === '.' ? '' : normalized.replace(/^\.\//, '');
}

function repoJoin(...parts) {
  return parts.filter(Boolean).join('/');
}

function isExcludedLocalMemory(logicalPath) {
  return path.posix.basename(logicalPath) === 'CLAUDE.local.md';
}

function ancestryDirectories(changedPath) {
  const normalized = normalizeRepoPath(changedPath);
  if (normalized === undefined) return [];
  const directories = [];
  let directory = path.posix.dirname(normalized);
  if (directory === '.') directory = '';
  for (;;) {
    directories.push(directory);
    if (directory === '') break;
    const parent = path.posix.dirname(directory);
    directory = parent === '.' ? '' : parent;
  }
  return directories;
}

function newSnapshot() {
  return {
    complete: true,
    diagnostics: [],
    files: [],
    fileMap: new Map(),
    totalBytes: 0,
  };
}

function addDiagnostic(snapshot, message) {
  snapshot.complete = false;
  if (!snapshot.diagnostics.includes(message)) snapshot.diagnostics.push(message);
}

function addFile(snapshot, record) {
  const existing = snapshot.fileMap.get(record.path);
  if (existing !== undefined) {
    if (existing.canonicalPath !== record.canonicalPath || existing.content !== record.content) {
      addDiagnostic(snapshot, `instruction changed while it was collected: ${record.path}`);
    }
    const existingRoute = existing.routes.find((route) => route.category === record.category);
    if (existingRoute === undefined) {
      existing.routes.push({
        category: record.category,
        appliesTo: [...new Set(record.appliesTo)].toSorted((left, right) =>
          left.localeCompare(right),
        ),
      });
      existing.routes.sort((left, right) => left.category.localeCompare(right.category));
    } else {
      existingRoute.appliesTo = [
        ...new Set([...existingRoute.appliesTo, ...record.appliesTo]),
      ].toSorted((left, right) => left.localeCompare(right));
    }
    return existing;
  }
  if (snapshot.files.length >= MAX_INSTRUCTION_FILES) {
    addDiagnostic(snapshot, `instruction inventory exceeds ${MAX_INSTRUCTION_FILES} files`);
    return undefined;
  }
  const byteLength = Buffer.byteLength(record.content);
  if (
    byteLength > MAX_INSTRUCTION_FILE_BYTES ||
    snapshot.totalBytes + byteLength > MAX_INSTRUCTION_TOTAL_BYTES
  ) {
    addDiagnostic(snapshot, `instruction content is too large to review: ${record.path}`);
    return undefined;
  }
  const stored = {
    path: record.path,
    canonicalPath: record.canonicalPath,
    routes: [
      {
        category: record.category,
        appliesTo: [...new Set(record.appliesTo)].toSorted((left, right) =>
          left.localeCompare(right),
        ),
      },
    ],
    content: record.content,
  };
  snapshot.totalBytes += byteLength;
  snapshot.files.push(stored);
  snapshot.fileMap.set(record.path, stored);
  return stored;
}

function routeResult(record, category, appliesTo) {
  return {
    record,
    route: {
      category,
      appliesTo: [...new Set(appliesTo)].toSorted((left, right) => left.localeCompare(right)),
    },
  };
}

function readBoundedFile(filePath, maximumBytes) {
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

function stripCode(line) {
  const runs = [];
  for (let index = 0; index < line.length;) {
    const start = line.indexOf('`', index);
    if (start === -1) break;
    let end = start + 1;
    while (line[end] === '`') end += 1;
    let backslashes = 0;
    for (let cursor = start - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) {
      backslashes += 1;
    }
    runs.push({ start, end, length: end - start, escaped: backslashes % 2 === 1 });
    index = end;
  }

  const nextSameLength = Array.from({ length: runs.length });
  const nextByLength = new Map();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    nextSameLength[index] = nextByLength.get(run.length);
    nextByLength.set(run.length, index);
  }

  let result = '';
  let cursor = 0;
  for (let index = 0; index < runs.length;) {
    const opening = runs[index];
    result += line.slice(cursor, opening.start);
    const closeIndex = nextSameLength[index];
    if (opening.escaped || closeIndex === undefined) {
      result += line.slice(opening.start, opening.end);
      cursor = opening.end;
      index += 1;
      continue;
    }
    const closing = runs[closeIndex];
    result += ' '.repeat(closing.end - opening.start);
    cursor = closing.end;
    index = closeIndex + 1;
  }
  result += line.slice(cursor);
  return result;
}

function hasContainerFence(line) {
  const marker = /`{3,}|~{3,}/.exec(line);
  if (marker === null) return false;
  const prefix = line.slice(0, marker.index);
  return (
    /(?:^|[ \t])>[ \t]*$/.test(prefix) || /(?:^|[ \t])(?:[-+*]|\d{1,9}[.)])[ \t]+$/.test(prefix)
  );
}

function extractImports(content) {
  let unsupportedContainerFence = false;
  let unsupportedIndentedConstruct = false;
  let fence;
  let indentedCode = false;
  let previousBlank = true;
  const visibleLines = [];
  for (const line of content.split(/\r?\n/)) {
    const blank = /^[ \t]*$/.test(line);
    if (fence === undefined && indentedCode) {
      if (blank || /^(?: {4}|\t)/.test(line)) {
        visibleLines.push(' '.repeat(line.length));
        previousBlank = blank;
        continue;
      }
      indentedCode = false;
    }
    if (fence === undefined && /^(?: {4}|\t)/.test(line)) {
      if (previousBlank) {
        indentedCode = true;
        visibleLines.push(' '.repeat(line.length));
        previousBlank = blank;
        continue;
      }
      if (/(?:`{3,}|~{3,}|@)/.test(line)) unsupportedIndentedConstruct = true;
    }
    const fenceMatch = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch === null && hasContainerFence(line)) unsupportedContainerFence = true;
    if (fenceMatch !== null) {
      const marker = fenceMatch[2];
      const remainder = fenceMatch[3];
      if (fence === undefined) {
        if (marker[0] === '~' || !remainder.includes('`')) {
          fence = { character: marker[0], length: marker.length };
          visibleLines.push(' '.repeat(line.length));
          previousBlank = blank;
          continue;
        }
      } else if (
        marker[0] === fence.character &&
        marker.length >= fence.length &&
        /^[ \t]*$/.test(remainder)
      ) {
        fence = undefined;
        visibleLines.push(' '.repeat(line.length));
        previousBlank = blank;
        continue;
      }
    }
    visibleLines.push(fence === undefined ? line : ' '.repeat(line.length));
    previousBlank = blank;
  }
  const visible = stripCode(visibleLines.join('\n'));
  const imports = [];
  const pattern = /(?:^|[\s(])@([^\s`]+)/g;
  for (let match = pattern.exec(visible); match !== null; match = pattern.exec(visible)) {
    const target = match[1].replace(/[),.;:!?]+$/, '');
    if (target !== '') imports.push(target);
  }
  return { imports, unsupportedContainerFence, unsupportedIndentedConstruct };
}

function resolveImportPath(root, importerPath, target) {
  if (target.startsWith('~')) return undefined;
  if (path.isAbsolute(target)) {
    const absolute = path.resolve(target);
    if (!isContained(root, absolute)) return undefined;
    return normalizeRepoPath(path.relative(root, absolute).split(path.sep).join('/'));
  }
  if (process.platform === 'win32' && path.win32.isAbsolute(target)) return undefined;
  return normalizeRepoPath(path.posix.join(path.posix.dirname(importerPath), target));
}

function initialCandidates(changedPaths) {
  const direct = new Map();
  const ruleDirectories = new Map();

  function addDirect(logicalPath, category, changedPath) {
    const key = `${category}\0${logicalPath}`;
    const candidate = direct.get(key) ?? { logicalPath, category, appliesTo: new Set() };
    candidate.appliesTo.add(changedPath);
    direct.set(key, candidate);
  }

  for (const changedPath of changedPaths) {
    for (const directory of ancestryDirectories(changedPath)) {
      addDirect(repoJoin(directory, 'AGENTS.md'), 'agents-memory', changedPath);
      addDirect(repoJoin(directory, 'CLAUDE.md'), 'claude-memory', changedPath);
      for (const rule of RULE_DIRECTORIES) {
        const prefix = repoJoin(directory, rule.suffix);
        const key = `${rule.category}\0${prefix}`;
        const candidate = ruleDirectories.get(key) ?? {
          ...rule,
          prefix,
          appliesTo: new Set(),
        };
        candidate.appliesTo.add(changedPath);
        ruleDirectories.set(key, candidate);
      }
    }
  }
  for (const changedPath of changedPaths) {
    addDirect('.claude/CLAUDE.md', 'claude-memory', changedPath);
  }
  return { direct: [...direct.values()], ruleDirectories: [...ruleDirectories.values()] };
}

function expandImports({ root, snapshot, readCandidate }) {
  const budget = { edges: 0 };

  function visit(record, route, depth, chain) {
    const extracted = extractImports(record.content);
    if (extracted.unsupportedContainerFence) {
      addDiagnostic(
        snapshot,
        `Claude instruction has an unsupported container fence: ${record.path}`,
      );
    }
    if (extracted.unsupportedIndentedConstruct) {
      addDiagnostic(
        snapshot,
        `Claude instruction has an unsupported indented construct: ${record.path}`,
      );
    }
    const imports = extracted.imports;
    if (imports.length === 0) return;
    if (depth >= MAX_IMPORT_DEPTH) {
      addDiagnostic(snapshot, `Claude import depth exceeds ${MAX_IMPORT_DEPTH}: ${record.path}`);
      return;
    }
    for (const target of imports) {
      budget.edges += 1;
      if (budget.edges > MAX_IMPORT_EDGES) {
        addDiagnostic(snapshot, `Claude import graph exceeds ${MAX_IMPORT_EDGES} edges`);
        return;
      }
      const logicalPath = resolveImportPath(root, record.path, target);
      if (logicalPath === undefined) {
        addDiagnostic(snapshot, `Claude import target is unsupported: ${record.path} -> ${target}`);
        continue;
      }
      const imported = readCandidate(logicalPath, 'claude-import', {
        required: true,
        appliesTo: route.appliesTo,
      });
      if (imported === undefined || chain.has(imported.record.canonicalPath)) continue;
      visit(
        imported.record,
        imported.route,
        depth + 1,
        new Set([...chain, imported.record.canonicalPath]),
      );
    }
  }

  for (const record of snapshot.files.slice()) {
    for (const route of record.routes.filter(
      (candidate) => candidate.category === 'claude-memory',
    )) {
      visit(record, route, 0, new Set([record.canonicalPath]));
    }
  }
}

function flagUnsupportedCursorReferences(snapshot) {
  for (const record of snapshot.files) {
    if (!record.routes.some((route) => route.category === 'cursor-rule')) continue;
    const extracted = extractImports(record.content);
    if (extracted.unsupportedContainerFence) {
      addDiagnostic(snapshot, `Cursor rule has an unsupported container fence: ${record.path}`);
    }
    if (extracted.unsupportedIndentedConstruct) {
      addDiagnostic(snapshot, `Cursor rule has an unsupported indented construct: ${record.path}`);
    }
    for (const target of extracted.imports) {
      addDiagnostic(snapshot, `Cursor file reference is unsupported: ${record.path} -> ${target}`);
    }
  }
}

function collectWorkspaceInstructions({ root, changedPaths, allowedPaths }) {
  const snapshot = newSnapshot();
  const allowedDirectories = new Set(['']);
  for (const allowedPath of allowedPaths) {
    const normalized = normalizeRepoPath(allowedPath);
    if (normalized === undefined) continue;
    let directory = path.posix.dirname(normalized);
    if (directory === '.') directory = '';
    for (;;) {
      allowedDirectories.add(directory);
      if (directory === '') break;
      const parent = path.posix.dirname(directory);
      directory = parent === '.' ? '' : parent;
    }
  }
  const traversalBudget = { entries: 0 };

  for (const changedPath of changedPaths) {
    if (normalizeRepoPath(changedPath) === undefined) {
      addDiagnostic(snapshot, `changed path cannot be resolved safely: ${changedPath}`);
    }
  }

  function readCandidate(
    logicalPath,
    category,
    { required = false, throughDirectoryLink = false, appliesTo = [] } = {},
  ) {
    const normalized = normalizeRepoPath(logicalPath);
    if (normalized === undefined) {
      if (required)
        addDiagnostic(snapshot, `instruction path escapes the repository: ${logicalPath}`);
      return undefined;
    }
    if (category === 'claude-import' && isExcludedLocalMemory(normalized)) return undefined;
    const logicalIsShared = allowedPaths.has(normalized);
    if (!logicalIsShared && !throughDirectoryLink) {
      if (required) addDiagnostic(snapshot, `instruction path is not shared: ${normalized}`);
      return undefined;
    }
    const existing = snapshot.fileMap.get(normalized);
    if (existing !== undefined) {
      if (category === 'claude-import' && isExcludedLocalMemory(existing.canonicalPath)) {
        return undefined;
      }
      const stored = addFile(snapshot, {
        path: existing.path,
        canonicalPath: existing.canonicalPath,
        category,
        appliesTo,
        content: existing.content,
      });
      return stored === undefined ? undefined : routeResult(stored, category, appliesTo);
    }
    const nativePath = path.resolve(root, normalized);
    let canonicalPath;
    let content;
    try {
      const entry = lstatSync(nativePath);
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        if (required) addDiagnostic(snapshot, `instruction is not a file: ${normalized}`);
        return undefined;
      }
      const canonicalNative = realpathSync(nativePath);
      if (!isContained(root, canonicalNative)) {
        addDiagnostic(snapshot, `instruction target leaves the repository: ${normalized}`);
        return undefined;
      }
      if (!statSync(canonicalNative).isFile()) {
        addDiagnostic(snapshot, `instruction target is not a file: ${normalized}`);
        return undefined;
      }
      canonicalPath = path.relative(root, canonicalNative).split(path.sep).join('/');
      if (category === 'claude-import' && isExcludedLocalMemory(canonicalPath)) return undefined;
      if (!allowedPaths.has(canonicalPath)) {
        addDiagnostic(snapshot, `instruction target is not shared: ${normalized}`);
        return undefined;
      }
      const remainingBytes = Math.min(
        MAX_INSTRUCTION_FILE_BYTES,
        MAX_INSTRUCTION_TOTAL_BYTES - snapshot.totalBytes,
      );
      const bounded = readBoundedFile(canonicalNative, Math.max(0, remainingBytes));
      if (bounded.buffer === undefined) {
        addDiagnostic(
          snapshot,
          `instruction content is too large to review: ${normalized} (${bounded.omittedSize} bytes)`,
        );
        return undefined;
      }
      content = decodeUtf8(bounded.buffer, `instruction ${normalized}`);
    } catch (error) {
      if (logicalIsShared || throughDirectoryLink || required) {
        addDiagnostic(snapshot, `cannot read instruction ${normalized}: ${error.message}`);
      }
      return undefined;
    }
    const stored = addFile(snapshot, {
      path: normalized,
      canonicalPath,
      category,
      appliesTo,
      content,
    });
    if (stored === undefined) return undefined;
    return routeResult(stored, category, appliesTo);
  }

  function scanRuleDirectory(
    logicalDirectory,
    extension,
    category,
    chain = new Set(),
    throughDirectoryLink = false,
    appliesTo = [],
  ) {
    const normalized = normalizeRepoPath(logicalDirectory);
    if (normalized === undefined) return;
    if (
      !throughDirectoryLink &&
      !allowedPaths.has(normalized) &&
      !allowedDirectories.has(normalized)
    )
      return;
    const nativeDirectory = path.resolve(root, normalized);
    let canonicalDirectory;
    let directoryEntry;
    try {
      directoryEntry = lstatSync(nativeDirectory);
      if (directoryEntry.isSymbolicLink() && !allowedPaths.has(normalized)) return;
      canonicalDirectory = realpathSync(nativeDirectory);
      if (!isContained(root, canonicalDirectory)) {
        addDiagnostic(snapshot, `rule directory leaves the repository: ${normalized}`);
        return;
      }
      if (!statSync(canonicalDirectory).isDirectory()) return;
    } catch (error) {
      if (
        error?.code !== 'ENOENT' ||
        directoryEntry?.isSymbolicLink() ||
        allowedPaths.has(normalized) ||
        throughDirectoryLink
      ) {
        addDiagnostic(snapshot, `cannot inspect rule directory ${normalized}: ${error.message}`);
      }
      return;
    }
    const canonicalRepoPath = path.relative(root, canonicalDirectory).split(path.sep).join('/');
    if (!allowedPaths.has(canonicalRepoPath) && !allowedDirectories.has(canonicalRepoPath)) {
      if (directoryEntry.isSymbolicLink()) {
        addDiagnostic(snapshot, `rule directory target is not shared: ${normalized}`);
      }
      return;
    }
    const followsDirectoryLink =
      throughDirectoryLink || directoryEntry.isSymbolicLink() || canonicalRepoPath !== normalized;
    if (chain.has(canonicalDirectory)) {
      addDiagnostic(snapshot, `rule directory symbolic-link cycle: ${normalized}`);
      return;
    }
    const nextChain = new Set([...chain, canonicalDirectory]);
    const entries = [];
    let directory;
    try {
      directory = opendirSync(canonicalDirectory);
      for (;;) {
        const entry = directory.readSync();
        if (entry === null) break;
        traversalBudget.entries += 1;
        if (traversalBudget.entries > MAX_RULE_DIRECTORY_ENTRIES) {
          addDiagnostic(
            snapshot,
            `rule directory traversal exceeds ${MAX_RULE_DIRECTORY_ENTRIES} entries`,
          );
          break;
        }
        entries.push(entry);
      }
    } catch (error) {
      addDiagnostic(snapshot, `cannot list rule directory ${normalized}: ${error.message}`);
      return;
    } finally {
      directory?.closeSync();
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const displayPath = repoJoin(normalized, entry.name);
      const physicalPath = path.join(canonicalDirectory, entry.name);
      const sharedPath = followsDirectoryLink
        ? repoJoin(canonicalRepoPath, entry.name)
        : displayPath;
      if (!allowedPaths.has(sharedPath) && !allowedDirectories.has(sharedPath)) continue;
      try {
        const item = lstatSync(physicalPath);
        if (item.isDirectory()) {
          scanRuleDirectory(
            displayPath,
            extension,
            category,
            nextChain,
            followsDirectoryLink,
            appliesTo,
          );
        } else if (item.isSymbolicLink()) {
          const target = realpathSync(physicalPath);
          if (!isContained(root, target)) {
            addDiagnostic(snapshot, `rule symbolic link leaves the repository: ${displayPath}`);
          } else if (statSync(target).isDirectory()) {
            scanRuleDirectory(displayPath, extension, category, nextChain, true, appliesTo);
          } else if (displayPath.endsWith(extension)) {
            readCandidate(displayPath, category, {
              required: true,
              throughDirectoryLink: followsDirectoryLink,
              appliesTo,
            });
          }
        } else if (item.isFile() && displayPath.endsWith(extension)) {
          readCandidate(displayPath, category, {
            required: true,
            throughDirectoryLink: followsDirectoryLink,
            appliesTo,
          });
        }
      } catch (error) {
        addDiagnostic(snapshot, `cannot inspect rule path ${displayPath}: ${error.message}`);
      }
    }
  }

  const candidates = initialCandidates(changedPaths);
  for (const candidate of candidates.direct) {
    readCandidate(candidate.logicalPath, candidate.category, {
      appliesTo: [...candidate.appliesTo],
    });
  }
  for (const rule of candidates.ruleDirectories) {
    scanRuleDirectory(rule.prefix, rule.extension, rule.category, new Set(), false, [
      ...rule.appliesTo,
    ]);
  }
  expandImports({ root, snapshot, readCandidate });
  flagUnsupportedCursorReferences(snapshot);

  delete snapshot.fileMap;
  delete snapshot.totalBytes;
  return snapshot;
}

function collectHeadInstructions({ root, headOid, changedPaths, runGit, commandFailure }) {
  const snapshot = newSnapshot();
  const tree = new Map();
  const treeChildren = new Map();
  const traversalBudget = { entries: 0 };
  for (const changedPath of changedPaths) {
    if (normalizeRepoPath(changedPath) === undefined) {
      addDiagnostic(snapshot, `changed path cannot be resolved safely: ${changedPath}`);
    }
  }
  const treeResult = runGit(root, ['ls-tree', '-r', '-z', '--full-tree', headOid, '--']);
  if (treeResult.status !== 0 || treeResult.stdout === null || treeResult.error !== undefined) {
    addDiagnostic(snapshot, `cannot read HEAD instruction tree: ${commandFailure(treeResult)}`);
  } else {
    try {
      for (const rawRecord of splitNullDelimitedBuffers(treeResult.stdout, 'HEAD tree')) {
        const tab = rawRecord.indexOf(9);
        if (tab === -1) throw new Error('HEAD tree entry has no path separator');
        const metadata = rawRecord.subarray(0, tab).toString('ascii').split(' ');
        const logicalPath = decodeUtf8(rawRecord.subarray(tab + 1), 'HEAD tree path');
        const [mode, type, oid] = metadata;
        if (!/^[0-9a-f]{40,64}$/i.test(oid ?? ''))
          throw new Error('HEAD tree entry has invalid OID');
        tree.set(logicalPath, { mode, type, oid });
        const segments = logicalPath.split('/');
        for (let index = 0; index < segments.length; index += 1) {
          const parent = segments.slice(0, index).join('/');
          const children = treeChildren.get(parent) ?? new Set();
          children.add(segments[index]);
          treeChildren.set(parent, children);
        }
      }
    } catch (error) {
      addDiagnostic(snapshot, error.message);
    }
  }

  const blobCache = new Map();
  function readBlob(entry, label) {
    const cached = blobCache.get(entry.oid);
    if (cached !== undefined) return cached;
    const sizeResult = runGit(root, ['cat-file', '-s', entry.oid]);
    if (sizeResult.status !== 0 || sizeResult.stdout === null || sizeResult.error !== undefined) {
      throw new Error(`${label}: ${commandFailure(sizeResult)}`);
    }
    const size = Number(sizeResult.stdout.toString('ascii').trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${label}: invalid blob size`);
    if (size > MAX_INSTRUCTION_FILE_BYTES) {
      throw new Error(`${label}: content exceeds ${MAX_INSTRUCTION_FILE_BYTES} bytes`);
    }
    const result = runGit(root, ['cat-file', 'blob', entry.oid]);
    if (result.status !== 0 || result.stdout === null || result.error !== undefined) {
      throw new Error(`${label}: ${commandFailure(result)}`);
    }
    const content = decodeUtf8(result.stdout, label);
    blobCache.set(entry.oid, content);
    return content;
  }

  function resolveTreePath(logicalPath) {
    let candidate = normalizeRepoPath(logicalPath);
    if (candidate === undefined) return undefined;
    const seen = new Set();
    for (let hop = 0; hop < 32; hop += 1) {
      const segments = candidate.split('/').filter(Boolean);
      let replaced = false;
      for (let index = 0; index < segments.length; index += 1) {
        const prefix = segments.slice(0, index + 1).join('/');
        const entry = tree.get(prefix);
        if (entry?.mode !== '120000') continue;
        if (seen.has(prefix)) {
          addDiagnostic(snapshot, `instruction symbolic-link cycle: ${logicalPath}`);
          return undefined;
        }
        seen.add(prefix);
        let target;
        try {
          target = readBlob(entry, `symbolic link ${prefix}`);
        } catch (error) {
          addDiagnostic(snapshot, error.message);
          return undefined;
        }
        if (
          path.posix.isAbsolute(target) ||
          (process.platform === 'win32' && path.win32.isAbsolute(target))
        ) {
          addDiagnostic(snapshot, `instruction target leaves the repository: ${logicalPath}`);
          return undefined;
        }
        const replacement = normalizeRepoPath(
          path.posix.join(path.posix.dirname(prefix), target, ...segments.slice(index + 1)),
        );
        if (replacement === undefined) {
          addDiagnostic(snapshot, `instruction target leaves the repository: ${logicalPath}`);
          return undefined;
        }
        candidate = replacement;
        replaced = true;
        break;
      }
      if (!replaced) return candidate;
    }
    addDiagnostic(snapshot, `too many instruction symbolic links: ${logicalPath}`);
    return undefined;
  }

  function readCandidate(logicalPath, category, { required = false, appliesTo = [] } = {}) {
    const normalized = normalizeRepoPath(logicalPath);
    if (normalized === undefined) {
      if (required)
        addDiagnostic(snapshot, `instruction path escapes the repository: ${logicalPath}`);
      return undefined;
    }
    if (category === 'claude-import' && isExcludedLocalMemory(normalized)) return undefined;
    const existing = snapshot.fileMap.get(normalized);
    if (existing !== undefined) {
      if (category === 'claude-import' && isExcludedLocalMemory(existing.canonicalPath)) {
        return undefined;
      }
      const stored = addFile(snapshot, {
        path: existing.path,
        canonicalPath: existing.canonicalPath,
        category,
        appliesTo,
        content: existing.content,
      });
      return stored === undefined ? undefined : routeResult(stored, category, appliesTo);
    }
    const segments = normalized.split('/').filter(Boolean);
    const traversesSymbolicLink = segments.some((_, index) => {
      const prefix = segments.slice(0, index + 1).join('/');
      return tree.get(prefix)?.mode === '120000';
    });
    const canonicalPath = resolveTreePath(normalized);
    if (canonicalPath === undefined) return undefined;
    if (category === 'claude-import' && isExcludedLocalMemory(canonicalPath)) return undefined;
    const entry = tree.get(canonicalPath);
    if (entry === undefined) {
      if (required || traversesSymbolicLink)
        addDiagnostic(snapshot, `governing instruction is missing from HEAD: ${normalized}`);
      return undefined;
    }
    if (entry.type !== 'blob' || entry.mode === '160000') {
      if (required)
        addDiagnostic(snapshot, `governing instruction is not a HEAD file: ${normalized}`);
      return undefined;
    }
    try {
      const content = readBlob(entry, `instruction ${normalized}`);
      const stored = addFile(snapshot, {
        path: normalized,
        canonicalPath,
        category,
        appliesTo,
        content,
      });
      if (stored === undefined) return undefined;
      return routeResult(stored, category, appliesTo);
    } catch (error) {
      addDiagnostic(snapshot, error.message);
      return undefined;
    }
  }

  function childNames(physicalDirectory) {
    return [...(treeChildren.get(physicalDirectory) ?? [])].toSorted((left, right) =>
      left.localeCompare(right),
    );
  }

  function scanRuleDirectory(
    logicalDirectory,
    extension,
    category,
    chain = new Set(),
    appliesTo = [],
  ) {
    const segments = logicalDirectory.split('/').filter(Boolean);
    const traversesSymbolicLink = segments.some((_, index) => {
      const prefix = segments.slice(0, index + 1).join('/');
      return tree.get(prefix)?.mode === '120000';
    });
    const physicalDirectory = resolveTreePath(logicalDirectory);
    if (physicalDirectory === undefined) return;
    if (chain.has(physicalDirectory)) {
      addDiagnostic(snapshot, `rule directory symbolic-link cycle: ${logicalDirectory}`);
      return;
    }
    const nextChain = new Set([...chain, physicalDirectory]);
    const children = childNames(physicalDirectory);
    if (children.length === 0 && traversesSymbolicLink) {
      addDiagnostic(
        snapshot,
        `rule directory symbolic-link target is missing: ${logicalDirectory}`,
      );
      return;
    }
    for (const name of children) {
      traversalBudget.entries += 1;
      if (traversalBudget.entries > MAX_RULE_DIRECTORY_ENTRIES) {
        addDiagnostic(
          snapshot,
          `HEAD rule traversal exceeds ${MAX_RULE_DIRECTORY_ENTRIES} entries`,
        );
        return;
      }
      const displayPath = repoJoin(logicalDirectory, name);
      const physicalPath = repoJoin(physicalDirectory, name);
      const entry = tree.get(physicalPath);
      const resolved = resolveTreePath(displayPath);
      if (resolved === undefined) continue;
      const resolvedEntry = tree.get(resolved);
      if (resolvedEntry?.type === 'blob' && resolvedEntry.mode !== '120000') {
        if (displayPath.endsWith(extension)) {
          readCandidate(displayPath, category, { required: true, appliesTo });
        }
      } else if (entry?.type === 'commit' || resolvedEntry?.type === 'commit') {
        addDiagnostic(snapshot, `rule path is a submodule and cannot be reviewed: ${displayPath}`);
      } else if (childNames(resolved).length > 0) {
        scanRuleDirectory(displayPath, extension, category, nextChain, appliesTo);
      } else if (entry?.mode === '120000') {
        addDiagnostic(snapshot, `rule symbolic link target is missing: ${displayPath}`);
      }
    }
  }

  const candidates = initialCandidates(changedPaths);
  for (const candidate of candidates.direct) {
    readCandidate(candidate.logicalPath, candidate.category, {
      appliesTo: [...candidate.appliesTo],
    });
  }
  for (const rule of candidates.ruleDirectories) {
    scanRuleDirectory(rule.prefix, rule.extension, rule.category, new Set(), [...rule.appliesTo]);
  }
  expandImports({ root, snapshot, readCandidate });
  flagUnsupportedCursorReferences(snapshot);

  delete snapshot.fileMap;
  delete snapshot.totalBytes;
  return snapshot;
}

module.exports = {
  collectHeadInstructions,
  collectWorkspaceInstructions,
};
