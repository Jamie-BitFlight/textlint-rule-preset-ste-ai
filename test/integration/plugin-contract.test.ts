import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const preparerLauncherPath = join(repoRoot, 'skills/pre-push-review/scripts/prepare-review.sh');
const scratchDirs: string[] = [];

type PreparerOptions = {
  baseOid?: string;
  environment?: NodeJS.ProcessEnv;
  noPullRequest?: boolean;
  pathPrefix?: string;
};

const instructionSnapshotSchema = z.object({
  complete: z.boolean(),
  diagnostics: z.array(z.string()),
  files: z.array(
    z.object({
      path: z.string(),
      canonicalPath: z.string(),
      routes: z.array(
        z.object({
          category: z.string(),
          appliesTo: z.array(z.string()),
        }),
      ),
      content: z.string(),
    }),
  ),
});

const fileStateSchema = z.object({
  path: z.string(),
  kind: z.string(),
  content: z.string().optional(),
  target: z.string().optional(),
});

const reviewInputSchema = z.object({
  schemaVersion: z.number(),
  complete: z.boolean(),
  fatal: z.string().optional(),
  committed: z.object({
    complete: z.boolean(),
    diagnostics: z.array(z.string()),
    patch: z.string(),
    changedPaths: z.array(z.string()),
    files: z.array(fileStateSchema),
    instructions: instructionSnapshotSchema,
  }),
  workspace: z.object({
    complete: z.boolean(),
    diagnostics: z.array(z.string()),
    trackedPatch: z.string(),
    stagedPatch: z.string(),
    unstagedPatch: z.string(),
    changedPaths: z.array(z.string()),
    files: z.array(fileStateSchema),
    indexFiles: z.array(fileStateSchema),
    instructions: instructionSnapshotSchema,
    untracked: z.array(fileStateSchema),
  }),
});

type ReviewInput = z.infer<typeof reviewInputSchema>;

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

function makeScratchDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(directory);
  return directory;
}

function runChecked(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false });
  if (result.status !== 0 || result.error !== undefined || result.signal !== null) {
    throw new Error(result.stderr || result.error?.message || `${command} failed`);
  }
  return result.stdout.trim();
}

function commitAll(directory: string, message: string): string {
  runChecked('git', ['add', '--all', '--'], directory);
  runChecked('git', ['commit', '-m', message], directory);
  return runChecked('git', ['rev-parse', 'HEAD'], directory);
}

function makeRepository(): { baseOid: string; directory: string } {
  const directory = makeScratchDir('ste-ai-plugin-contract-');
  runChecked('git', ['init', '-b', 'main'], directory);
  runChecked('git', ['config', 'user.email', 'contract@example.test'], directory);
  runChecked('git', ['config', 'user.name', 'Contract Test'], directory);
  writeFileSync(join(directory, 'doc.md'), 'base\n');
  return { baseOid: commitAll(directory, 'test: base'), directory };
}

function makeFakeGh(): string {
  if (process.platform === 'win32') throw new Error('fake gh is POSIX-only');
  const binDirectory = makeScratchDir('ste-ai-fake-gh-');
  const implementation = join(binDirectory, 'fake-gh.cjs');
  writeFileSync(
    implementation,
    [
      "'use strict';",
      "const { spawnSync } = require('node:child_process');",
      "if (process.env.FAKE_GH_PROBE_GIT === '1') {",
      "  const probe = spawnSync('git', ['--version'], { shell: false });",
      '  if (probe.status !== 0 || probe.error !== undefined) process.exit(90);',
      '}',
      "if (process.env.FAKE_GH_MODE === 'none') {",
      "  process.stderr.write('no pull requests found for branch\\n');",
      '  process.exit(1);',
      '}',
      'process.stdout.write(JSON.stringify({ baseRefOid: process.env.FAKE_GH_BASE_OID }));',
      '',
    ].join('\n'),
  );
  const executable = join(binDirectory, 'gh');
  writeFileSync(executable, `#!${process.execPath}\nrequire(${JSON.stringify(implementation)});\n`);
  chmodSync(executable, 0o755);
  return binDirectory;
}

function preparerEnvironment(
  baseOid: string | undefined,
  noPullRequest: boolean,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const fakeBin = makeFakeGh();
  return {
    ...process.env,
    ...extra,
    FAKE_GH_BASE_OID: baseOid,
    FAKE_GH_MODE: noPullRequest ? 'none' : 'pull-request',
    PATH: `${fakeBin}${delimiter}${process.env['PATH'] ?? ''}`,
  };
}

function parsePreparedOutput(output: string): ReviewInput {
  const [marker, ...transportLines] = output.trimEnd().split('\n');
  expect(marker).toBe('STE_AI_REVIEW_INPUT_V1');
  expect(transportLines.at(-1)).toBe('STE_AI_REVIEW_JSON_END');
  const chunks = transportLines.slice(0, -1).map((line) => {
    const prefix = 'STE_AI_REVIEW_JSON_CHUNK ';
    expect(line.startsWith(prefix)).toBe(true);
    expect(line.length).toBeLessThan(1_800);
    return line.slice(prefix.length);
  });
  const decoded: unknown = JSON.parse(chunks.join(''));
  return reviewInputSchema.parse(decoded);
}

function executePreparer(directory: string, options: PreparerOptions = {}): string {
  const environment = preparerEnvironment(
    options.baseOid,
    options.noPullRequest ?? false,
    options.environment,
  );
  if (options.pathPrefix !== undefined) {
    environment['PATH'] = `${options.pathPrefix}${delimiter}${environment['PATH'] ?? ''}`;
  }
  const result = spawnSync('/bin/sh', [preparerLauncherPath], {
    cwd: directory,
    encoding: 'utf8',
    env: environment,
    shell: false,
    timeout: 40_000,
  });
  expect(result.status).toBe(0);
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result.stdout;
}

function runPreparer(directory: string, options: PreparerOptions = {}): ReviewInput {
  return parsePreparedOutput(executePreparer(directory, options));
}

async function runPreparerDuringMutation(
  directory: string,
  baseOid: string,
  mutate: () => void,
): Promise<ReviewInput> {
  const child = spawn('/bin/sh', [preparerLauncherPath], {
    cwd: directory,
    env: preparerEnvironment(baseOid, false, {
      NODE_ENV: 'test',
      STE_AI_REVIEW_TEST_PAUSE_MS: '1500',
    }),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  if (child.stdout === null || child.stderr === null) {
    throw new Error('preparer stdio was not piped');
  }
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('preparer did not reach the race-test snapshot boundary')),
      5_000,
    );
    child.once('message', (message) => {
      clearTimeout(timeout);
      if (message !== 'ste-ai-review-snapshot-ready') {
        reject(new Error('preparer sent an unexpected IPC message'));
        return;
      }
      resolve();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  mutate();
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.once('close', (code, signal) => resolve({ code, signal })),
  );
  expect(result).toEqual({ code: 0, signal: null });
  expect(stderr).toBe('');
  return parsePreparedOutput(stdout);
}

function tableAfter(markdown: string, anchor: string): string[][] {
  const anchorIndex = markdown.indexOf(anchor);
  if (anchorIndex === -1) throw new Error(`Missing table anchor: ${anchor}`);
  const lines = markdown.slice(anchorIndex + anchor.length).split('\n');
  const tableStart = lines.findIndex((line) => line.startsWith('|'));
  if (tableStart === -1) throw new Error(`Missing table after: ${anchor}`);
  const rows: string[][] = [];
  for (const line of lines.slice(tableStart + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    );
  }
  return rows;
}

afterEach(() => {
  for (const directory of scratchDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ste-ai-compliance plugin contract', () => {
  it.skipIf(process.platform === 'win32')(
    'collects committed and workspace sources independently',
    () => {
      const repository = makeRepository();
      runChecked('git', ['switch', '-c', 'feature'], repository.directory);
      writeFileSync(join(repository.directory, 'doc.md'), 'committed violation\n');
      commitAll(repository.directory, 'test: feature');
      writeFileSync(join(repository.directory, 'doc.md'), 'workspace repair\n');

      const prepared = runPreparer(repository.directory, { baseOid: repository.baseOid });

      expect(prepared.schemaVersion).toBe(1);
      expect(prepared.complete).toBe(true);
      expect(prepared.committed.patch).toContain('+committed violation');
      expect(prepared.committed.patch).not.toContain('+workspace repair');
      expect(prepared.workspace.unstagedPatch).toContain('-committed violation');
      expect(prepared.workspace.unstagedPatch).toContain('+workspace repair');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps staged content when an unstaged repair cancels the combined diff',
    () => {
      const repository = makeRepository();
      writeFileSync(join(repository.directory, 'doc.md'), 'staged violation\n');
      runChecked('git', ['add', '--', 'doc.md'], repository.directory);
      writeFileSync(join(repository.directory, 'doc.md'), 'base\n');

      const prepared = runPreparer(repository.directory, { baseOid: repository.baseOid });

      expect(prepared.workspace.complete).toBe(true);
      expect(prepared.workspace.trackedPatch).toBe('');
      expect(prepared.workspace.stagedPatch).toContain('+staged violation');
      expect(prepared.workspace.unstagedPatch).toContain('-staged violation');
      expect(prepared.workspace.indexFiles).toContainEqual(
        expect.objectContaining({ path: 'doc.md', content: 'staged violation\n' }),
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'snapshots HEAD and workspace instructions independently',
    () => {
      const repository = makeRepository();
      writeFileSync(join(repository.directory, 'AGENTS.md'), 'Do not add forbidden text.\n');
      const policyBase = commitAll(repository.directory, 'test: policy');
      runChecked('git', ['switch', '-c', 'feature'], repository.directory);
      writeFileSync(join(repository.directory, 'doc.md'), 'forbidden text\n');
      commitAll(repository.directory, 'test: violation');
      writeFileSync(join(repository.directory, 'AGENTS.md'), 'No shared requirements.\n');

      const prepared = runPreparer(repository.directory, { baseOid: policyBase });
      const headPolicy = prepared.committed.instructions.files.find(
        (record) => record.path === 'AGENTS.md',
      );
      const workspacePolicy = prepared.workspace.instructions.files.find(
        (record) => record.path === 'AGENTS.md',
      );

      expect(headPolicy?.content).toBe('Do not add forbidden text.\n');
      expect(workspacePolicy?.content).toBe('No shared requirements.\n');
      expect(prepared.workspace.complete).toBe(false);
      expect(prepared.workspace.diagnostics.join('\n')).toContain(
        'workspace changes governing instructions: AGENTS.md',
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'marks committed governing-instruction changes incomplete',
    () => {
      const repository = makeRepository();
      writeFileSync(join(repository.directory, 'AGENTS.md'), 'Do not add forbidden text.\n');
      const policyBase = commitAll(repository.directory, 'test: policy');
      runChecked('git', ['switch', '-c', 'feature'], repository.directory);
      writeFileSync(join(repository.directory, 'AGENTS.md'), 'No shared requirements.\n');
      writeFileSync(join(repository.directory, 'doc.md'), 'forbidden text\n');
      commitAll(repository.directory, 'test: weaken policy');

      const prepared = runPreparer(repository.directory, { baseOid: policyBase });

      expect(prepared.committed.complete).toBe(false);
      expect(prepared.committed.diagnostics.join('\n')).toContain(
        'committed changes governing instructions: AGENTS.md',
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'resolves contained imports and rejects an external rule symlink',
    () => {
      const repository = makeRepository();
      mkdirSync(join(repository.directory, '.claude'), { recursive: true });
      mkdirSync(join(repository.directory, 'instructions'), { recursive: true });
      writeFileSync(
        join(repository.directory, '.claude/CLAUDE.md'),
        [
          'Visible marker @../instructions/shared.md',
          '',
          '    ```',
          '@../instructions/indented.md',
          '````',
          '@../instructions/hidden.md',
          '```',
          '@../instructions/still-hidden.md',
          '````',
          '``inline @../instructions/inline-hidden.md``',
          '`` @../instructions/exact-hidden.md ``` literal ``',
          `${'`'.repeat(11)}code${'`'.repeat(12)} @../instructions/mismatched.md${'`'.repeat(13)}`,
          `Escaped \\${'`'.repeat(14)} @../instructions/escaped-visible.md ${'`'.repeat(14)}`,
          `Even \\\\${'`'.repeat(15)} @../instructions/even-hidden.md ${'`'.repeat(15)}`,
          `${'`'.repeat(16)}multiline`,
          '@../instructions/multiline-hidden.md',
          '`'.repeat(16),
          '```invalid`info',
          '@../instructions/after-invalid.md',
          '~~~info`with-tick',
          '@../instructions/tilde-hidden.md',
          '~~~',
          '```',
          '@../instructions/nbsp-hidden.md',
          '```\u00a0',
          '@../instructions/nbsp-still-hidden.md',
          '```',
          '@../instructions/visible.md',
          '',
        ].join('\n'),
      );
      writeFileSync(join(repository.directory, 'instructions/shared.md'), 'Use shared words.\n');
      writeFileSync(
        join(repository.directory, 'instructions/indented.md'),
        'Use indented words.\n',
      );
      writeFileSync(join(repository.directory, 'instructions/hidden.md'), 'Hidden import.\n');
      writeFileSync(
        join(repository.directory, 'instructions/still-hidden.md'),
        'Still hidden import.\n',
      );
      writeFileSync(join(repository.directory, 'instructions/visible.md'), 'Use visible words.\n');
      writeFileSync(
        join(repository.directory, 'instructions/inline-hidden.md'),
        'Hidden inline import.\n',
      );
      writeFileSync(
        join(repository.directory, 'instructions/mismatched.md'),
        'Use mismatched-run words.\n',
      );
      writeFileSync(
        join(repository.directory, 'instructions/escaped-visible.md'),
        'Use escaped-run words.\n',
      );
      writeFileSync(
        join(repository.directory, 'instructions/after-invalid.md'),
        'Use invalid-fence words.\n',
      );
      for (const hidden of [
        'even-hidden.md',
        'exact-hidden.md',
        'multiline-hidden.md',
        'nbsp-hidden.md',
        'nbsp-still-hidden.md',
        'tilde-hidden.md',
      ]) {
        writeFileSync(join(repository.directory, 'instructions', hidden), 'Hidden import.\n');
      }
      const policyBase = commitAll(repository.directory, 'test: imported policy');
      runChecked('git', ['switch', '-c', 'feature'], repository.directory);
      writeFileSync(join(repository.directory, 'doc.md'), 'feature\n');
      commitAll(repository.directory, 'test: feature');

      const contained = runPreparer(repository.directory, { baseOid: policyBase });
      expect(contained.committed.instructions.complete).toBe(true);
      expect(contained.committed.instructions.files).toContainEqual(
        expect.objectContaining({
          path: 'instructions/shared.md',
          routes: expect.arrayContaining([expect.objectContaining({ category: 'claude-import' })]),
        }),
      );
      expect(contained.committed.instructions.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'instructions/indented.md' }),
          expect.objectContaining({ path: 'instructions/after-invalid.md' }),
          expect.objectContaining({ path: 'instructions/escaped-visible.md' }),
          expect.objectContaining({ path: 'instructions/mismatched.md' }),
          expect.objectContaining({ path: 'instructions/visible.md' }),
        ]),
      );
      expect(contained.committed.instructions.files).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'instructions/hidden.md' }),
          expect.objectContaining({ path: 'instructions/even-hidden.md' }),
          expect.objectContaining({ path: 'instructions/exact-hidden.md' }),
          expect.objectContaining({ path: 'instructions/inline-hidden.md' }),
          expect.objectContaining({ path: 'instructions/multiline-hidden.md' }),
          expect.objectContaining({ path: 'instructions/nbsp-hidden.md' }),
          expect.objectContaining({ path: 'instructions/nbsp-still-hidden.md' }),
          expect.objectContaining({ path: 'instructions/still-hidden.md' }),
          expect.objectContaining({ path: 'instructions/tilde-hidden.md' }),
        ]),
      );

      const outside = makeScratchDir('ste-ai-external-rule-');
      writeFileSync(join(outside, 'external.md'), 'External instruction.\n');
      mkdirSync(join(repository.directory, '.claude/rules'), { recursive: true });
      symlinkSync(
        join(outside, 'external.md'),
        join(repository.directory, '.claude/rules/link.md'),
      );
      commitAll(repository.directory, 'test: external rule link');
      const external = runPreparer(repository.directory, { baseOid: policyBase });
      expect(external.committed.instructions.complete).toBe(false);
      expect(external.committed.instructions.diagnostics.join('\n')).toContain(
        'instruction target leaves the repository',
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects contained private and broken instruction symlink targets',
    () => {
      const repository = makeRepository();
      mkdirSync(join(repository.directory, '.claude/rules'), { recursive: true });
      writeFileSync(join(repository.directory, '.gitignore'), '/private.md\n');
      writeFileSync(join(repository.directory, 'private.md'), 'PRIVATE POLICY CONTENT\n');
      symlinkSync('../../private.md', join(repository.directory, '.claude/rules/private.md'));
      symlinkSync('missing.md', join(repository.directory, 'AGENTS.md'));
      const policyBase = commitAll(repository.directory, 'test: unsafe policy links');
      runChecked('git', ['switch', '-c', 'feature'], repository.directory);
      writeFileSync(join(repository.directory, 'doc.md'), 'feature\n');
      commitAll(repository.directory, 'test: feature');
      writeFileSync(join(repository.directory, 'doc.md'), 'workspace feature\n');

      const prepared = runPreparer(repository.directory, { baseOid: policyBase });
      const allInstructionContent = [
        ...prepared.committed.instructions.files,
        ...prepared.workspace.instructions.files,
      ]
        .map((record) => record.content)
        .join('\n');

      expect(prepared.committed.instructions.complete).toBe(false);
      expect(prepared.workspace.instructions.complete).toBe(false);
      expect(prepared.committed.instructions.diagnostics.join('\n')).toContain(
        'governing instruction is missing from HEAD: AGENTS.md',
      );
      expect(prepared.workspace.instructions.diagnostics.join('\n')).toContain(
        'instruction target is not shared: .claude/rules/private.md',
      );
      expect(allInstructionContent).not.toContain('PRIVATE POLICY CONTENT');
    },
  );

  it.skipIf(process.platform === 'win32')('marks broken rule-directory symlinks incomplete', () => {
    const repository = makeRepository();
    mkdirSync(join(repository.directory, '.claude'), { recursive: true });
    symlinkSync('missing-rules', join(repository.directory, '.claude/rules'));
    const policyBase = commitAll(repository.directory, 'test: broken rule directory');
    runChecked('git', ['switch', '-c', 'feature'], repository.directory);
    writeFileSync(join(repository.directory, 'doc.md'), 'feature\n');
    commitAll(repository.directory, 'test: feature');
    writeFileSync(join(repository.directory, 'doc.md'), 'workspace feature\n');

    const prepared = runPreparer(repository.directory, { baseOid: policyBase });

    expect(prepared.committed.instructions.complete).toBe(false);
    expect(prepared.workspace.instructions.complete).toBe(false);
    expect(prepared.committed.instructions.diagnostics.join('\n')).toContain(
      'rule directory symbolic-link target is missing: .claude/rules',
    );
    expect(prepared.workspace.instructions.diagnostics.join('\n')).toContain(
      'cannot inspect rule directory .claude/rules',
    );
  });

  it.skipIf(process.platform === 'win32')('bounds Claude import graph expansion', () => {
    const repository = makeRepository();
    mkdirSync(join(repository.directory, '.claude'), { recursive: true });
    writeFileSync(join(repository.directory, '.claude/CLAUDE.md'), '@../policy.md\n'.repeat(513));
    writeFileSync(join(repository.directory, 'policy.md'), 'Use bounded imports.\n');
    const policyBase = commitAll(repository.directory, 'test: repeated imports');
    runChecked('git', ['switch', '-c', 'feature'], repository.directory);
    writeFileSync(join(repository.directory, 'doc.md'), 'feature\n');
    commitAll(repository.directory, 'test: feature');

    const prepared = runPreparer(repository.directory, { baseOid: policyBase });

    expect(prepared.committed.instructions.complete).toBe(false);
    expect(prepared.committed.instructions.diagnostics.join('\n')).toContain(
      'Claude import graph exceeds 512 edges',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'marks Markdown container fences in Claude memory unsupported',
    () => {
      const repository = makeRepository();
      mkdirSync(join(repository.directory, '.claude'), { recursive: true });
      writeFileSync(
        join(repository.directory, '.claude/CLAUDE.md'),
        ['- ```', '  example', '  ```', '> ~~~', '> example', '> ~~~', '@../policy.md', ''].join(
          '\n',
        ),
      );
      writeFileSync(join(repository.directory, 'policy.md'), 'Use the visible policy.\n');
      const policyBase = commitAll(repository.directory, 'test: container fence policy');
      runChecked('git', ['switch', '-c', 'feature'], repository.directory);
      writeFileSync(join(repository.directory, 'doc.md'), 'feature\n');
      commitAll(repository.directory, 'test: feature');

      const prepared = runPreparer(repository.directory, { baseOid: policyBase });

      expect(prepared.committed.instructions.complete).toBe(false);
      expect(prepared.committed.instructions.diagnostics.join('\n')).toContain(
        'Claude instruction has an unsupported container fence: .claude/CLAUDE.md',
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'excludes local Claude memory and marks Cursor file references unsupported',
    () => {
      const repository = makeRepository();
      mkdirSync(join(repository.directory, '.claude'), { recursive: true });
      mkdirSync(join(repository.directory, '.cursor/rules'), { recursive: true });
      writeFileSync(join(repository.directory, '.claude/CLAUDE.md'), '@../CLAUDE.local.md\n');
      writeFileSync(join(repository.directory, 'CLAUDE.local.md'), 'LOCAL MEMORY CONTENT\n');
      writeFileSync(
        join(repository.directory, '.cursor/rules/reference.mdc'),
        ['---', 'alwaysApply: true', '---', '@../../policy.md', ''].join('\n'),
      );
      writeFileSync(join(repository.directory, 'policy.md'), 'Use the Cursor policy.\n');
      const policyBase = commitAll(repository.directory, 'test: local and Cursor references');
      runChecked('git', ['switch', '-c', 'feature'], repository.directory);
      writeFileSync(join(repository.directory, 'doc.md'), 'feature\n');
      commitAll(repository.directory, 'test: feature');

      const prepared = runPreparer(repository.directory, { baseOid: policyBase });
      const instructionContent = prepared.committed.instructions.files
        .map((record) => record.content)
        .join('\n');

      expect(prepared.committed.instructions.complete).toBe(false);
      expect(prepared.committed.instructions.diagnostics.join('\n')).toContain(
        'Cursor file reference is unsupported: .cursor/rules/reference.mdc -> ../../policy.md',
      );
      expect(prepared.committed.instructions.files).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'CLAUDE.local.md' })]),
      );
      expect(instructionContent).not.toContain('LOCAL MEMORY CONTENT');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'applies root instructions to POSIX drive-like Git paths',
    () => {
      const repository = makeRepository();
      writeFileSync(join(repository.directory, 'AGENTS.md'), 'Use root policy.\n');
      const policyBase = commitAll(repository.directory, 'test: root policy');
      runChecked('git', ['switch', '-c', 'feature'], repository.directory);
      mkdirSync(join(repository.directory, 'C:'), { recursive: true });
      writeFileSync(join(repository.directory, 'C:/bypass.md'), 'slash path\n');
      writeFileSync(join(repository.directory, 'C:\\bypass.md'), 'backslash path\n');
      commitAll(repository.directory, 'test: drive-like paths');

      const prepared = runPreparer(repository.directory, { baseOid: policyBase });

      expect(prepared.committed.complete).toBe(true);
      expect(prepared.committed.changedPaths).toEqual(
        expect.arrayContaining(['C:/bypass.md', 'C:\\bypass.md']),
      );
      expect(prepared.committed.instructions.files).toContainEqual(
        expect.objectContaining({
          path: 'AGENTS.md',
          content: 'Use root policy.\n',
          routes: expect.arrayContaining([
            expect.objectContaining({
              category: 'agents-memory',
              appliesTo: expect.arrayContaining(['C:/bypass.md', 'C:\\bypass.md']),
            }),
          ]),
        }),
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'maps nested instructions only to the paths they govern',
    () => {
      const repository = makeRepository();
      mkdirSync(join(repository.directory, 'a'), { recursive: true });
      mkdirSync(join(repository.directory, 'b'), { recursive: true });
      writeFileSync(join(repository.directory, 'a/AGENTS.md'), 'Use the A policy.\n');
      writeFileSync(join(repository.directory, 'a/doc.md'), 'base A\n');
      writeFileSync(join(repository.directory, 'b/doc.md'), 'base B\n');
      const policyBase = commitAll(repository.directory, 'test: nested policy');
      runChecked('git', ['switch', '-c', 'feature'], repository.directory);
      writeFileSync(join(repository.directory, 'a/doc.md'), 'feature A\n');
      writeFileSync(join(repository.directory, 'b/doc.md'), 'feature B\n');
      commitAll(repository.directory, 'test: feature');

      const prepared = runPreparer(repository.directory, { baseOid: policyBase });
      const nestedPolicy = prepared.committed.instructions.files.find(
        (record) => record.path === 'a/AGENTS.md',
      );

      expect(nestedPolicy?.routes).toContainEqual({
        category: 'agents-memory',
        appliesTo: ['a/doc.md'],
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps rule and Claude-import applicability routes separate for one file',
    () => {
      const repository = makeRepository();
      mkdirSync(join(repository.directory, '.claude/rules'), { recursive: true });
      mkdirSync(join(repository.directory, 'a'), { recursive: true });
      mkdirSync(join(repository.directory, 'b'), { recursive: true });
      writeFileSync(
        join(repository.directory, '.claude/rules/collision.md'),
        ['---', 'paths: b/**', '---', 'Use the collision policy.', ''].join('\n'),
      );
      writeFileSync(join(repository.directory, 'a/CLAUDE.md'), '@../.claude/rules/collision.md\n');
      writeFileSync(join(repository.directory, 'a/doc.md'), 'base A\n');
      writeFileSync(join(repository.directory, 'b/doc.md'), 'base B\n');
      const policyBase = commitAll(repository.directory, 'test: colliding policy routes');
      runChecked('git', ['switch', '-c', 'feature'], repository.directory);
      writeFileSync(join(repository.directory, 'a/doc.md'), 'feature A\n');
      writeFileSync(join(repository.directory, 'b/doc.md'), 'feature B\n');
      commitAll(repository.directory, 'test: feature');

      const prepared = runPreparer(repository.directory, { baseOid: policyBase });
      const collision = prepared.committed.instructions.files.find(
        (record) => record.path === '.claude/rules/collision.md',
      );

      expect(collision?.routes).toContainEqual({
        category: 'claude-import',
        appliesTo: ['a/doc.md'],
      });
      expect(collision?.routes).toContainEqual({
        category: 'claude-rule',
        appliesTo: ['a/doc.md', 'b/doc.md'],
      });
      expect(collision).not.toHaveProperty('categories');
      expect(collision).not.toHaveProperty('appliesTo');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'preserves hostile tracked and untracked path identity as JSON data',
    () => {
      const repository = makeRepository();
      const hostileTracked = '-tracked $(touch STE_AI_TRACKED)\nname.md';
      const hostileRenamed = '-renamed $(touch STE_AI_RENAMED)\nname.md';
      const hostileUntracked = '-$(touch STE_AI_UNTRACKED) spaced\nname.md';
      runChecked('git', ['switch', '-c', 'feature'], repository.directory);
      writeFileSync(join(repository.directory, hostileTracked), 'tracked text\n');
      runChecked('git', ['mv', '--', 'doc.md', hostileRenamed], repository.directory);
      commitAll(repository.directory, 'test: hostile tracked path');
      writeFileSync(join(repository.directory, hostileUntracked), 'untrusted text\n');

      const prepared = runPreparer(repository.directory, { baseOid: repository.baseOid });

      expect(prepared.committed.changedPaths).toContain(hostileTracked);
      expect(prepared.committed.changedPaths).toEqual(
        expect.arrayContaining(['doc.md', hostileRenamed]),
      );
      expect(prepared.workspace.untracked).toContainEqual(
        expect.objectContaining({ path: hostileUntracked, content: 'untrusted text\n' }),
      );
      expect(existsSync(join(repository.directory, 'STE_AI_TRACKED'))).toBe(false);
      expect(existsSync(join(repository.directory, 'STE_AI_RENAMED'))).toBe(false);
      expect(existsSync(join(repository.directory, 'STE_AI_UNTRACKED'))).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects repository-local Node and Git executables, including through GitHub CLI',
    () => {
      const repository = makeRepository();
      const binDirectory = join(repository.directory, 'bin');
      const invocationDirectory = join(repository.directory, 'subdirectory');
      const gitMarker = join(repository.directory, 'REPOSITORY_GIT_EXECUTED');
      const nodeMarker = join(repository.directory, 'REPOSITORY_NODE_EXECUTED');
      mkdirSync(binDirectory);
      mkdirSync(invocationDirectory);
      const maliciousGit = join(binDirectory, 'git');
      writeFileSync(
        maliciousGit,
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(
          gitMarker,
        )}, 'executed');\nprocess.exit(99);\n`,
      );
      chmodSync(maliciousGit, 0o755);
      const maliciousNode = join(binDirectory, 'node');
      writeFileSync(
        maliciousNode,
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(
          nodeMarker,
        )}, 'executed');\nprocess.exit(99);\n`,
      );
      chmodSync(maliciousNode, 0o755);

      const prepared = runPreparer(invocationDirectory, {
        baseOid: repository.baseOid,
        environment: { FAKE_GH_PROBE_GIT: '1' },
        pathPrefix: binDirectory,
      });

      expect(prepared.fatal).toBeUndefined();
      expect(existsSync(gitMarker)).toBe(false);
      expect(existsSync(nodeMarker)).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'marks committed, index, worktree, and untracked source symlinks incomplete',
    () => {
      const repository = makeRepository();
      writeFileSync(join(repository.directory, 'target.md'), 'target content\n');
      const baseOid = commitAll(repository.directory, 'test: symlink target');
      runChecked('git', ['switch', '-c', 'feature'], repository.directory);
      symlinkSync('target.md', join(repository.directory, 'committed-link.md'));
      commitAll(repository.directory, 'test: committed source link');
      symlinkSync('target.md', join(repository.directory, 'staged-link.md'));
      runChecked('git', ['add', '--', 'staged-link.md'], repository.directory);
      rmSync(join(repository.directory, 'doc.md'));
      symlinkSync('target.md', join(repository.directory, 'doc.md'));
      symlinkSync('target.md', join(repository.directory, 'untracked-link.md'));

      const prepared = runPreparer(repository.directory, { baseOid });

      expect(prepared.committed.complete).toBe(false);
      expect(prepared.workspace.complete).toBe(false);
      expect(prepared.committed.diagnostics.join('\n')).toContain(
        'symbolic link with unavailable whole-file content: committed-link.md',
      );
      for (const changedPath of ['doc.md', 'staged-link.md', 'untracked-link.md']) {
        expect(prepared.workspace.diagnostics.join('\n')).toContain(
          `symbolic link with unavailable whole-file content: ${changedPath}`,
        );
      }
      expect(prepared.committed.files).toContainEqual(
        expect.objectContaining({ path: 'committed-link.md', kind: 'symlink' }),
      );
      expect(prepared.workspace.indexFiles).toContainEqual(
        expect.objectContaining({ path: 'staged-link.md', kind: 'symlink' }),
      );
      expect(prepared.workspace.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'doc.md', kind: 'symlink' }),
          expect.objectContaining({ path: 'staged-link.md', kind: 'symlink' }),
        ]),
      );
      expect(prepared.workspace.untracked).toContainEqual(
        expect.objectContaining({ path: 'untracked-link.md', kind: 'symlink' }),
      );
      expect(prepared.workspace.diagnostics.join('\n')).not.toContain(
        'workspace content changed during collection',
      );
      expect(prepared.workspace.diagnostics.join('\n')).not.toContain(
        'emitted workspace file state changed during collection',
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'detects same-status workspace content races',
    async () => {
      const repository = makeRepository();
      writeFileSync(join(repository.directory, 'doc.md'), 'dirty one\n');

      const prepared = await runPreparerDuringMutation(
        repository.directory,
        repository.baseOid,
        () => writeFileSync(join(repository.directory, 'doc.md'), 'dirty two\n'),
      );

      expect(prepared.workspace.complete).toBe(false);
      expect(prepared.workspace.diagnostics.join('\n')).toContain(
        'tracked workspace content changed during collection',
      );
    },
    10_000,
  );

  it.skipIf(process.platform === 'win32')(
    'supports spill-sized output and caps untracked records and serialized output',
    () => {
      const spillSized = makeRepository();
      writeFileSync(join(spillSized.directory, 'long.md'), 'review content\n'.repeat(4_000));
      const emojiContent = `x${'😀'.repeat(500)}\n`;
      writeFileSync(join(spillSized.directory, 'emoji.md'), emojiContent);
      const spillSizedRaw = executePreparer(spillSized.directory, {
        baseOid: spillSized.baseOid,
      });
      expect(Buffer.byteLength(spillSizedRaw)).toBeGreaterThan(30_000);
      const spillSizedPrepared = parsePreparedOutput(spillSizedRaw);
      expect(spillSizedPrepared.complete).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(spillSizedPrepared))).toBeGreaterThan(65_000);
      expect(Buffer.byteLength(JSON.stringify(spillSizedPrepared))).toBeLessThanOrEqual(96 * 1024);
      expect(spillSizedPrepared.workspace.untracked).toContainEqual(
        expect.objectContaining({ path: 'emoji.md', content: emojiContent }),
      );

      const oversizedInstruction = makeRepository();
      writeFileSync(
        join(oversizedInstruction.directory, 'AGENTS.md'),
        'oversized policy\n'.repeat(20_000),
      );
      const oversizedPolicyBase = commitAll(
        oversizedInstruction.directory,
        'test: oversized policy',
      );
      runChecked('git', ['switch', '-c', 'feature'], oversizedInstruction.directory);
      writeFileSync(join(oversizedInstruction.directory, 'doc.md'), 'feature\n');
      commitAll(oversizedInstruction.directory, 'test: feature');
      const oversizedPrepared = runPreparer(oversizedInstruction.directory, {
        baseOid: oversizedPolicyBase,
      });
      expect(oversizedPrepared.committed.instructions.complete).toBe(false);
      expect(oversizedPrepared.committed.instructions.diagnostics.join('\n')).toContain(
        'content exceeds 262144 bytes',
      );

      const manyFiles = makeRepository();
      for (let index = 0; index <= 128; index += 1) {
        writeFileSync(join(manyFiles.directory, `extra-${index}.md`), '');
      }
      const boundedRecords = runPreparer(manyFiles.directory, { baseOid: manyFiles.baseOid });
      expect(boundedRecords.workspace.complete).toBe(false);
      expect(boundedRecords.workspace.untracked).toHaveLength(128);
      expect(boundedRecords.workspace.diagnostics.join('\n')).toContain(
        'untracked inventory exceeds 128 files',
      );

      const escapedOutput = makeRepository();
      writeFileSync(join(escapedOutput.directory, 'controls.md'), '\u0001'.repeat(250_000));
      const raw = executePreparer(escapedOutput.directory, { baseOid: escapedOutput.baseOid });
      const prepared = parsePreparedOutput(raw);
      expect(prepared.complete).toBe(false);
      expect(prepared.fatal).toContain('serialized bytes');
      expect(Buffer.byteLength(raw)).toBeLessThan(10_000);
    },
    40_000,
  );

  it.skipIf(process.platform === 'win32')(
    'marks the committed source incomplete when no authoritative base exists',
    () => {
      const repository = makeRepository();
      const prepared = runPreparer(repository.directory, { noPullRequest: true });

      expect(prepared.complete).toBe(false);
      expect(prepared.committed.complete).toBe(false);
      expect(prepared.committed.diagnostics.join('\n')).toContain(
        'no pull request or validated remote default base is available',
      );
    },
  );

  it('pins Cursor applicability and instruction precedence as decision tables', () => {
    const skill = readRepoFile('skills/pre-push-review/SKILL.md');
    const cursorRows = tableAfter(skill, 'Apply this table in order:');
    expect(cursorRows).toEqual([
      ['`true`', 'Any', 'Any', '`APPLY`'],
      ['`false` or absent', 'Present and matching', 'Any', '`APPLY`'],
      ['`false` or absent', 'Present and not matching', 'Any', '`SKIP`'],
      [
        '`false` or absent',
        'Absent',
        'Present',
        '`INCOMPLETE` unless the caller confirms Cursor attached it',
      ],
      ['`false` or absent', 'Absent', 'Absent', '`SKIP` as manual-only'],
    ]);

    const conflictRows = tableAfter(skill, 'Apply this conflict table.');
    expect(conflictRows).toEqual([
      ['Nested `AGENTS.md` files', 'Yes', 'The more specific file wins'],
      [
        'Claude memory files',
        'Yes',
        '`INCOMPLETE` because Claude concatenates them without defined precedence',
      ],
      [
        'Different instruction systems',
        'Yes',
        '`INCOMPLETE` because no cross-system precedence is defined',
      ],
      ['Files at the same specificity', 'Yes', '`INCOMPLETE` because no winner is defined'],
    ]);
  });

  it('runs a bounded argv-only preparer in a namespaced read-only fork', () => {
    const skill = readRepoFile('skills/pre-push-review/SKILL.md');
    const agent = readRepoFile('agents/way-of-working-compliance-reviewer.md');
    const preparer = readRepoFile('skills/pre-push-review/scripts/prepare-review.cjs');
    const launcher = readRepoFile('skills/pre-push-review/scripts/prepare-review.sh');
    const resolver = readRepoFile('skills/pre-push-review/scripts/instruction-snapshots.cjs');

    expect(skill).toMatch(/^context: fork$/m);
    expect(skill).toMatch(/^agent: ste-ai-compliance:way-of-working-compliance-reviewer$/m);
    expect(skill).not.toMatch(/^agent: Explore$/m);
    expect(skill).toMatch(/^background: false$/m);
    expect(skill).toMatch(/^shell: bash$/m);
    expect(skill).toMatch(/^compatibility:.*POSIX.*Git.*authenticated GitHub CLI.*unsupported/m);
    expect(skill).toContain('!`/bin/sh "${CLAUDE_SKILL_DIR}/scripts/prepare-review.sh"`');
    expect(skill).toContain('Claude Code output-spill notice');
    expect(preparer).toContain('shell: false');
    expect(preparer).toContain("process.platform === 'win32'");
    expect(launcher).toContain('exec "$node_executable" "$script_directory/prepare-review.cjs"');
    expect(launcher).not.toMatch(/(?:^|[;&|])\s*node\s/m);
    expect(resolver).toContain('realpathSync');
    expect(`${preparer}\n${resolver}`).not.toMatch(/\bexec(?:File)?Sync\b/);
    expect(agent).toMatch(/^tools: Read$/m);
    expect(agent).not.toMatch(/^tools:.*(?:Bash|Write|Edit|Glob|Grep)/m);
    expect(agent).not.toMatch(/^(?:permissionMode|color):/m);
  });

  it('uses a structured lowercase-.md hook and an unpinned plugin version', () => {
    const hooks = JSON.parse(readRepoFile('hooks/hooks.json'));
    const commandHook = hooks.hooks.PreToolUse[0].hooks[0];
    expect(commandHook).toMatchObject({
      type: 'command',
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/hooks/block-noncompliant-prose.cjs'],
      timeout: 60,
    });

    const plugin = JSON.parse(readRepoFile('.claude-plugin/plugin.json'));
    expect(plugin.name).toBe('ste-ai-compliance');
    expect(plugin.description).toContain('lowercase .md files');
    expect(plugin).not.toHaveProperty('version');
  });
});
