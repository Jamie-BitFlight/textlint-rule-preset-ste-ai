import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vite-plus/test';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const hookPath = join(repoRoot, 'hooks/block-noncompliant-prose.cjs');
const targetFile = join(repoRoot, 'docs/architecture.md');
const requireFromTest = createRequire(import.meta.url);
const realGlobDir = dirname(requireFromTest.resolve('glob/package.json'));
const scratchDirs: string[] = [];
const HOOK_PROCESS_TIMEOUT_MS = 65_000;
const SUBPROCESS_TEST_TIMEOUT_MS = 70_000;

type HookResult = { status: number | null; stderr: string };

function runHook(event: unknown, script = hookPath): HookResult {
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    input: JSON.stringify(event),
    encoding: 'utf8',
    timeout: HOOK_PROCESS_TIMEOUT_MS,
    killSignal: 'SIGTERM',
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) throw new Error(`Hook process exited due to ${result.signal}`);
  return { status: result.status, stderr: result.stderr };
}

function runProjectHook(projectDir: string, event: Record<string, unknown>, script = hookPath) {
  return runHook({ ...event, cwd: projectDir }, script);
}

function runHookRaw(stdin: string): HookResult {
  const result = spawnSync(process.execPath, [hookPath], {
    cwd: repoRoot,
    input: stdin,
    encoding: 'utf8',
    timeout: HOOK_PROCESS_TIMEOUT_MS,
    killSignal: 'SIGTERM',
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) throw new Error(`Hook process exited due to ${result.signal}`);
  return { status: result.status, stderr: result.stderr };
}

function makeScratchDir(prefix: string): string {
  const scratchDir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(scratchDir);
  return scratchDir;
}

function installStubTextlint(
  projectDir: string,
  options: { mode?: 'normal' | 'trap' | 'trap-exit'; withGlob?: boolean } = {},
): void {
  const textlintDir = join(projectDir, 'node_modules/textlint');
  const binDir = join(textlintDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(textlintDir, 'package.json'),
    JSON.stringify({
      name: 'textlint',
      version: '15.8.0',
      bin: { textlint: './bin/textlint.js' },
      dependencies: { glob: '^13.0.6' },
    }),
  );
  writeFileSync(join(projectDir, '.stub-scenario.json'), JSON.stringify(options));
  writeFileSync(
    join(binDir, 'textlint.js'),
    [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const projectDir = path.resolve(__dirname, '../../..');",
      "const scenario = JSON.parse(fs.readFileSync(path.join(projectDir, '.stub-scenario.json')));",
      "const stdin = fs.readFileSync(0, 'utf8');",
      "fs.appendFileSync(path.join(projectDir, '.stub-calls.jsonl'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), stdin }) + '\\n');",
      "fs.writeFileSync(path.join(projectDir, '.stub-started'), 'started');",
      "fs.writeFileSync(path.join(projectDir, '.stub-pid'), String(process.pid));",
      "if (scenario.mode === 'trap') {",
      "  process.on('SIGTERM', () => process.stdout.write('[{\"messages\":[]}]'));",
      '  setInterval(() => {}, 1000);',
      "} else if (scenario.mode === 'trap-exit') {",
      "  process.on('SIGTERM', () => process.stdout.end('[{\"messages\":[]}]', () => process.exit(0)));",
      '  setInterval(() => {}, 1000);',
      '} else {',
      '  const messages = [];',
      "  if (stdin.includes('STE_VIOLATION')) messages.push({ ruleId: 'ste-ai/stub-rule', message: 'new violation', severity: 2, line: 1, column: 1 });",
      "  if (stdin.includes('STE_ONE')) messages.push({ ruleId: 'ste-ai/stub-rule', message: 'first violation', severity: 2, line: 1, column: 1 });",
      "  if (stdin.includes('STE_TWO')) messages.push({ ruleId: 'ste-ai/stub-rule', message: 'second violation', severity: 2, line: 1, column: 1 });",
      "  if (stdin.includes('OTHER_VIOLATION')) messages.push({ ruleId: 'other-rule', message: 'unrelated violation', severity: 2, line: 1, column: 1 });",
      "  process.stdout.write(JSON.stringify([{ filePath: 'stdin.md', messages }]));",
      '  process.exitCode = messages.length > 0 ? 1 : 0;',
      '}',
      '',
    ].join('\n'),
  );

  if (options.withGlob !== false) {
    const target = join(textlintDir, 'node_modules/glob');
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(realGlobDir, target, process.platform === 'win32' ? 'junction' : 'dir');
  }
}

function makeStubProject(
  options: {
    ignore?: string;
    mode?: 'normal' | 'trap' | 'trap-exit';
    rules?: Record<string, unknown>;
    withGlob?: boolean;
  } = {},
): string {
  const projectDir = makeScratchDir('ste-ai-hook-');
  writeFileSync(
    join(projectDir, '.textlintrc.json'),
    JSON.stringify({ rules: options.rules ?? { 'preset-ste-ai': true } }),
  );
  if (options.ignore !== undefined) {
    writeFileSync(join(projectDir, '.textlintignore'), options.ignore);
  }
  installStubTextlint(projectDir, options);
  return projectDir;
}

function readCalls(projectDir: string): Array<{ args: string[]; cwd: string; stdin: string }> {
  const callLog = join(projectDir, '.stub-calls.jsonl');
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ESRCH'
      ) {
        return;
      }
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for process ${pid} to exit`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(() => {
  for (const scratchDir of scratchDirs.splice(0)) {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

describe('block-noncompliant-prose hook', () => {
  it(
    'passes an edit that introduces no new preset finding',
    () => {
      const result = runHook({
        tool_name: 'Edit',
        tool_input: {
          file_path: targetFile,
          old_string: '## textlint adapter',
          new_string: '## textlint adapter (renamed)',
        },
      });
      expect(result.status).toBe(0);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'blocks a real textlint finding and reports its rule',
    () => {
      const result = runHook({
        tool_name: 'Edit',
        tool_input: {
          file_path: targetFile,
          old_string: '## textlint adapter',
          new_string:
            '## textlint adapter\n\nThis sentence, has, too, many, commas, and, keeps, going, ' +
            'well, past, the, accepted, limit.',
        },
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('ste-ai/');
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'blocks a swapped finding even when the total stays flat',
    () => {
      const projectDir = makeStubProject();
      const filePath = join(projectDir, 'doc.md');
      writeFileSync(filePath, 'STE_ONE\n');
      const result = runProjectHook(projectDir, {
        tool_name: 'Write',
        tool_input: { file_path: filePath, content: 'STE_TWO\n' },
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('second violation');
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it('fails open for malformed or non-object hook input', () => {
    expect(runHookRaw('{not-json').status).toBe(0);
    expect(runHookRaw('null').status).toBe(0);
  });

  it('skips non-lowercase-.md and non-Write/Edit events before linting', () => {
    const projectDir = makeStubProject();
    const textFile = join(projectDir, 'doc.txt');
    const uppercaseMarkdownFile = join(projectDir, 'doc.MD');
    const markdownFile = join(projectDir, 'doc.md');
    writeFileSync(textFile, 'old');
    writeFileSync(uppercaseMarkdownFile, 'old');
    writeFileSync(markdownFile, 'old');

    expect(
      runProjectHook(projectDir, {
        tool_name: 'Edit',
        tool_input: { file_path: textFile, old_string: 'old', new_string: 'STE_VIOLATION' },
      }).status,
    ).toBe(0);
    expect(
      runProjectHook(projectDir, {
        tool_name: 'Edit',
        tool_input: {
          file_path: uppercaseMarkdownFile,
          old_string: 'old',
          new_string: 'STE_VIOLATION',
        },
      }).status,
    ).toBe(0);
    expect(
      runProjectHook(projectDir, {
        tool_name: 'Read',
        tool_input: { file_path: markdownFile, old_string: 'old', new_string: 'STE_VIOLATION' },
      }).status,
    ).toBe(0);
    expect(readCalls(projectDir)).toHaveLength(0);
  });

  it('stops at a nested config that does not enable the preset', () => {
    const projectDir = makeStubProject();
    const nestedDir = join(projectDir, 'nested');
    mkdirSync(nestedDir);
    writeFileSync(join(nestedDir, '.textlintrc.json'), JSON.stringify({ rules: {} }));
    const filePath = join(nestedDir, 'doc.md');
    writeFileSync(filePath, 'old');

    expect(
      runProjectHook(projectDir, {
        tool_name: 'Write',
        tool_input: { file_path: filePath, content: 'STE_VIOLATION' },
      }).status,
    ).toBe(0);
    expect(readCalls(projectDir)).toHaveLength(0);
  });

  it('treats an explicitly disabled preset as disabled', () => {
    const projectDir = makeStubProject({ rules: { 'preset-ste-ai': false } });
    const filePath = join(projectDir, 'doc.md');
    writeFileSync(filePath, 'old');
    expect(
      runProjectHook(projectDir, {
        tool_name: 'Write',
        tool_input: { file_path: filePath, content: 'STE_VIOLATION' },
      }).status,
    ).toBe(0);
    expect(readCalls(projectDir)).toHaveLength(0);
  });

  it(
    'skips an existing target ignored by the real project configuration',
    () => {
      const ignoredFile = join(repoRoot, 'examples/sample.md');
      const result = runHook({
        tool_name: 'Write',
        tool_input: {
          file_path: ignoredFile,
          content: `${readFileSync(ignoredFile, 'utf8')}\nThis, has, many, extra, commas, today.\n`,
        },
      });
      expect(result.status).toBe(0);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it('skips a first write covered by a recursive ignore pattern', () => {
    const projectDir = makeStubProject({ ignore: 'ignored/**\n' });
    const filePath = join(projectDir, 'ignored/new.md');
    expect(
      runProjectHook(projectDir, {
        tool_name: 'Write',
        tool_input: { file_path: filePath, content: 'STE_VIOLATION' },
      }).status,
    ).toBe(0);
    expect(readCalls(projectDir)).toHaveLength(0);
  });

  it('matches trailing-slash directory patterns exactly like the pinned CLI', () => {
    const shallowProject = makeStubProject({ ignore: 'generated/\n' });
    const shallowPath = join(shallowProject, 'generated/doc.md');
    expect(
      runProjectHook(shallowProject, {
        tool_name: 'Write',
        tool_input: { file_path: shallowPath, content: 'STE_VIOLATION' },
      }).status,
    ).toBe(2);
    expect(readCalls(shallowProject)).toHaveLength(1);

    const recursiveProject = makeStubProject({ ignore: 'generated/**\n' });
    const recursivePath = join(recursiveProject, 'generated/doc.md');
    expect(
      runProjectHook(recursiveProject, {
        tool_name: 'Write',
        tool_input: { file_path: recursivePath, content: 'STE_VIOLATION' },
      }).status,
    ).toBe(0);
    expect(readCalls(recursiveProject)).toHaveLength(0);
  });

  it('treats a leading exclamation mark as a literal ignore pattern', () => {
    const projectDir = makeStubProject({ ignore: '!kept.md\n' });
    const filePath = join(projectDir, 'other.md');
    expect(
      runProjectHook(projectDir, {
        tool_name: 'Write',
        tool_input: { file_path: filePath, content: 'STE_VIOLATION' },
      }).status,
    ).toBe(2);
  });

  it('uses stdin with the real target filename and the selected config directory', () => {
    const projectDir = makeStubProject();
    const filePath = join(projectDir, 'doc.md');
    writeFileSync(filePath, 'Existing content.\n');
    const proposed = 'STE_VIOLATION\n';
    expect(
      runProjectHook(projectDir, {
        tool_name: 'Write',
        tool_input: { file_path: filePath, content: proposed },
      }).status,
    ).toBe(2);

    const calls = readCalls(projectDir);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.stdin)).toEqual(['Existing content.\n', proposed]);
    for (const call of calls) {
      expect(call.cwd).toBe(projectDir);
      const filenameIndex = call.args.indexOf('--stdin-filename');
      expect(filenameIndex).toBeGreaterThanOrEqual(0);
      expect(call.args[filenameIndex + 1]).toBe(filePath);
      expect(call.args).toContain('--stdin');
    }
    expect(readdirSync(projectDir).some((name) => name.startsWith('.ste-ai-hook-'))).toBe(false);
  });

  it('blocks a violating first write without linting the empty baseline', () => {
    const projectDir = makeStubProject();
    const filePath = join(projectDir, 'new.md');
    expect(
      runProjectHook(projectDir, {
        tool_name: 'Write',
        tool_input: { file_path: filePath, content: 'STE_VIOLATION' },
      }).status,
    ).toBe(2);
    expect(readCalls(projectDir)).toHaveLength(1);
    expect(existsSync(filePath)).toBe(false);
  });

  it(
    'blocks a violating first write with the real pinned textlint CLI',
    () => {
      const filePath = join(repoRoot, 'docs/.ste-ai-real-first-write-test.md');
      expect(existsSync(filePath)).toBe(false);
      const result = runHook({
        tool_name: 'Write',
        tool_input: {
          file_path: filePath,
          content: 'This, sentence, has, too, many, commas, for, this, project, today.\n',
        },
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('ste-ai/punctuation-constraints');
      expect(existsSync(filePath)).toBe(false);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it("ignores a sibling rule's newly introduced finding", () => {
    const projectDir = makeStubProject({
      rules: { 'preset-ste-ai': true, 'other-rule': true },
    });
    const filePath = join(projectDir, 'doc.md');
    writeFileSync(filePath, 'Existing content.\n');
    expect(
      runProjectHook(projectDir, {
        tool_name: 'Write',
        tool_input: { file_path: filePath, content: 'OTHER_VIOLATION\n' },
      }).status,
    ).toBe(0);
    expect(readCalls(projectDir)).toHaveLength(2);
  });

  it('blocks the same fixture when the new ruleId belongs to ste-ai', () => {
    const projectDir = makeStubProject();
    const filePath = join(projectDir, 'doc.md');
    writeFileSync(filePath, 'Existing content.\n');
    expect(
      runProjectHook(projectDir, {
        tool_name: 'Write',
        tool_input: { file_path: filePath, content: 'STE_VIOLATION\n' },
      }).status,
    ).toBe(2);
  });

  it('fails open before linting when the target matcher cannot load', () => {
    const projectDir = makeStubProject({ withGlob: false });
    const filePath = join(projectDir, 'doc.md');
    writeFileSync(filePath, 'Existing content.\n');
    expect(
      runProjectHook(projectDir, {
        tool_name: 'Write',
        tool_input: { file_path: filePath, content: 'STE_VIOLATION\n' },
      }).status,
    ).toBe(0);
    expect(readCalls(projectDir)).toHaveLength(0);
  });

  it('resolves textlint and glob from the target when the hook is copied elsewhere', () => {
    const projectDir = makeStubProject();
    const copiedHookDir = makeScratchDir('ste-ai-hook-copy-');
    const copiedHookPath = join(copiedHookDir, 'hook.cjs');
    copyFileSync(hookPath, copiedHookPath);
    const filePath = join(projectDir, 'new.md');
    expect(
      runProjectHook(
        projectDir,
        { tool_name: 'Write', tool_input: { file_path: filePath, content: 'STE_VIOLATION' } },
        copiedHookPath,
      ).status,
    ).toBe(2);
    expect(readCalls(projectDir)).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')(
    'escalates a trapped timeout and rejects valid-looking partial output',
    () => {
      const projectDir = makeStubProject({ mode: 'trap' });
      const filePath = join(projectDir, 'doc.md');
      writeFileSync(filePath, 'Existing content.\n');
      const startedAt = Date.now();
      const result = runProjectHook(projectDir, {
        tool_name: 'Write',
        tool_input: { file_path: filePath, content: 'STE_VIOLATION\n' },
      });
      const elapsed = Date.now() - startedAt;
      expect(result.status).toBe(0);
      expect(elapsed).toBeGreaterThanOrEqual(19_000);
      expect(elapsed).toBeLessThan(28_000);
      expect(readCalls(projectDir)).toHaveLength(1);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a valid report from a process that exits only after the timeout',
    () => {
      const projectDir = makeStubProject({ mode: 'trap-exit' });
      const filePath = join(projectDir, 'doc.md');
      writeFileSync(filePath, 'Existing content.\n');
      const startedAt = Date.now();
      const result = runProjectHook(projectDir, {
        tool_name: 'Write',
        tool_input: { file_path: filePath, content: 'STE_VIOLATION\n' },
      });
      const elapsed = Date.now() - startedAt;
      expect(result.status).toBe(0);
      expect(elapsed).toBeGreaterThanOrEqual(19_000);
      expect(elapsed).toBeLessThan(25_000);
      expect(readCalls(projectDir)).toHaveLength(1);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it.skipIf(process.platform === 'win32')(
    'terminates an in-flight lint promptly when the hook receives SIGTERM',
    async () => {
      const projectDir = makeStubProject({ mode: 'trap' });
      const filePath = join(projectDir, 'doc.md');
      writeFileSync(filePath, 'Existing content.\n');
      const child = spawn(process.execPath, [hookPath], {
        cwd: repoRoot,
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: false,
      });
      const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
      let lintPid: number | undefined;
      let lintVerifiedGone = false;
      try {
        child.stdin.end(
          JSON.stringify({
            tool_name: 'Write',
            cwd: projectDir,
            tool_input: { file_path: filePath, content: 'STE_VIOLATION\n' },
          }),
        );
        await waitForFile(join(projectDir, '.stub-started'));
        lintPid = Number(readFileSync(join(projectDir, '.stub-pid'), 'utf8'));
        expect(Number.isInteger(lintPid)).toBe(true);
        const signalledAt = Date.now();
        child.kill('SIGTERM');
        expect(await exited).toBe(0);
        expect(Date.now() - signalledAt).toBeLessThan(5_000);
        await waitForProcessExit(lintPid);
        lintVerifiedGone = true;
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await Promise.race([
          exited,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
        ]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (lintPid !== undefined && !lintVerifiedGone) {
          try {
            process.kill(-lintPid, 'SIGKILL');
          } catch {
            // The lint process may already have exited during hook cleanup.
          }
        }
      }
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'never leaves hidden scratch content beside a blocked real target',
    () => {
      const before = readdirSync(join(repoRoot, 'docs')).filter((name) =>
        name.startsWith('.ste-ai-hook-'),
      );
      const result = runHook({
        tool_name: 'Write',
        tool_input: {
          file_path: targetFile,
          content: 'This, has, too, many, commas, for, the, configured, rule, today.\n',
        },
      });
      const after = readdirSync(join(repoRoot, 'docs')).filter((name) =>
        name.startsWith('.ste-ai-hook-'),
      );
      expect(result.status).toBe(2);
      expect(after).toEqual(before);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );
});
