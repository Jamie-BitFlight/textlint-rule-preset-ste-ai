/**
 * Ratchet this repository's own prose against the preset it ships.
 *
 * Usage:
 *   node scripts/ci/check-dogfood-lint.mjs            # assert (CI)
 *   node scripts/ci/check-dogfood-lint.mjs --update   # rewrite the baseline after a cleanup
 *
 * Why a ratchet and not a plain gate.
 *
 * This repository lints its own documentation with its own preset, and most of that documentation
 * does not pass yet. A plain gate would have to fail the build on day one, so it never gets added,
 * so cleanup proceeds as an open-ended manual campaign: someone picks a file, fixes it by hand,
 * and review is the only thing standing between that edit and a regression somewhere else. That is
 * how PR #100 went three review rounds — each round fixed the file the reviewer named, and nothing
 * mechanical said whether the rest of the corpus still held.
 *
 * The baseline records how many `error`-severity findings each file currently has. From then on:
 *
 *   - A file with no baseline entry must be clean. New and renamed files cannot add debt.
 *   - A file with a baseline entry must not exceed it. Existing debt cannot grow.
 *   - A baseline entry that is now clean must be removed. Progress is recorded, not quietly banked,
 *     so the baseline can only ever shrink and the campaign has a visible finish line.
 *
 * The counts are error-severity only. `review-required` findings are `info` and depend on semantic
 * adjudication that does not run here, so counting them would make the baseline depend on whether a
 * model was configured.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const BASELINE_PATH = resolve(REPO_ROOT, 'scripts/ci/dogfood-lint-baseline.json');
const TEXTLINT_BIN = resolve(REPO_ROOT, 'node_modules/.bin/textlint');
const CONFIG = resolve(REPO_ROOT, '.textlintrc.json');

/**
 * Prose this repository authors and therefore owns.
 *
 * Globs, not a file list, for the reason `check-textlint-configs-resolve.sh` gives: a check that
 * names the files it guards stops guarding the moment someone adds a file.
 */
const TARGETS = [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'docs/**/*.md',
  'prompts/**/*.md',
  'examples/**/*.md',
];

function lint() {
  if (!existsSync(TEXTLINT_BIN)) {
    console.error(`${relative(REPO_ROOT, TEXTLINT_BIN)} is missing. Run 'vp install' first.`);
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

  const counts = new Map();
  for (const file of JSON.parse(stdout)) {
    const path = relative(REPO_ROOT, file.filePath);
    const errors = file.messages.filter((message) => message.severity === 2).length;
    if (errors > 0) counts.set(path, errors);
  }
  return counts;
}

function main() {
  const update = process.argv.includes('--update');
  const counts = lint();
  if (counts === undefined) return;

  if (update) {
    const sorted = Object.fromEntries([...counts].toSorted(([a], [b]) => a.localeCompare(b)));
    writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    console.log(`baseline written: ${counts.size} files, ${total} errors`);
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error(
      `${relative(REPO_ROOT, BASELINE_PATH)} is missing. Run this script with --update to create it.`,
    );
    process.exitCode = 2;
    return;
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

  const added = [];
  const grown = [];
  for (const [path, errors] of counts) {
    const allowed = baseline[path];
    if (allowed === undefined) added.push(`${path}: ${errors} errors, and no baseline entry`);
    else if (errors > allowed) grown.push(`${path}: ${errors} errors, baseline allows ${allowed}`);
  }
  const stale = Object.keys(baseline).filter((path) => !counts.has(path));

  if (added.length > 0) {
    console.error('These files are not clean and are not in the baseline:');
    for (const line of added) console.error(`  ${line}`);
    console.error('Fix them, or record the debt deliberately with --update.');
  }
  if (grown.length > 0) {
    console.error('These files got worse:');
    for (const line of grown) console.error(`  ${line}`);
  }
  if (stale.length > 0) {
    console.error('These files are clean now, so their baseline entries must be removed:');
    for (const path of stale) console.error(`  ${path}`);
    console.error("Run 'node scripts/ci/check-dogfood-lint.mjs --update' and commit the result.");
  }

  if (added.length > 0 || grown.length > 0 || stale.length > 0) {
    process.exitCode = 1;
    return;
  }

  const remaining = Object.values(baseline).reduce((sum, n) => sum + n, 0);
  console.log(
    `dogfood lint holds: ${Object.keys(baseline).length} files carry ${remaining} recorded errors, and nothing regressed.`,
  );
}

main();
