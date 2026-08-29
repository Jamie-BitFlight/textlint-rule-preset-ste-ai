#!/usr/bin/env node
'use strict';

/**
 * PreToolUse hook — blocks a Write or Edit call that would make a markdown file's ste-ai
 * (`textlint-rule-preset-ste-ai`) lint findings worse than what is already on disk.
 *
 * Scope: only engages in a project that actually enables this preset (the *nearest*
 * `.textlintrc.json` walking up from the target file must exist and enable `preset-ste-ai` --
 * see {@link findSteAiConfigDir}'s own doc comment for why the nearest config is authoritative
 * even when it does not enable the preset, rather than skipped in favour of a more distant
 * ancestor's), only for `.md` files, and only for a target path `.textlintignore` does not
 * already exclude (see {@link countErrorsScratch}'s doc comment). A file that already carries
 * pre-existing findings is not blocked from every future edit -- only from an edit whose findings
 * are not a subset of what the file already had. This mirrors `scripts/ci/check-dogfood-lint.mjs`'s
 * own ratchet in this repo ("the ratchet only ever shrinks"), at exact-finding granularity via
 * {@link diffNewMessages} (a replacement -- one finding disappearing while a different one
 * appears, with the total count unchanged -- still blocks; see that function's own doc comment),
 * since a hook has to stay fast and self-contained enough to run on every write in any project
 * that installs this plugin -- not just this one.
 *
 * Exits code 2 (block + feedback to the agent) when the would-be content has a lint finding the
 * current on-disk content does not. Exits code 0 (pass) otherwise, including whenever the check
 * cannot run at all (no textlint config, no textlint binary, any unexpected error) — a hook that
 * fails open never blocks legitimate work.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** How long a single `textlint` invocation may run before this hook gives up on it and fails
 * open. Without this, a hung `textlint` process (or a hung custom rule/plugin it loads) blocks
 * this hook forever, which blocks every subsequent Write/Edit in the session -- reproduced
 * directly with a stub binary that sleeps, see `test/integration/pre-write-compliance-hook.test.ts`. */
const TEXTLINT_TIMEOUT_MS = 15_000;

/**
 * The `textlint` child process currently running, if any, and the scratch file it is reading
 * from, if this run used one. Read by the `SIGTERM`/`SIGINT` handlers below.
 *
 * `scratchPath` is `undefined` for a run against the real on-disk target file (see
 * {@link runTextlint}) -- cleanup must never delete that path. Only a run against a throwaway
 * scratch copy carries a `scratchPath`, and only that path gets unlinked.
 *
 * PROVENANCE: an earlier version of this hook used `execFileSync` and relied on a `SIGTERM`/
 * `SIGINT` handler to kill the child and clean up the scratch file on an external kill. That
 * handler was dead code for exactly the scenario it existed to protect: `execFileSync` blocks
 * the whole Node.js event loop synchronously for the duration of the child process, and a
 * registered signal handler cannot run until the event loop is free to process it -- reproduced
 * directly (an isolated repro with a bare `execFileSync('sleep', ['30'])` and a `SIGTERM`
 * handler: the handler's own `console.error` never printed, confirmed still running 4s after the
 * signal). Switching to async `spawn` keeps the event loop free while `textlint` runs, so a
 * signal handler here can actually run -- and can kill the in-flight child directly, not just
 * hope it exits on its own.
 */
let pending;

/**
 * Kills `child`'s entire process group, not just `child` itself.
 *
 * PROVENANCE: `child.kill(signal)` only signals the immediate child. `textlint` -- or a rule/
 * plugin it loads, or (in this hook's own test suite) a stub binary standing in for it -- can be
 * a shell script that forks a grandchild (a real `bash script.sh` wrapping `sleep`, in the stub
 * case); that grandchild inherits the same stdout/stderr pipes and keeps them open even after the
 * immediate child (the shell) dies, so Node's `'close'` event -- what both the 15s timeout and
 * this cleanup path wait on -- never fires. Reproduced directly: a bare `child.kill('SIGTERM')`
 * against a `bash -c 'sleep 120'` child left `'close'` unfired for the full 120s; spawning with
 * `detached: true` (making the child its own process-group leader) and killing the *group* via
 * `process.kill(-child.pid, signal)` instead brought `'close'` back to ~1.5s. `-pid` is the
 * documented `kill`/`process.kill` syntax for "the process group led by this pid," not a typo.
 */
function killGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // ESRCH: the group is already gone. Best-effort only.
  }
}

function cleanupPending() {
  if (pending === undefined) return;
  const { scratchPath, child } = pending;
  pending = undefined;
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    killGroup(child, 'SIGKILL');
  }
  if (scratchPath === undefined) return;
  try {
    fs.unlinkSync(scratchPath);
  } catch {
    // Best-effort only -- the file may already be gone.
  }
}

// Registering a handler here suppresses Node's default terminate-immediately behaviour for these
// two signals, so the process must call `process.exit` itself once cleanup runs. This cannot
// catch SIGKILL (uncatchable by any process), only the two signals a well-behaved external killer
// (a timeout wrapper, a shell's Ctrl-C) sends first.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    cleanupPending();
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

/**
 * Whether a parsed `.textlintrc.json` document actually enables `preset-ste-ai`, not merely
 * mentions it.
 *
 * PROVENANCE (independent review of PR #122): the earlier `raw.includes('preset-ste-ai')`
 * substring check treated `{"rules": {"preset-ste-ai": false, ...other rules...}}` the same as an
 * enabled preset -- reproduced directly with that config and a stub `textlint` result: the hook
 * blocked new findings from the unrelated *other* rules in a project that had explicitly turned
 * `preset-ste-ai` off. `rules['preset-ste-ai']` must be present and not literally `false`; any
 * other value (`true`, or an options object) is textlint's own way of enabling a rule.
 */
function presetIsEnabled(configJson) {
  if (typeof configJson !== 'object' || configJson === null) return false;
  const rules = configJson.rules;
  if (typeof rules !== 'object' || rules === null) return false;
  const value = rules['preset-ste-ai'];
  return value !== undefined && value !== false;
}

/**
 * Walk from `startDir` up to the filesystem root, returning the nearest directory containing a
 * `.textlintrc.json`, provided that file enables `preset-ste-ai` -- or `undefined` if no
 * `.textlintrc.json` exists in the ancestry at all, or if the nearest one that exists does not
 * enable the preset.
 *
 * PROVENANCE (independent review of PR #122): an earlier version kept walking past a
 * `.textlintrc.json` that did not mention `preset-ste-ai`, treating it as "no match here, keep
 * looking" rather than as an authoritative "this project does not use this preset." That let a
 * nested project's own explicit choice not to use `preset-ste-ai` be overridden by a parent
 * directory's config that does -- reproduced directly with a nested `.textlintrc.json` (no
 * `preset-ste-ai`) beneath a parent one that has it: the hook blocked a write in the nested
 * project anyway. The nearest config a project defines for itself is authoritative, whatever it
 * says -- the same way a nested `.eslintrc`/`tsconfig.json` overrides a parent's, not merges with
 * it. Only the total absence of any `.textlintrc.json` in the ancestry means "look further up
 * makes no sense either" -- there is nothing to walk further up *from* in that case, since no
 * config exists to be authoritative in the first place.
 */
function findSteAiConfigDir(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, '.textlintrc.json');
    if (fs.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        return presetIsEnabled(parsed) ? { configDir: dir, configPath: candidate } : undefined;
      } catch {
        // Unreadable or malformed config: treat the same as "found, but does not enable the
        // preset" -- an unreadable nearest config is still this project's own authoritative
        // choice, not a reason to fall through to some more distant ancestor's.
        return undefined;
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

/**
 * Runs `textlint` against `targetPath` and resolves with the parsed top-level JSON results array
 * -- one entry per linted file, `[]` when `targetPath` matched no linted file at all.
 *
 * `scratchPath` is the same value as `targetPath` when `targetPath` is a throwaway scratch copy
 * this hook wrote -- passed through so {@link cleanupPending} knows to delete it. Pass
 * `undefined` when `targetPath` is the real on-disk target file, which cleanup must never touch.
 *
 * Uses async `spawn` rather than `execFileSync` specifically so `TEXTLINT_TIMEOUT_MS` and an
 * external signal can both actually interrupt a hung child -- see {@link pending}'s doc comment.
 */
function runTextlint(textlintBin, configPath, targetPath, scratchPath) {
  return new Promise((resolve, reject) => {
    // `detached: true` makes this child its own process-group leader, so a timeout or an
    // external signal can kill its whole group -- not just the immediate process -- via
    // {@link killGroup}. See killGroup's own doc comment for why the immediate child alone is
    // not enough.
    const child = spawn(textlintBin, ['--config', configPath, '--format', 'json', targetPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    pending = { scratchPath, child };

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      cleanupPending();
      reject(error);
    });
    child.on('close', () => {
      clearTimeout(timer);
      cleanupPending();
      // textlint exits non-zero when it finds any error-severity message; its JSON report is
      // still on stdout in that case, and an empty stdout (a crash before any report was
      // printed) is the only case this hook cannot make sense of.
      if (stdout.trim() === '') {
        reject(new Error(`textlint produced no output for ${targetPath}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });

    const timer = setTimeout(() => {
      killGroup(child, 'SIGTERM');
    }, TEXTLINT_TIMEOUT_MS);
  });
}

/**
 * Writes `content` to a scratch file beside `realFilePath` (so relative config/plugin resolution
 * behaves the same as linting the real file) and lints it.
 *
 * PROVENANCE (independent review of PR #122): a scratch file has a randomly generated name, so
 * `.textlintignore`'s own path- and filename-based ignore patterns (`examples/sample.md`, an
 * exact match) do not recognise it even when the real target path they name is ignored --
 * reproduced directly with `examples/sample.md` (a `.textlintignore` entry in this very
 * repository): linting a same-directory scratch copy of it found real findings that an ordinary
 * `textlint examples/sample.md` invocation never reports, because that invocation is skipped
 * entirely. {@link main} now avoids this for the common case (the target already exists on disk)
 * by linting the real path directly for the "before" measurement instead of a scratch copy --
 * see its own comment. A directory-level ignore pattern (`fixtures/original/**`) still applies
 * correctly to a scratch file underneath it, since that kind of pattern is path-shape-based, not
 * filename-exact.
 */
function countErrorsScratch(textlintBin, configPath, realFilePath, content) {
  const dir = path.dirname(realFilePath);
  const scratchPath = path.join(
    dir,
    `.ste-ai-hook-${process.pid}-${Math.random().toString(36).slice(2)}.md`,
  );
  fs.writeFileSync(scratchPath, content, 'utf8');
  return runTextlint(textlintBin, configPath, scratchPath, scratchPath);
}

function messagesFromResults(results) {
  const messages = Array.isArray(results) ? (results[0]?.messages ?? []) : [];
  return messages.filter((m) => m.severity === 2);
}

/**
 * Which `after` messages are genuinely new relative to `before`, as a multiset diff keyed on
 * `ruleId` + `message` (never on line/column, which shift for every pre-existing finding once the
 * edit changes any earlier line — comparing raw counts or naively slicing the tail of the sorted
 * `after` list, both tried first, reported shifted PRE-EXISTING findings as "new" and missed the
 * actual new one; verified directly by inserting a 20-comma run-on sentence into a file with
 * pre-existing debt and diffing the real messages by hand). This is why the hook can block on a
 * pure *replacement* too: one finding disappearing while an unrelated different one appears
 * leaves `before.length === after.length`, but the new one is still absent from `before` and
 * still gets reported here — the block condition this file uses is "any message in `newOnes`",
 * never a raw length comparison.
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

async function main() {
  const raw = readStdin();
  if (!raw.trim()) process.exit(0);

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    process.exit(0);
    return;
  }
  // `JSON.parse` accepts `null`, a number, a string, or an array as top-level valid JSON -- none
  // of those throw, but a bare property access on `null` does. Reproduced directly: `echo 'null'
  // | node hooks/block-noncompliant-prose.cjs` used to throw an uncaught TypeError and exit 1,
  // not the documented fail-open exit 0.
  if (typeof event !== 'object' || event === null) {
    process.exit(0);
    return;
  }

  const toolName = event.tool_name ?? '';
  if (toolName !== 'Write' && toolName !== 'Edit') {
    process.exit(0);
    return;
  }

  const filePath = event.tool_input?.file_path;
  if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.md')) {
    process.exit(0);
    return;
  }

  const found = findSteAiConfigDir(path.dirname(filePath));
  if (found === undefined) {
    process.exit(0);
    return;
  }

  const textlintBin = findTextlintBin(found.configDir);
  if (textlintBin === undefined) {
    process.exit(0);
    return;
  }

  const targetExists = fs.existsSync(filePath);
  const currentContent = targetExists ? fs.readFileSync(filePath, 'utf8') : '';

  let wouldBeContent;
  if (toolName === 'Write') {
    wouldBeContent = event.tool_input?.content;
  } else {
    const oldString = event.tool_input?.old_string;
    const newString = event.tool_input?.new_string;
    if (typeof oldString !== 'string' || typeof newString !== 'string') {
      process.exit(0);
      return;
    }
    wouldBeContent = applyEditInMemory(
      currentContent,
      oldString,
      newString,
      event.tool_input?.replace_all,
    );
  }
  if (typeof wouldBeContent !== 'string') {
    process.exit(0);
    return;
  }

  try {
    // Lint the real on-disk file directly for "before", when it already exists, instead of a
    // scratch copy -- this doubles as the correct ignore check, since it uses the real path
    // .textlintignore actually matches against (see countErrorsScratch's own comment). An
    // ignored real path lints as an empty top-level results array (`[]`); a linted, merely
    // clean, file still yields one entry with an empty `messages` list -- confirmed directly
    // against both a `.textlintignore`-excluded file and a genuinely empty one. A target that
    // does not exist yet has no prior findings by definition, so "before" is empty without
    // needing to invoke textlint at all.
    let before;
    if (targetExists) {
      const beforeResults = await runTextlint(textlintBin, found.configPath, filePath, undefined);
      if (beforeResults.length === 0) {
        process.exit(0);
        return;
      }
      before = messagesFromResults(beforeResults);
    } else {
      before = [];
    }
    const afterResults = await countErrorsScratch(
      textlintBin,
      found.configPath,
      filePath,
      wouldBeContent,
    );
    const after = messagesFromResults(afterResults);
    const newOnes = diffNewMessages(before, after);

    if (newOnes.length > 0) {
      const lines = newOnes
        .slice(0, 10)
        .map((m) => `  ${m.line}:${m.column}  ${m.message}  (${m.ruleId})`);
      process.stderr.write(
        `${[
          '--- ste-ai: this edit adds new lint findings ---',
          '',
          `File: ${filePath}`,
          `Findings before: ${before.length}, after: ${after.length}`,
          '',
          ...lines,
          '',
          'Fix these before writing — this project requires agent-authored prose to pass its own',
          'linter in advance rather than leaving new debt for a later pass.',
          '--- End ---',
        ].join('\n')}\n`,
      );
      process.exit(2);
      return;
    }
    process.exit(0);
  } catch {
    // Any failure to run the check (missing deps, unreadable temp dir, malformed output, ...)
    // fails open: never block a write because the check itself broke.
    process.exit(0);
  }
}

void main();
