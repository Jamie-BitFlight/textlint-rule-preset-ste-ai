#!/usr/bin/env node
'use strict';

/**
 * PreToolUse hook — blocks a Write or Edit call that would introduce a ste-ai
 * (`textlint-rule-preset-ste-ai`) lint finding a markdown file does not already carry.
 *
 * Scope: only engages in a project that actually configures this preset. The nearest
 * `.textlintrc.json` walking up from the target file is authoritative — it must actually enable
 * `preset-ste-ai` (a `"preset-ste-ai": false` entry does not count as enabling it, even though
 * the preset's own name appears in the file); a config further up the tree does not count once a
 * nearer one exists, even when that nearer config disables or omits the preset. Only `.md` files
 * are ever in scope, and only a file `textlint` itself would not skip — a target excluded by
 * `.textlintignore`, whether it exists yet or this write would create it, is left alone the same
 * way an ordinary `textlint` run leaves it alone. A file that already carries pre-existing errors
 * is not blocked from every future edit —
 * only from an edit that introduces a finding the file did not already have. This mirrors
 * `scripts/ci/check-dogfood-lint.mjs`'s own ratchet in this repo ("the ratchet only ever
 * shrinks"), keyed on the exact finding (its rule plus its message) rather than on a raw error
 * count: swapping one finding for a different one blocks the write even when the total count of
 * errors does not rise.
 *
 * Exits code 2 (block + feedback to the agent) when the would-be content carries a genuinely new
 * finding the current on-disk content does not have. Exits code 0 (pass) otherwise, including
 * whenever the check cannot run at all (no textlint config, no textlint binary, any unexpected
 * error) — a hook that fails open never blocks legitimate work.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** How long a single `textlint` invocation may run before this hook gives up on it and fails
 * open. Without this, a hung `textlint` process (or a hung custom rule/plugin it loads) blocks
 * `execFileSync` forever, which blocks every subsequent Write/Edit in the session -- reproduced
 * directly with a stub binary that sleeps, see `test/integration/pre-write-compliance-hook.test.ts`. */
const TEXTLINT_TIMEOUT_MS = 15_000;

/** The most recent scratch file this process has written and not yet cleaned up, if any. Read by
 * the `SIGTERM`/`SIGINT` handlers below so a caller that kills a hung `execFileSync` call (see
 * `TEXTLINT_TIMEOUT_MS`'s own doc comment -- the harness's own hook-level timeout, or a person's
 * Ctrl-C, are both plausible external killers) still gets the scratch file removed, rather than
 * leaving it behind in the real project directory the hook is running against. A `finally` block
 * alone does not run when the process is killed out from under it. */
let pendingScratchFile;

function cleanupPendingScratchFile() {
  if (pendingScratchFile === undefined) return;
  try {
    fs.unlinkSync(pendingScratchFile);
  } catch {
    // Best-effort only -- the file may already be gone.
  }
  pendingScratchFile = undefined;
}

// Registering a handler here suppresses Node's default terminate-immediately behaviour for these
// two signals, so the process must call `process.exit` itself once cleanup runs. This cannot
// catch SIGKILL (uncatchable by any process), only the two signals a well-behaved external killer
// (a timeout wrapper, a shell's Ctrl-C) sends first.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    cleanupPendingScratchFile();
    process.exit(0);
  });
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Whether a parsed `.textlintrc.json` actually enables `preset-ste-ai`, rather than merely
 * mentioning it somewhere in the file. `"rules": { "preset-ste-ai": false }` disables the preset
 * the same way it disables any other textlint rule -- a substring search for the preset's own
 * name cannot see that `false`, and would opt a project into this hook even though the project's
 * own config turned the preset off. */
function presetIsEnabled(raw) {
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof config !== 'object' || config === null) return false;
  const rules = config.rules;
  if (typeof rules !== 'object' || rules === null) return false;
  if (!('preset-ste-ai' in rules)) return false;
  return rules['preset-ste-ai'] !== false;
}

/** Walk from `startDir` up to the filesystem root. The first readable `.textlintrc.json` found is
 * authoritative and ends the walk immediately -- it is matched if it actually enables
 * `preset-ste-ai`, and treated as no match at all otherwise, even when some ancestor directory
 * further up has a config that does enable it. A nested project's own config, once it exists and
 * can be read, always decides that project's own files; the hook must never fall through to a
 * parent's config the nested project never opted into. Returns `undefined` when no readable
 * config is found at all. */
function findSteAiConfigDir(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, '.textlintrc.json');
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, 'utf8');
        return presetIsEnabled(raw) ? { configDir: dir, configPath: candidate } : undefined;
      } catch {
        // Unreadable config: keep walking up rather than treating it as a match.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Finds the nearest `node_modules/.bin/textlint` walking up from `startDir`. */
function findTextlintBin(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'textlint');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Best-effort `require('minimatch')`. `minimatch` is not a declared dependency of this
 * repository, or of a host project this plugin's hook might run inside -- it is only ever present
 * as a transitive dependency of `glob` (itself pulled in by `textlint`, found through
 * `findTextlintBin`'s own walk). Returns `undefined` when it cannot be resolved, so the caller can
 * fail open instead of crashing the whole hook on an unmet `require`. */
function tryLoadMinimatch() {
  try {
    return require('minimatch').minimatch;
  } catch {
    return undefined;
  }
}

/** Loads `.textlintignore`'s active patterns the same way textlint's own `find-util.js` does:
 * split on newlines, drop blank lines and `#`-comment lines. Returns `[]` when no ignore file
 * exists at `ignoreFilePath` -- textlint's own default, silently absent. */
function loadIgnorePatterns(ignoreFilePath) {
  let raw;
  try {
    raw = fs.readFileSync(ignoreFilePath, 'utf8');
  } catch {
    return [];
  }
  return raw.split(/\r?\n/).filter((line) => !/^\s*$/.test(line) && !/^\s*#/.test(line));
}

/** Whether `realFilePath` is excluded by `.textlintignore` the same way an ordinary
 * `textlint <file>` invocation would skip it -- matched directly against the patterns
 * `.textlintignore` declares, plus textlint's own two built-in defaults (`.git`, `node_modules`),
 * rather than by asking the real CLI to lint the path.
 *
 * textlint's own ignore matching (`find-util.js`'s `searchFiles`, which this mirrors) is `glob`'s
 * `ignore` option -- `minimatch` under the hood -- applied only to paths a filesystem walk already
 * found. A path that does not exist on disk yet can never be returned by that walk, so asking the
 * real CLI has no way to answer "would this not-yet-created path be ignored": a brand-new file's
 * own first write was previously never checked for ignore status, only an edit to a file that
 * already exists was. Matching the patterns directly, independent of the target existing,
 * sidesteps that walk entirely and closes that gap.
 *
 * Verified directly against the real CLI for every case this repository's own `.textlintignore`
 * declares before relying on this: `examples/sample.md` and `examples/rule-pack/sample.md` both
 * agree ignored; `README.md` and `docs/architecture.md` both agree not ignored. */
function isIgnoredByTextlint(cwd, realFilePath) {
  const minimatch = tryLoadMinimatch();
  if (minimatch === undefined) return false;
  const relativePath = path.relative(cwd, realFilePath).split(path.sep).join('/');
  const patterns = [
    '**/.git/**',
    '**/node_modules/**',
    ...loadIgnorePatterns(path.join(cwd, '.textlintignore')),
  ];
  return patterns.some((pattern) => minimatch(relativePath, pattern, { dot: true }));
}

/** Runs textlint against `content` (written to a scratch file beside `realFilePath` so relative
 * config/plugin resolution behaves the same as linting the real file) and returns its error-count. */
function countErrors(textlintBin, configPath, realFilePath, content) {
  const dir = path.dirname(realFilePath);
  const scratch = path.join(
    dir,
    `.ste-ai-hook-${process.pid}-${Math.random().toString(36).slice(2)}.md`,
  );
  fs.writeFileSync(scratch, content, 'utf8');
  pendingScratchFile = scratch;
  try {
    const output = execFileSync(
      textlintBin,
      ['--config', configPath, '--format', 'json', scratch],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: TEXTLINT_TIMEOUT_MS },
    );
    return parseErrors(output);
  } catch (error) {
    // textlint exits non-zero when it finds any error-severity message; its JSON report is still
    // on stdout in that case.
    const stdout = error && typeof error.stdout === 'string' ? error.stdout : '';
    if (stdout.trim() === '') throw error;
    return parseErrors(stdout);
  } finally {
    cleanupPendingScratchFile();
  }
}

function parseErrors(jsonOutput) {
  const results = JSON.parse(jsonOutput);
  const messages = Array.isArray(results) ? (results[0]?.messages ?? []) : [];
  return messages.filter((m) => m.severity === 2);
}

/**
 * Which `after` messages are genuinely new relative to `before`, as a multiset diff keyed on
 * `ruleId` + `message` (never on line/column, which shift for every pre-existing finding once the
 * edit changes any earlier line — comparing raw counts or naively slicing the tail of the sorted
 * `after` list, both tried first, reported shifted PRE-EXISTING findings as "new" and missed the
 * actual new one; verified directly by inserting a 20-comma run-on sentence into a file with
 * pre-existing debt and diffing the real messages by hand).
 */
function diffNewMessages(before, after) {
  const beforeCounts = new Map();
  for (const m of before) {
    const key = JSON.stringify([m.ruleId, m.message]);
    beforeCounts.set(key, (beforeCounts.get(key) ?? 0) + 1);
  }
  const seenSoFar = new Map();
  const newOnes = [];
  for (const m of after) {
    const key = JSON.stringify([m.ruleId, m.message]);
    const occurrence = (seenSoFar.get(key) ?? 0) + 1;
    seenSoFar.set(key, occurrence);
    if (occurrence > (beforeCounts.get(key) ?? 0)) newOnes.push(m);
  }
  return newOnes;
}

/** Simulates what `Edit` would produce, without touching the real file. */
function applyEditInMemory(currentContent, oldString, newString, replaceAll) {
  if (replaceAll === true) {
    return currentContent.split(oldString).join(newString);
  }
  const index = currentContent.indexOf(oldString);
  if (index === -1) return undefined;
  return (
    currentContent.slice(0, index) + newString + currentContent.slice(index + oldString.length)
  );
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) process.exit(0);

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  // `JSON.parse` accepts `null`, a number, a string, or an array as top-level valid JSON -- none
  // of those throw, but a bare property access on any of them either throws (on `null`) or is
  // simply always `undefined` (on the others). Reproduced directly: `echo 'null' | node
  // hooks/block-noncompliant-prose.cjs` used to throw an uncaught TypeError and exit 1, not the
  // documented fail-open exit 0.
  if (typeof event !== 'object' || event === null) process.exit(0);

  const toolName = event.tool_name ?? '';
  if (toolName !== 'Write' && toolName !== 'Edit') process.exit(0);

  const filePath = event.tool_input?.file_path;
  if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.md')) process.exit(0);

  const found = findSteAiConfigDir(path.dirname(filePath));
  if (found === undefined) process.exit(0);

  const textlintBin = findTextlintBin(found.configDir);
  if (textlintBin === undefined) process.exit(0);

  if (isIgnoredByTextlint(process.cwd(), filePath)) process.exit(0);

  const currentContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';

  let wouldBeContent;
  if (toolName === 'Write') {
    wouldBeContent = event.tool_input?.content;
  } else {
    const oldString = event.tool_input?.old_string;
    const newString = event.tool_input?.new_string;
    if (typeof oldString !== 'string' || typeof newString !== 'string') process.exit(0);
    wouldBeContent = applyEditInMemory(
      currentContent,
      oldString,
      newString,
      event.tool_input?.replace_all,
    );
  }
  if (typeof wouldBeContent !== 'string') process.exit(0);

  try {
    const before = countErrors(textlintBin, found.configPath, filePath, currentContent);
    const after = countErrors(textlintBin, found.configPath, filePath, wouldBeContent);
    const newOnes = diffNewMessages(before, after);

    if (newOnes.length > 0) {
      const lines = newOnes
        .slice(0, 10)
        .map((m) => `  ${m.line}:${m.column}  ${m.message}  (${m.ruleId})`);
      process.stderr.write(
        `${[
          '--- ste-ai: this edit adds new lint errors ---',
          '',
          `File: ${filePath}`,
          `Errors before: ${before.length}, after: ${after.length}`,
          '',
          ...lines,
          '',
          'Fix these before writing — this project requires agent-authored prose to pass its own',
          'linter in advance rather than leaving new debt for a later pass.',
          '--- End ---',
        ].join('\n')}\n`,
      );
      process.exit(2);
    }
    process.exit(0);
  } catch {
    // Any failure to run the check (missing deps, unreadable temp dir, malformed output, ...)
    // fails open: never block a write because the check itself broke.
    process.exit(0);
  }
}

main();
