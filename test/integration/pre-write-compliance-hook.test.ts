import { execSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

/**
 * `hooks/block-noncompliant-prose.cjs` is a Claude Code `PreToolUse` hook shipped by this
 * repository's own plugin (`.claude-plugin/plugin.json`): it blocks a `Write`/`Edit` call that
 * would introduce a ste-ai lint finding a markdown file does not already carry, even when a
 * different pre-existing finding drops out and the total error count does not rise. It has
 * no unit test of its own kind — it only runs as a subprocess fed a JSON event on stdin — so these
 * cases run the real script the same way Claude Code does, against this repository's own real
 * `.textlintrc.json` and `docs/architecture.md`.
 *
 * The diffing logic inside the hook was wrong on its first draft: it took `after.slice(before
 * .length)` to mean "the new findings", which actually reports whichever findings end up at the
 * tail of the *sorted-by-position* list — a pre-existing finding on a later line, shifted only
 * because an earlier insertion moved every subsequent line down, not a genuinely new one. Verified
 * directly by inserting a run-on sentence and diffing the real message sets by hand before fixing
 * the hook to use a multiset diff keyed on `ruleId` + `message` instead. The case below pins that
 * the reported findings are the real new ones, not shifted old ones.
 */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const hookScript = 'hooks/block-noncompliant-prose.cjs';
const targetFile = `${repoRoot}docs/architecture.md`;

function runHook(event: unknown): { status: number | null; stderr: string } {
  return runHookRaw(JSON.stringify(event));
}

function runHookRaw(stdin: string): { status: number | null; stderr: string } {
  const result = spawnSync('node', [hookScript], {
    cwd: repoRoot,
    input: stdin,
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr };
}

// Each case here spawns the hook as a real subprocess, which itself spawns real `textlint` runs
// (once or twice) -- inherently slower than the default test budget under full-suite parallel
// load. Verified flaky at the default 20s timeout: 3 of 8 full-suite runs failed with
// `Test timed out in 20000ms`, none with an assertion failure, while every isolated run of this
// file alone passed -- CPU contention from the rest of the suite running concurrently, not a
// logic bug. 60s leaves headroom.
const SUBPROCESS_TEST_TIMEOUT_MS = 60_000;

describe('block-noncompliant-prose hook', () => {
  it(
    'passes an edit that introduces no new lint errors',
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
    'blocks an edit that introduces new lint errors, reporting the real new findings',
    () => {
      const result = runHook({
        tool_name: 'Edit',
        tool_input: {
          file_path: targetFile,
          old_string: '## textlint adapter',
          new_string:
            '## textlint adapter\n\n' +
            'This sentence, which has, way too many, commas, in, it, is bad, style, and, should, ' +
            'be, blocked, by, the, hook, immediately, without, any, hesitation, whatsoever, today.',
        },
      });
      expect(result.status).toBe(2);
      // The genuinely new findings, not a pre-existing finding whose line shifted.
      expect(result.stderr).toContain('This sentence has 20 commas');
      expect(result.stderr).toContain('ste-ai/punctuation-constraints');
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'passes an edit that reduces the file’s existing lint-error count',
    () => {
      const content = readFileSync(targetFile, 'utf8');
      const oldString =
        '`evaluation` is deliberately its own module rather than part of `fixture-tools`. Measuring an\n' +
        'evaluator requires running the real rule set and the real broker, so it needs almost every layer;\n' +
        'keeping it separate lets `fixture-tools` — which the library itself uses for corpus validation — stay\n' +
        'restricted to `core` and `rule-pack`.';
      expect(content).toContain(oldString);
      const result = runHook({
        tool_name: 'Edit',
        tool_input: {
          file_path: targetFile,
          old_string: oldString,
          new_string:
            '`evaluation` is its own module, separate from `fixture-tools`. Measuring an ' +
            'evaluator needs the real rule set and broker. `fixture-tools` is used for corpus ' +
            'validation. It stays restricted to `core` and `rule-pack`.',
        },
      });
      expect(result.status).toBe(0);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'ignores a non-markdown file',
    () => {
      const result = runHook({
        tool_name: 'Edit',
        tool_input: {
          file_path: `${repoRoot}src/textlint/adapter.ts`,
          old_string: 'foo',
          new_string: 'bar, bar, bar, bar, bar, bar',
        },
      });
      expect(result.status).toBe(0);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'ignores a tool other than Write or Edit',
    () => {
      const result = runHook({
        tool_name: 'Read',
        tool_input: { file_path: targetFile },
      });
      expect(result.status).toBe(0);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  // Regression (independent review of PR #122): `JSON.parse('null')` is valid JSON and does not
  // throw, but a bare `event.tool_name` property access on `null` does. That crashed the hook with
  // an uncaught TypeError and exit code 1, directly contradicting its own documented "any
  // unexpected error fails open (exit 0)" guarantee. Reproduced directly with `echo 'null' | node
  // hooks/block-noncompliant-prose.cjs` before the `typeof event !== 'object' || event === null`
  // guard was added.
  it(
    'fails open on a syntactically valid but non-object JSON event (null)',
    () => {
      const result = runHookRaw('null');
      expect(result.status).toBe(0);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  // Regression (independent review of PR #122): `execFileSync` had no `timeout` option, so a hung
  // `textlint` process (or a hung rule/plugin it loads) blocked the hook, and therefore every
  // subsequent Write/Edit in the session, indefinitely. Reproduced directly with a stub `textlint`
  // binary that sleeps. This case proves both that the hook now self-terminates well inside the
  // 60s test budget, and that it leaves no `.ste-ai-hook-*` scratch file behind in the target
  // project when it does.
  //
  // `isIgnoredByTextlint` matches `.textlintignore` patterns directly (`minimatch`, no subprocess),
  // so the stub `textlint` binary is only ever reached by `countErrors`'s own `before` call. That
  // single `TEXTLINT_TIMEOUT_MS`-bounded call is what the elapsed-time assertion below budgets for;
  // the `after` call never runs, since the first call's timeout throws past `main`'s own try, which
  // fails open right away.
  it(
    'fails open, without hanging, when textlint itself hangs',
    () => {
      const scratchProject = mkdtempSync(join(tmpdir(), 'ste-ai-hook-hang-'));
      try {
        mkdirSync(join(scratchProject, 'node_modules', '.bin'), { recursive: true });
        writeFileSync(
          join(scratchProject, '.textlintrc.json'),
          JSON.stringify({ rules: { 'preset-ste-ai': true } }),
        );
        const stubTextlintPath = join(scratchProject, 'node_modules', '.bin', 'textlint');
        writeFileSync(stubTextlintPath, '#!/usr/bin/env bash\nsleep 120\n');
        chmodSync(stubTextlintPath, 0o755);
        const targetPath = join(scratchProject, 'doc.md');
        writeFileSync(targetPath, 'Existing content.\n');

        const started = Date.now();
        const result = runHook({
          tool_name: 'Write',
          tool_input: {
            file_path: targetPath,
            content: 'New content, with, way, too, many, commas, right, here, now.\n',
          },
        });
        const elapsedMs = Date.now() - started;

        expect(result.status).toBe(0);
        // Well under the 60s test budget -- the hook's own single ~15s textlint timeout, not the
        // test timeout, should be what ends this.
        expect(elapsedMs).toBeLessThan(30_000);
        const leftovers = readdirSync(scratchProject).filter((name) =>
          name.startsWith('.ste-ai-hook-'),
        );
        expect(leftovers).toEqual([]);
      } finally {
        rmSync(scratchProject, { recursive: true, force: true });
      }
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'ignores a markdown file outside any ste-ai-configured project',
    () => {
      const result = runHook({
        tool_name: 'Write',
        tool_input: {
          file_path: '/tmp/no-ste-ai-project-marker/whatever.md',
          content: 'This, sentence, has, way, too, many, commas, in, it.\n',
        },
      });
      expect(result.status).toBe(0);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  // Regression (independent review of PR #122): the config walk used to keep climbing past a
  // config that did not mention `preset-ste-ai`, so a nested project's own opt-out config was
  // silently overridden by a parent directory's config that did enable the preset. Reproduced
  // directly with the layout below before `findSteAiConfigDir` was changed to stop at the first
  // readable config instead of only the first matching one.
  it(
    "stops at a nested project's own textlint config instead of a parent's",
    () => {
      const parentProject = mkdtempSync(join(tmpdir(), 'ste-ai-hook-parent-'));
      try {
        writeFileSync(
          join(parentProject, '.textlintrc.json'),
          JSON.stringify({ rules: { 'preset-ste-ai': true } }),
        );
        const nestedProject = join(parentProject, 'nested-project');
        mkdirSync(nestedProject, { recursive: true });
        writeFileSync(join(nestedProject, '.textlintrc.json'), JSON.stringify({ rules: {} }));
        const targetPath = join(nestedProject, 'doc.md');
        writeFileSync(targetPath, 'Existing content.\n');

        const result = runHook({
          tool_name: 'Write',
          tool_input: {
            file_path: targetPath,
            content: 'This, sentence, has, way, too, many, commas, in, it, right, here, now.\n',
          },
        });
        expect(result.status).toBe(0);
      } finally {
        rmSync(parentProject, { recursive: true, force: true });
      }
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  // Regression (independent review of PR #122, round 2): the config match was a plain
  // `raw.includes('preset-ste-ai')` substring search, so `"rules": { "preset-ste-ai": false }` —
  // the ordinary way to disable any textlint rule — still counted as enabling this hook, because
  // the preset's own name is still present in the file text even while turned off. Reproduced
  // directly with the config below before `findSteAiConfigDir` was changed to parse the config and
  // check the rule's actual value.
  it(
    'treats "preset-ste-ai": false as disabled, not merely mentioned',
    () => {
      const scratchProject = mkdtempSync(join(tmpdir(), 'ste-ai-hook-disabled-'));
      try {
        writeFileSync(
          join(scratchProject, '.textlintrc.json'),
          JSON.stringify({ rules: { 'preset-ste-ai': false, 'no-todo': true } }),
        );
        const targetPath = join(scratchProject, 'doc.md');
        writeFileSync(targetPath, 'Existing content.\n');

        const result = runHook({
          tool_name: 'Write',
          tool_input: {
            file_path: targetPath,
            content: 'This, sentence, has, way, too, many, commas, in, it, right, here, now.\n',
          },
        });
        expect(result.status).toBe(0);
      } finally {
        rmSync(scratchProject, { recursive: true, force: true });
      }
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  // Regression (independent review of PR #122, round 2): the hook always linted a randomly named
  // scratch file next to the real target, so a real target excluded by `.textlintignore` (this
  // repository's own `examples/sample.md`, whose whole point is to carry deliberate violations —
  // see `examples/README.md`) got checked under the scratch file's own, non-ignored identity
  // instead. That let the hook block an edit that an ordinary `textlint examples/sample.md` run
  // would silently skip. Reproduced directly against this repository's real ignore file before
  // `isIgnoredByTextlint` was added.
  it(
    'ignores a real target excluded by .textlintignore, even with many new commas',
    () => {
      const ignoredTargetFile = `${repoRoot}examples/sample.md`;
      const originalContent = readFileSync(ignoredTargetFile, 'utf8');
      const result = runHook({
        tool_name: 'Write',
        tool_input: {
          file_path: ignoredTargetFile,
          content: `${originalContent}\n\nThis, sentence, has, way, too, many, commas, in, it, right, here, now.\n`,
        },
      });
      expect(result.status).toBe(0);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  // Regression (independent review of PR #122, round 3): `isIgnoredByTextlint` used to return
  // `false` outright whenever the real target did not exist yet, since it asked the real
  // `textlint` CLI to lint the real path, and the CLI's own ignore matching (a filesystem walk)
  // can never resolve a path nothing sits at. A brand-new file's first `Write` was therefore never
  // ignore-checked, even when its path was already excluded. Reproduced directly against a fresh
  // path this repository's own `.textlintignore` would exclude (matching `fixtures/original/**`)
  // before `isIgnoredByTextlint` was switched to a `minimatch` pattern match that does not depend
  // on the target existing. The hook itself never creates the real target file (only ever a
  // randomly named scratch file beside it, and only past this ignore check), so there is nothing
  // to clean up here even when the assertion fails.
  it(
    'ignores a first write to a new path already excluded by .textlintignore',
    () => {
      const newIgnoredPath = `${repoRoot}fixtures/original/ste-ai-hook-first-write-test.md`;
      const result = runHook({
        tool_name: 'Write',
        tool_input: {
          file_path: newIgnoredPath,
          content: 'This, sentence, has, way, too, many, commas, in, it, right, here, now.\n',
        },
      });
      expect(result.status).toBe(0);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'leaves no scratch file behind after blocking',
    () => {
      runHook({
        tool_name: 'Write',
        tool_input: {
          file_path: `${repoRoot}docs/architecture.md`,
          content: 'This, sentence, has, way, too, many, commas, in, it, and, more, and, more.\n',
        },
      });
      const leftovers = execSync('git status --short', { cwd: repoRoot, encoding: 'utf8' });
      expect(leftovers).not.toContain('.ste-ai-hook-');
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );
});
