/**
 * Ratchet this repository's own prose against the preset it ships.
 *
 * Usage:
 *   node scripts/ci/check-dogfood-lint.mjs                                  # assert (CI)
 *   node scripts/ci/check-dogfood-lint.mjs --update                        # rewrite the baseline after a cleanup
 *   node scripts/ci/check-dogfood-lint.mjs --update --accept-regressions   # deliberately record new debt
 *
 * Why a ratchet and not a plain gate.
 *
 * This repository lints its own documentation with its own preset, and most of that documentation
 * does not pass yet. A plain gate would have to fail the build on day one, so it never gets added,
 * so cleanup proceeds as an open-ended manual campaign: someone picks a file, fixes it by hand,
 * and review is the only thing standing between that edit and a regression somewhere else. That is
 * how PR #100 went three review rounds -- each round fixed the file the reviewer named, and nothing
 * mechanical said whether the rest of the corpus still held.
 *
 * What the baseline records, and why it is not a plain per-file count.
 *
 * A first version of this script recorded one integer per file: how many error-severity findings
 * it had. Review on the PR that introduced it found two ways that hid a regression:
 *
 *   - `--update` rewrote the baseline with whatever the working tree currently produced, including
 *     a larger count than before. A contributor who introduced new errors and ran `--update` to
 *     "fix" the resulting CI failure would launder the regression into the baseline instead of
 *     seeing it. `--update` now refuses to raise any existing entry unless `--accept-regressions`
 *     is passed explicitly, which is the only way a maintainer deliberately accepts new debt.
 *   - A file's total can stay unchanged while its content of errors changes: fix one
 *     sentence-length finding, introduce a different punctuation finding in the same edit, and the
 *     count before and after is identical. The baseline now records, per file, a count for every
 *     distinct (ruleId, message) pair rather than one total. Line and column are deliberately not
 *     part of that identity -- prose gets reflowed and restructured, and a line-anchored identity
 *     would flag every finding in a file as "new" the moment an unrelated paragraph shifted them
 *     down. (ruleId, message) stays stable under reflow because these are deterministic rules and
 *     every message already carries the specific numbers that make it point at one finding (a
 *     Flesch-Kincaid grade level, a comma count), so collisions between genuinely different
 *     findings are not expected in practice.
 *
 * This file is machine-written and not meant to be hand-edited, the same way
 * fixtures/provenance.lock.json is (see docs/fixtures.md): both exist so a change that affects
 * their subject is a reviewable diff, not so a human composes them by hand.
 *
 * From these rules:
 *
 *   - A file with no baseline entry must be clean. New and renamed files cannot add debt.
 *   - A file's (ruleId, message) counts must not exceed what the baseline records for that pair.
 *     Existing debt cannot grow, and swapping one finding for a different one is not free.
 *   - A baseline entry that is now clean must be removed. Progress is recorded, not quietly banked,
 *     so the baseline can only ever shrink and the campaign has a visible finish line.
 *
 * The counts are error-severity only. review-required findings are info and depend on semantic
 * adjudication that does not run here, so counting them would make the baseline depend on whether a
 * model was configured.
 *
 * What is out of scope entirely, not merely ratcheted: .textlintignore (repository root) lists
 * content this repository does not hold itself to -- a fixture whose violations are the point
 * (examples/sample.md), and licensed excerpts this project did not author (fixtures/). textlint
 * auto-detects that file, so the exclusion applies to every invocation, not only this script.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const BASELINE_PATH = resolve(REPO_ROOT, 'scripts/ci/dogfood-lint-baseline.json');
const TEXTLINT_BIN = resolve(REPO_ROOT, 'node_modules/.bin/textlint');
const CONFIG = resolve(REPO_ROOT, '.textlintrc.json');

const FINDING_KEY_SEPARATOR = '\n';

/**
 * Prose this repository authors and therefore owns.
 *
 * Globs, not a file list, for the reason check-textlint-configs-resolve.sh gives: a check that
 * names the files it guards stops guarding the moment someone adds a file. .textlintignore narrows
 * this further for content that is in scope by glob but not in scope by intent.
 */
const TARGETS = [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'docs/**/*.md',
  'prompts/**/*.md',
  'examples/**/*.md',
];

/**
 * ruleId and message joined into one baseline key, with a separator that cannot appear in either
 * field: textlint messages are single-line strings, so a raw newline only ever comes from this
 * join. Split with splitFindingKey, never a plain string split on a space -- message itself
 * contains spaces.
 */
function findingKey(ruleId, message) {
  return ruleId + FINDING_KEY_SEPARATOR + message;
}

function splitFindingKey(key) {
  const at = key.indexOf(FINDING_KEY_SEPARATOR);
  return [key.slice(0, at), key.slice(at + FINDING_KEY_SEPARATOR.length)];
}

/**
 * Run the preset over every target and return, per file, how many times each distinct
 * (ruleId, message) pair appears at error severity.
 *
 * Returns a Map<string, Map<string, number>>: file path -> (findingKey -> count), containing only
 * files with at least one error. Returns undefined if the build is not ready to lint.
 */
function lint() {
  if (!existsSync(TEXTLINT_BIN)) {
    console.error(relative(REPO_ROOT, TEXTLINT_BIN) + " is missing. Run 'vp install' first.");
    process.exitCode = 2;
    return undefined;
  }
  if (!existsSync(resolve(REPO_ROOT, 'dist/textlint/preset.js'))) {
    console.error("dist/textlint/preset.js is missing. Run 'vp pack' first.");
    process.exitCode = 2;
    return undefined;
  }

  let stdout;
  try {
    stdout = execFileSync(TEXTLINT_BIN, ['--config', CONFIG, '--format', 'json', ...TARGETS], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (error) {
    // textlint exits 1 when it reports findings, which is the normal case here.
    if (error.stdout === undefined || error.stdout === '') throw error;
    stdout = error.stdout;
  }

  const byFile = new Map();
  for (const file of JSON.parse(stdout)) {
    const path = relative(REPO_ROOT, file.filePath);
    const findings = new Map();
    for (const message of file.messages) {
      if (message.severity !== 2) continue;
      const key = findingKey(message.ruleId, message.message);
      findings.set(key, (findings.get(key) ?? 0) + 1);
    }
    if (findings.size > 0) byFile.set(path, findings);
  }
  return byFile;
}

/** Sum of counts in a plain findings object, as stored in the baseline file. */
function totalOf(findingsObject) {
  return Object.values(findingsObject).reduce((sum, n) => sum + n, 0);
}

function toBaselineShape(byFile) {
  const out = {};
  for (const path of [...byFile.keys()].toSorted((a, b) => a.localeCompare(b))) {
    const findings = byFile.get(path);
    const sortedFindings = {};
    for (const key of [...findings.keys()].toSorted((a, b) => a.localeCompare(b))) {
      sortedFindings[key] = findings.get(key);
    }
    out[path] = { total: totalOf(sortedFindings), findings: sortedFindings };
  }
  return out;
}

/**
 * Every (file, findingKey) pair whose current count exceeds what baseline allows for it. Covers
 * both a brand-new finding (baseline count 0) and an existing one that got more frequent.
 */
function findRegressions(byFile, baseline) {
  const regressions = [];
  for (const [path, findings] of byFile) {
    const allowed = baseline[path]?.findings ?? {};
    for (const [key, count] of findings) {
      const before = allowed[key] ?? 0;
      if (count > before) {
        const [ruleId, message] = splitFindingKey(key);
        regressions.push({ path, ruleId, message, before, after: count });
      }
    }
  }
  return regressions;
}

function printRegressions(regressions) {
  for (const r of regressions) {
    console.error('  ' + r.path + ' [' + r.ruleId + ']: ' + r.before + ' -> ' + r.after);
    console.error('    ' + r.message);
  }
}

function main() {
  const update = process.argv.includes('--update');
  const acceptRegressions = process.argv.includes('--accept-regressions');
  const byFile = lint();
  if (byFile === undefined) return;

  if (update) {
    const existing = existsSync(BASELINE_PATH)
      ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
      : {};
    const regressions = findRegressions(byFile, existing);

    if (regressions.length > 0 && !acceptRegressions) {
      console.error(
        '--update would raise the baseline above what it currently allows for these findings:',
      );
      printRegressions(regressions);
      console.error(
        'The ratchet only ever shrinks. Fix the regression, or re-run with --update ' +
          '--accept-regressions to record it deliberately.',
      );
      process.exitCode = 1;
      return;
    }

    const shaped = toBaselineShape(byFile);
    writeFileSync(BASELINE_PATH, JSON.stringify(shaped, null, 2) + '\n');
    const total = Object.values(shaped).reduce((sum, entry) => sum + entry.total, 0);
    const verb =
      regressions.length > 0 ? 'baseline written (regressions accepted)' : 'baseline written';
    console.log(verb + ': ' + Object.keys(shaped).length + ' files, ' + total + ' errors');
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error(
      relative(REPO_ROOT, BASELINE_PATH) +
        ' is missing. Run this script with --update to create it.',
    );
    process.exitCode = 2;
    return;
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

  const added = [...byFile.keys()]
    .filter((path) => baseline[path] === undefined)
    .map((path) => {
      const total = totalOf(Object.fromEntries(byFile.get(path)));
      return path + ': ' + total + ' errors, and no baseline entry';
    });
  const regressions = findRegressions(byFile, baseline);
  const stale = Object.keys(baseline).filter((path) => !byFile.has(path));

  if (added.length > 0) {
    console.error('These files are not clean and are not in the baseline:');
    for (const line of added) console.error('  ' + line);
    console.error('Fix them, or record the debt deliberately with --update.');
  }
  if (regressions.length > 0) {
    console.error('These findings got worse:');
    printRegressions(regressions);
  }
  if (stale.length > 0) {
    console.error('These files are clean now, so their baseline entries must be removed:');
    for (const path of stale) console.error('  ' + path);
    console.error("Run 'node scripts/ci/check-dogfood-lint.mjs --update' and commit the result.");
  }

  if (added.length > 0 || regressions.length > 0 || stale.length > 0) {
    process.exitCode = 1;
    return;
  }

  const remaining = Object.values(baseline).reduce((sum, entry) => sum + entry.total, 0);
  console.log(
    'dogfood lint holds: ' +
      Object.keys(baseline).length +
      ' files carry ' +
      remaining +
      ' recorded errors, and nothing regressed.',
  );
}

main();
