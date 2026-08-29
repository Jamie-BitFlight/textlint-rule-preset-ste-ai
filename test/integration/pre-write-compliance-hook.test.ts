import { execSync, spawn, spawnSync } from 'node:child_process';
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

  // Regression (independent review of PR #122): the first `SIGTERM`/`SIGINT` handler was
  // registered against a hook that still used `execFileSync`, which blocks the Node.js event
  // loop for the whole child process's duration -- so the handler could never actually run while
  // a child was in flight, reproduced directly with an isolated `execFileSync` + `SIGTERM` repro
  // (the handler's own log line never printed). Switching to async `spawn`, `detached: true`, and
  // a process-group kill (`process.kill(-child.pid, signal)`) fixed the underlying problem: a
  // plain `child.kill()` only reaches the immediate child, not a shell-wrapping grandchild that
  // keeps the stdout pipe open (this suite's own stub `textlint` is exactly such a shell script).
  // This case pins the externally observable behavior the fix promises: a real `SIGTERM` sent to
  // a hook that is mid-check kills it and its whole child tree promptly, leaving no scratch file
  // behind, rather than running the hook's own hang-timeout out to completion.
  it(
    'exits promptly and cleans up its scratch file on SIGTERM',
    async () => {
      const scratchProject = mkdtempSync(join(tmpdir(), 'ste-ai-hook-sigterm-'));
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

        const child = spawn('node', [hookScript], { cwd: repoRoot });
        child.stdin.end(
          JSON.stringify({
            tool_name: 'Write',
            tool_input: {
              file_path: targetPath,
              content: 'New content, with, way, too, many, commas, right, here, now.\n',
            },
          }),
        );

        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => {
            child.on('close', (code, signal) => resolve({ code, signal }));
          },
        );

        // Give the stub textlint's sleep a moment to actually start before killing the hook,
        // rather than racing process startup.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        child.kill('SIGTERM');

        const started = Date.now();
        await exited;
        const elapsedMs = Date.now() - started;

        // Well under both the hook's own 15s textlint timeout and the stub's 120s sleep -- proves
        // SIGTERM actually interrupted the in-flight child rather than the hook running either
        // of those out to completion.
        expect(elapsedMs).toBeLessThan(5_000);
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

  // Regression (independent review of PR #122, round 6): the timeout handler sent one `SIGTERM`
  // and then waited on `close` forever, so a `textlint` (or a rule/plugin it loads) that traps or
  // ignores `SIGTERM` left the hook running well past its own documented 15s limit -- reproduced
  // directly with a stub that runs `trap '' TERM` before sleeping: the hook stayed alive until an
  // external `timeout` wrapper killed it, confirmed still blocking well past 15s. `SIGKILL` cannot
  // be trapped or ignored by any process, so escalating to it after `SIGKILL_GRACE_MS` is what
  // actually bounds the hook's own worst-case runtime; this case pins that the hook now fails open
  // within `TEXTLINT_TIMEOUT_MS + SIGKILL_GRACE_MS` (with headroom) even against a trapping child.
  it(
    'escalates to SIGKILL and fails open when textlint traps SIGTERM',
    () => {
      const scratchProject = mkdtempSync(join(tmpdir(), 'ste-ai-hook-sigterm-trap-'));
      try {
        mkdirSync(join(scratchProject, 'node_modules', '.bin'), { recursive: true });
        writeFileSync(
          join(scratchProject, '.textlintrc.json'),
          JSON.stringify({ rules: { 'preset-ste-ai': true } }),
        );
        const stubTextlintPath = join(scratchProject, 'node_modules', '.bin', 'textlint');
        writeFileSync(stubTextlintPath, "#!/usr/bin/env bash\ntrap '' TERM\nsleep 60\n");
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
        // 15s (TEXTLINT_TIMEOUT_MS) + 3s (SIGKILL_GRACE_MS), with headroom -- well short of the
        // stub's own 60s sleep, proving SIGKILL actually ended it rather than the sleep completing.
        expect(elapsedMs).toBeLessThan(25_000);
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

  // Regression (independent review of PR #122, round 4): `tryLoadMinimatch` used a bare
  // `require('minimatch')`, which resolves relative to this hook script's own file location and
  // its ancestors -- correct only by coincidence when the hook happens to run from inside this
  // repository's own checkout. Once installed as a real Claude Code plugin (see PLUGIN.md's
  // "Installing this plugin elsewhere"), the hook script lives in the plugin's own location, not
  // the target project's, so that ancestry holds none of the target project's dependencies even
  // though the target project's own `textlint` install carries `minimatch` transitively through
  // `glob`. `isIgnoredByTextlint` would then always fail to resolve `minimatch`, silently treat
  // every target as not ignored, and let the hook block a write an ordinary `textlint` run would
  // skip. Reproduced directly here by copying the hook script to a scratch directory with no
  // `node_modules` of its own anywhere in its ancestry, spawning it from there (`cwd` still this
  // repository, exactly as Claude Code would run an installed plugin's hook against a real
  // project), and confirming it still recognizes this repository's own `examples/sample.md` as
  // ignored -- before `tryLoadMinimatch` was changed to resolve starting from the target
  // project's own `configDir` instead of from the hook script's location.
  it(
    "resolves minimatch from the target project, not the hook script's own location",
    () => {
      const scratchHookDir = mkdtempSync(join(tmpdir(), 'ste-ai-hook-copied-elsewhere-'));
      try {
        const copiedHookPath = join(scratchHookDir, 'block-noncompliant-prose.cjs');
        writeFileSync(copiedHookPath, readFileSync(`${repoRoot}${hookScript}`, 'utf8'));
        const ignoredTargetFile = `${repoRoot}examples/sample.md`;
        const originalContent = readFileSync(ignoredTargetFile, 'utf8');
        const result = spawnSync('node', [copiedHookPath], {
          cwd: repoRoot,
          input: JSON.stringify({
            tool_name: 'Write',
            tool_input: {
              file_path: ignoredTargetFile,
              content: `${originalContent}\n\nThis, sentence, has, way, too, many, commas, in, it, right, here, now.\n`,
            },
          }),
          encoding: 'utf8',
        });
        expect(result.status).toBe(0);
      } finally {
        rmSync(scratchHookDir, { recursive: true, force: true });
      }
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  // Regression (independent review of PR #122, round 5): `tryLoadMinimatch` resolved `minimatch`
  // only from `configDir` itself. That works for a flat, hoisted npm install (every transitive
  // dependency copied up to the project's own top-level `node_modules`), but not an isolated
  // install (pnpm's default): there, `configDir/node_modules` holds only the project's own direct
  // dependencies (`textlint`, if declared) -- never `textlint`'s own dependency on `glob`, nor
  // `glob`'s own dependency on `minimatch`. Reproduced directly with the constructed layout below
  // (each package's `node_modules` populated only with its own declared dependencies, `minimatch`
  // absent from the project root) before `tryLoadMinimatch` was changed to walk the real
  // dependency chain instead: `configDir` to `textlint` to `glob` to `minimatch`.
  //
  // The stub `textlint` binary here is not just a placeholder: it fabricates a lint finding that
  // exists only on its *second* invocation (a call counter written to a state file), so a hook run
  // that fails to resolve `minimatch` and falls through to the ordinary before/after check reaches
  // that fabricated finding and blocks (exit 2) -- distinguishing "the ignore check silently
  // failed and the hook proceeded anyway" from "the ignore check correctly short-circuited before
  // ever invoking textlint" (exit 0), which a stub that always failed open could not distinguish.
  it(
    'resolves minimatch through an isolated (pnpm-style) dependency layout',
    () => {
      const scratchProject = mkdtempSync(join(tmpdir(), 'ste-ai-hook-isolated-deps-'));
      try {
        writeFileSync(
          join(scratchProject, '.textlintrc.json'),
          JSON.stringify({ rules: { 'preset-ste-ai': true } }),
        );
        writeFileSync(join(scratchProject, '.textlintignore'), 'ignored.md\n');

        const binDir = join(scratchProject, 'node_modules', '.bin');
        mkdirSync(binDir, { recursive: true });
        const stubTextlintPath = join(binDir, 'textlint');
        writeFileSync(
          stubTextlintPath,
          [
            '#!/usr/bin/env bash',
            'STATE="$(dirname "$0")/../../.call-count"',
            'N=0',
            'if [ -f "$STATE" ]; then N=$(cat "$STATE"); fi',
            'N=$((N+1))',
            'echo "$N" > "$STATE"',
            'if [ "$N" = "1" ]; then',
            '  echo \'[{"filePath":"x","messages":[]}]\'',
            'else',
            '  echo \'[{"filePath":"x","messages":[{"ruleId":"stub-rule","message":"stub new finding","severity":2,"line":1,"column":1}]}]\'',
            'fi',
            '',
          ].join('\n'),
        );
        chmodSync(stubTextlintPath, 0o755);

        // Isolated layout: scratchProject/node_modules holds only `textlint`. `textlint`'s own
        // node_modules holds `glob`. `glob`'s own node_modules holds `minimatch`, never hoisted to
        // the project root. `minimatch` here is a minimal standalone stand-in, not the real
        // package: this test is about whether `tryLoadMinimatch`'s resolution chain reaches
        // whatever sits at that path, not about the real package's own matching logic (the real
        // package is exercised elsewhere, via this repository's own flat install) -- and the real
        // package pulls in its own further transitive dependency (`brace-expansion`), which a bare
        // copy of just its own directory would leave unresolvable, unrelated to what this test
        // means to prove.
        const textlintDir = join(scratchProject, 'node_modules', 'textlint');
        mkdirSync(textlintDir, { recursive: true });
        writeFileSync(join(textlintDir, 'package.json'), JSON.stringify({ name: 'textlint' }));
        const globDir = join(textlintDir, 'node_modules', 'glob');
        mkdirSync(globDir, { recursive: true });
        writeFileSync(join(globDir, 'package.json'), JSON.stringify({ name: 'glob' }));
        const minimatchDir = join(globDir, 'node_modules', 'minimatch');
        mkdirSync(minimatchDir, { recursive: true });
        writeFileSync(
          join(minimatchDir, 'package.json'),
          JSON.stringify({ name: 'minimatch', main: 'index.js' }),
        );
        writeFileSync(
          join(minimatchDir, 'index.js'),
          'exports.minimatch = (targetPath, pattern) => targetPath === pattern;\n',
        );

        // `cwd` must be `scratchProject`, not `repoRoot`: `isIgnoredByTextlint` reads
        // `.textlintignore` from `process.cwd()` and computes the target's path relative to it, so
        // running from `repoRoot` would look at this repository's own ignore file instead of the
        // scratch project's.
        const result = spawnSync('node', [`${repoRoot}${hookScript}`], {
          cwd: scratchProject,
          input: JSON.stringify({
            tool_name: 'Write',
            tool_input: {
              file_path: join(scratchProject, 'ignored.md'),
              content: 'This, sentence, has, way, too, many, commas, in, it, right, here, now.\n',
            },
          }),
          encoding: 'utf8',
        });
        expect(result.status).toBe(0);
      } finally {
        rmSync(scratchProject, { recursive: true, force: true });
      }
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  // Regression (independent review of PR #122, round 6): `isIgnoredByTextlint` called `minimatch`
  // without `nonegate: true`, so a `.textlintignore` entry starting with `!` (such as `!kept.md`)
  // was read with minimatch's default negation semantics -- "ignore every path except `kept.md`"
  // -- the opposite of what `glob`'s own ignore matching does with that same line: both `glob.js`
  // and its `ignore.js` helper hardcode `nonegate: true` on every ignore-pattern `Minimatch`
  // instance, treating a leading `!` as a literal character nothing ordinarily matches. Reproduced
  // directly: `minimatch('other.md', '!kept.md')` is `true` without `nonegate`, `false` with it.
  // This case pins the fixed behavior: a `!`-prefixed ignore entry no longer makes every other file
  // appear ignored.
  it(
    "matches a leading-`!` .textlintignore entry the way glob's own nonegate semantics do",
    () => {
      const scratchProject = mkdtempSync(join(tmpdir(), 'ste-ai-hook-nonegate-'));
      try {
        writeFileSync(
          join(scratchProject, '.textlintrc.json'),
          JSON.stringify({ rules: { 'preset-ste-ai': true } }),
        );
        writeFileSync(join(scratchProject, '.textlintignore'), '!kept.md\n');
        mkdirSync(join(scratchProject, 'node_modules', '.bin'), { recursive: true });
        // Reports a finding only on its *second* invocation (a call counter written to a state
        // file), so exit code alone distinguishes the two possible outcomes: reaching this stub at
        // all (correct -- `other.md` is not ignored) blocks with the fabricated new finding
        // (exit 2), while the negation bug this pins against short-circuits before the stub is
        // ever invoked (exit 0). A stub reporting the same finding on both calls could not tell
        // those two outcomes apart, since both would exit 0.
        writeFileSync(
          join(scratchProject, 'node_modules', '.bin', 'textlint'),
          [
            '#!/usr/bin/env bash',
            'STATE="$(dirname "$0")/../../.call-count"',
            'N=0',
            'if [ -f "$STATE" ]; then N=$(cat "$STATE"); fi',
            'N=$((N+1))',
            'echo "$N" > "$STATE"',
            'if [ "$N" = "1" ]; then',
            '  echo \'[{"filePath":"x","messages":[]}]\'',
            'else',
            '  echo \'[{"filePath":"x","messages":[{"ruleId":"stub-rule","message":"stub new finding","severity":2,"line":1,"column":1}]}]\'',
            'fi',
            '',
          ].join('\n'),
        );
        chmodSync(join(scratchProject, 'node_modules', '.bin', 'textlint'), 0o755);

        // A resolvable `minimatch` stand-in that actually implements the `nonegate` option this
        // case exists to pin -- without it, `tryLoadMinimatch` cannot resolve any `minimatch` at
        // all from this scratch directory (it shares no `node_modules` ancestry with this
        // repository), so `isIgnoredByTextlint` would fail open to "not ignored" regardless of
        // whether the option is passed, and this case could not tell the fixed behavior from the
        // bug (verified directly: without this stand-in, the case passed even against the
        // pre-fix hook, because both paths hit that same unrelated fail-open). This stand-in
        // implements only the literal-vs-negation distinction the real `glob`/`minimatch` make for
        // a leading `!`, nothing more -- real `minimatch`'s own glob-matching correctness is
        // exercised elsewhere, via this repository's own flat install.
        const minimatchDir = join(scratchProject, 'node_modules', 'minimatch');
        mkdirSync(minimatchDir, { recursive: true });
        writeFileSync(
          join(minimatchDir, 'package.json'),
          JSON.stringify({ name: 'minimatch', main: 'index.js' }),
        );
        writeFileSync(
          join(minimatchDir, 'index.js'),
          [
            'exports.minimatch = (targetPath, pattern, options) => {',
            '  const nonegate = options && options.nonegate === true;',
            "  if (pattern.startsWith('!') && !nonegate) {",
            '    return targetPath !== pattern.slice(1);',
            '  }',
            '  return targetPath === pattern;',
            '};',
            '',
          ].join('\n'),
        );

        // `cwd` must be `scratchProject`, not `repoRoot`: `isIgnoredByTextlint` reads
        // `.textlintignore` from `process.cwd()` and computes the target's path relative to it.
        const result = spawnSync('node', [`${repoRoot}${hookScript}`], {
          cwd: scratchProject,
          input: JSON.stringify({
            tool_name: 'Write',
            tool_input: {
              file_path: join(scratchProject, 'other.md'),
              content: 'This, sentence, has, way, too, many, commas, in, it, right, here, now.\n',
            },
          }),
          encoding: 'utf8',
        });
        // Nonegate semantics: `!kept.md` never matches `other.md`, so `other.md` is not ignored
        // and reaches the ordinary before/after check, which the stub's second-call finding
        // blocks.
        expect(result.status).toBe(2);
      } finally {
        rmSync(scratchProject, { recursive: true, force: true });
      }
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
