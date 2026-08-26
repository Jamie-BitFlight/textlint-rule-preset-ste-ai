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
 * it had. Review found ways that hid a regression, each fixed in turn:
 *
 *   - `--update` rewrote the baseline with whatever the working tree currently produced, including
 *     a larger count than before. A contributor who introduced new errors and ran `--update` to
 *     "fix" the resulting CI failure would launder the regression into the baseline instead of
 *     seeing it. `--update` now refuses to raise any existing entry unless `--accept-regressions`
 *     is passed explicitly, which is the only way a maintainer deliberately accepts new debt.
 *   - A file's total can stay unchanged while its content of errors changes: fix one finding,
 *     introduce a different one in the same edit, and the count before and after is identical. The
 *     baseline moved from one total per file to one count per distinct (ruleId, message) pair.
 *   - The same (ruleId, message) pair can occur many times in one file with no distinguishing
 *     detail in the message itself -- `docs/architecture.md` carries many separate semicolons,
 *     every one reported as the identical string. Fixing some of those and introducing different
 *     ones left the per-message count unchanged, so the swap was invisible. Each finding's key
 *     folded in a normalized slice of the source text surrounding it (see `localContext`), not
 *     merely its rule and message. Line and column stay out of the key on purpose: prose gets
 *     reflowed and restructured, and a line-anchored identity would flag every finding in a file
 *     as "new" the moment an unrelated paragraph shifted them down. Nearby source text does not
 *     have that problem, because it moves with the finding rather than the file's other content.
 *   - Even the local-context fingerprint is not always unique: `fixtures/LICENSES.md` quotes the
 *     identical SQLite public-domain licence statement, verbatim, for four separate fixtures. No
 *     context radius distinguishes those -- the surrounding text really is byte-identical, not
 *     merely similarly shaped. `findingKey` now also folds in each finding's 1-based ordinal
 *     position among findings sharing its `(ruleId, message, context)` triple, assigned in
 *     document order. See `findingKey`'s own comment for the tradeoff this makes.
 *   - A related gap: a file that improves without reaching zero was never required to record that
 *     improvement, since only a fully clean file counted as `stale`. The unrecorded slack could
 *     then be spent back later -- reintroducing exactly the findings that were removed -- without
 *     the ratchet noticing, because the current count would still sit at or under the stale
 *     baseline. `findImprovements` now flags any file whose current findings are a strict subset,
 *     by count, of what its baseline entry allows, and assert mode requires `--update` for it the
 *     same as for a fully-cleaned file.
 *   - The local-context window itself was not bounded by document structure, so a cleanup edit near
 *     an untouched finding, but unrelated to it, could still change that finding's context slice and
 *     make it look new. Review reproduced this with a heading-only edit sitting within
 *     `CONTEXT_RADIUS` characters of an otherwise untouched violation, demanding
 *     `--accept-regressions` for ordinary local cleanup. `localContext` now clamps its window to the
 *     paragraph the finding sits in (see `paragraphBounds`), so an edit in a neighbouring block
 *     cannot reach into it. The ordinal mechanism above still does its own job inside one paragraph.
 *   - The ordinal alone was not the whole fix for repeated identical content either: it numbers
 *     occurrences by position among matches, not by any property of the occurrence itself, so
 *     removing one of several identical findings and introducing an identical one elsewhere in the
 *     same file just renumbers 1..N for whatever set remains -- both `findRegressions` and
 *     `findImprovements` see no change. Reproduced directly: two identical semicolon violations
 *     under two different headings, baselined, then one removed and an identical one added under a
 *     third, previously clean heading -- assert mode reported `dogfood lint holds`. `findingKey` now
 *     also folds in `nearestHeading`, the finding's enclosing section, which the four LICENSES.md
 *     occurrences turn out to already have one each of, distinct from one another. See
 *     `findingKey`'s own comment for what this closes and what it still, honestly, does not.
 *
 * This file is machine-written and not meant to be hand-edited, the same way
 * `fixtures/provenance.lock.json` is (see `docs/fixtures.md`): both exist so a change that affects
 * their subject is a reviewable diff, not so a human composes them by hand.
 *
 * From these rules:
 *
 *   - A file with no baseline entry must be clean. New and renamed files cannot add debt.
 *   - A file's finding counts must not exceed what the baseline records for each. Existing debt
 *     cannot grow, and swapping one finding for a different one, even a same-message one, is not
 *     free.
 *   - A file whose findings shrink, whether to zero or only partway, must have that recorded.
 *     Progress cannot be silently banked and spent back later, so the baseline can only ever
 *     shrink and the campaign has a visible finish line.
 *
 * The counts are error-severity only. `review-required` findings are `info` and depend on semantic
 * adjudication that does not run here, so counting them would make the baseline depend on whether a
 * model was configured.
 *
 * What files this covers, and what is out of scope entirely rather than merely ratcheted.
 *
 * Every `*.md` file this repository tracks in git is in scope, discovered fresh on each run via
 * `git ls-files`, not a hand-maintained glob list -- a curated list is exactly the kind of thing
 * that silently stops covering a new directory, which is what review found: `.claude/rules`,
 * `.claude/skills` (every `SKILL.md`), and the authored `fixtures/LICENSES.md` were all outside
 * the old glob set despite being prose this repository writes for itself.
 *
 * `.textlintignore` (repository root) is where content that is genuinely out of scope belongs
 * instead: a fixture whose violations are the point (`examples/sample.md`), and licensed excerpts
 * this project did not author (`fixtures/original/`, `fixtures/compliant/`). textlint auto-detects
 * that file, so the exclusion applies to every invocation, not only this script.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const BASELINE_PATH = resolve(REPO_ROOT, 'scripts/ci/dogfood-lint-baseline.json');
const TEXTLINT_BIN = resolve(REPO_ROOT, 'node_modules/.bin/textlint');
const CONFIG = resolve(REPO_ROOT, '.textlintrc.json');

const FINDING_KEY_SEPARATOR = '\n';

/** Characters of source text kept on each side of a finding, for its local-context fingerprint. */
const CONTEXT_RADIUS = 40;

/**
 * Every `*.md` file this repository tracks in git, repository-root-relative.
 *
 * Discovered, not listed: a hand-maintained target list is the failure mode this function exists
 * to rule out. `.textlintignore` is where deliberate exclusions belong instead -- see the module
 * doc comment.
 */
function discoverMarkdownFiles() {
  const output = execFileSync('git', ['ls-files', '-z', '--', '*.md'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return output.split('\0').filter((path) => path.length > 0);
}

/**
 * The bounds of the blank-line-delimited block of text `index` falls inside: the character offset
 * just after the nearest blank line before it, and the offset of the nearest blank line at or
 * after it (or the string bounds, at either end, if there is no such blank line). A blank line is
 * one that is empty once trailing whitespace is stripped.
 */
export function paragraphBounds(source, index) {
  const blankLine = /\n[ \t]*\n/g;
  let start = 0;
  for (const match of source.matchAll(blankLine)) {
    const boundary = match.index + match[0].length - 1; // keep the second '\n' out of the block
    if (boundary > index) break;
    start = boundary;
  }
  blankLine.lastIndex = index;
  const next = blankLine.exec(source);
  const end = next === null ? source.length : next.index + 1; // include the first '\n' of the pair
  return { start, end };
}

/**
 * A short, whitespace-normalized slice of `source` centered on `index`, clamped to the paragraph
 * `index` sits in.
 *
 * This is the finding's occurrence fingerprint. It survives the file being reflowed elsewhere,
 * because it travels with the finding rather than with the file's line numbers, and it tells two
 * occurrences of the identical `(ruleId, message)` pair apart when they sit in different
 * sentences.
 *
 * The paragraph clamp exists because an unbounded character radius does not only travel with the
 * finding: review reproduced a heading edit -- nothing to do with the finding at all -- changing a
 * completely untouched finding's identity, because the finding sat within `CONTEXT_RADIUS`
 * characters of that heading. Clamping to the current paragraph keeps the radius from reaching
 * into a neighbouring block a cleanup edit is actually likely to touch. It does not fully retire
 * `CONTEXT_RADIUS`: `fixtures/LICENSES.md`'s colliding fixtures sit inside one long paragraph (a
 * bullet list with no blank line between items), so the radius still bounds the key's size there.
 * The occurrence ordinal in `findingKey` is what actually disambiguates that case; this clamp only
 * keeps an edit in one paragraph from perturbing a finding that lives in a different one.
 */
export function localContext(source, index) {
  const { start: paraStart, end: paraEnd } = paragraphBounds(source, index);
  const start = Math.max(paraStart, index - CONTEXT_RADIUS);
  const end = Math.min(paraEnd, index + CONTEXT_RADIUS);
  return source.slice(start, end).replace(/\s+/g, ' ').trim();
}

/**
 * The nearest Markdown ATX heading (`#` through `######`) at or before `index`, trimmed, or the
 * empty string when `index` sits before the file's first heading.
 *
 * This is a structural anchor: unlike `localContext`, it does not shrink or shift when unrelated
 * prose is edited elsewhere in the same section, and unlike `ordinal` (see `findingKey`), it stays
 * tied to which section a finding lives in rather than to how many identical findings happen to
 * precede it in document order.
 */
export function nearestHeading(source, index) {
  const heading = /^#{1,6}[ \t]+.*$/gm;
  let found = '';
  for (const match of source.matchAll(heading)) {
    if (match.index > index) break;
    found = match[0].trim();
  }
  return found;
}

/**
 * `ruleId`, `message`, a local-context fingerprint, the enclosing heading, and an occurrence
 * ordinal joined into one baseline key, with a separator that cannot appear in the first four
 * fields: `message` is a single-line string, `localContext` and `nearestHeading` both collapse or
 * exclude newlines, and `ordinal` is a decimal integer.
 *
 * The heading and the ordinal close two different gaps in the same problem: `localContext` alone
 * is not always unique within a file. Review found `fixtures/LICENSES.md` quoting the identical
 * SQLite public-domain licence statement verbatim for four separate fixtures -- same rule, same
 * message, same surrounding text, because the surrounding text really is byte-identical, not
 * merely similarly shaped. No context radius fixes that.
 *
 * A first fix used only an ordinal: each finding's 1-based position among findings sharing the
 * same `(ruleId, message, context)` triple, assigned in document order. Review then found that
 * scheme still misses a swap: removing one of several identical occurrences and introducing an
 * identical one elsewhere in the file regenerates ordinals 1..N for whatever set remains, so
 * `findRegressions` and `findImprovements` both see no change -- confirmed by reproducing exactly
 * that swap between two headings and observing `dogfood lint holds` when a real defect had moved.
 * The four LICENSES.md occurrences turned out to already sit under four distinct headings
 * (`sqlite-vacuum-space-reclaim`, `sqlite-cli-description`, `sqlite-cli-dot-commands`,
 * `sqlite-pragma-hard-negative`), so folding in `nearestHeading` gives each one a key the others
 * do not share, and a cross-heading swap now changes two keys' counts instead of zero.
 *
 * `ordinal` still does real work within `nearestHeading`'s scope: two identical occurrences under
 * the very same heading are indistinguishable by any content- or structure-based fingerprint, so
 * swapping one for another there remains undetectable. That residual gap is real but strictly
 * narrower than the one this fix closes, and is inherent to fingerprinting content that is
 * genuinely, deliberately duplicated -- no key built only from what the text says can tell two
 * byte-identical same-section occurrences apart.
 *
 * The wider fingerprint still trades a rare, safe failure mode for a real one it closes. Inserting
 * or removing an earlier same-group occurrence shifts every later occurrence's ordinal, and
 * rewording a heading's own text changes every finding under it, so an edit far from a finding that
 * never itself changed can still make `--update` see it as new-here/missing-there. That shows up as
 * demanding a baseline update for content that did not really regress -- a false positive, caught
 * by `--update` and fixed by running it. The narrower, heading-free scheme signals nothing when a
 * real occurrence is quietly swapped across sections -- a false negative, which is silent and is
 * exactly what this ratchet exists to rule out. Between a ratchet that is occasionally too strict
 * and one that can be silently fooled, only the first one is doing its job.
 *
 * This does not reopen the false positive `paragraphBounds` was added to close: that fix is about
 * `localContext`'s window reaching past a paragraph boundary into unrelated body text nearby, and
 * an edit to a neighbouring paragraph under the same, unrenamed heading still leaves every field of
 * `findingKey` unchanged -- verified directly, by editing a filler paragraph next to a finding while
 * leaving its heading untouched and confirming `dogfood lint holds`. Only editing the heading's own
 * text is newly in scope here, and that is a distinct, coarser-grained edit: this repository's own
 * headings partition fixtures and topics deliberately (see `fixtures/LICENSES.md`), so a rename is
 * closer to restructuring a section than to the incidental nearby-prose edits `paragraphBounds`
 * targets.
 */
export function findingKey(ruleId, message, context, heading, ordinal) {
  return [ruleId, message, context, heading, String(ordinal)].join(FINDING_KEY_SEPARATOR);
}

export function splitFindingKey(key) {
  const [ruleId, message, context] = key.split(FINDING_KEY_SEPARATOR);
  return { ruleId, message, context };
}

/**
 * Run the preset over every tracked `*.md` file and return, per file, how many times each distinct
 * finding (by `findingKey`) appears at error severity.
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

  const targets = discoverMarkdownFiles();

  let stdout;
  try {
    stdout = execFileSync(TEXTLINT_BIN, ['--config', CONFIG, '--format', 'json', ...targets], {
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
    const errorMessages = file.messages.filter((message) => message.severity === 2);
    if (errorMessages.length === 0) continue;
    // Read once per file with at least one error, not once per message.
    const source = readFileSync(file.filePath, 'utf8');
    // textlint reports messages in document order already; sorting by index makes that explicit
    // and correct even if that ever changes, since ordinal assignment depends on it.
    const ordered = [...errorMessages].toSorted((a, b) => a.index - b.index);
    const groupOrdinal = new Map();
    const findings = new Map();
    for (const message of ordered) {
      const context = localContext(source, message.index);
      const heading = nearestHeading(source, message.index);
      const groupKey = [message.ruleId, message.message, context, heading].join(
        FINDING_KEY_SEPARATOR,
      );
      const ordinal = (groupOrdinal.get(groupKey) ?? 0) + 1;
      groupOrdinal.set(groupKey, ordinal);
      const key = findingKey(message.ruleId, message.message, context, heading, ordinal);
      // Each key is now unique per file by construction (ordinal strictly increases within a
      // group), so this is always 1 -- kept as an accumulation, not a hardcoded 1, only so a
      // future change to key construction fails loudly here instead of silently overwriting.
      findings.set(key, (findings.get(key) ?? 0) + 1);
    }
    byFile.set(path, findings);
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
 * Every (file, findingKey) pair whose current count exceeds what `baseline` allows for it. Covers
 * both a brand-new finding (baseline count 0) and an existing one that got more frequent.
 */
export function findRegressions(byFile, baseline) {
  const regressions = [];
  for (const [path, findings] of byFile) {
    const allowed = baseline[path]?.findings ?? {};
    for (const [key, count] of findings) {
      const before = allowed[key] ?? 0;
      if (count > before) {
        const { ruleId, message } = splitFindingKey(key);
        regressions.push({ path, ruleId, message, before, after: count });
      }
    }
  }
  return regressions;
}

/**
 * Files present in the baseline whose recorded findings no longer match what linting currently
 * produces for them, in the improving direction: a finding key that dropped in count or vanished,
 * with no compensating growth elsewhere in the same file (`findRegressions` already covers growth).
 * Includes a file that became fully clean -- `byFile` simply has no entry for it in that case.
 *
 * This is what makes an improvement mandatory to record rather than optional: without it, fixing
 * some findings in a still-dirty file leaves slack in the baseline that a later change could spend
 * back by reintroducing exactly what was fixed, and assert mode would not notice either edit.
 */
export function findImprovements(byFile, baseline) {
  const improved = [];
  for (const path of Object.keys(baseline)) {
    const allowed = baseline[path].findings;
    const current = byFile.get(path);
    for (const [key, before] of Object.entries(allowed)) {
      const after = current?.get(key) ?? 0;
      if (after < before) improved.push(path);
    }
  }
  return [...new Set(improved)];
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
  const improved = findImprovements(byFile, baseline).filter((path) => !stale.includes(path));

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
  }
  if (improved.length > 0) {
    console.error('These files improved but the baseline still allows the old, higher count:');
    for (const path of improved) console.error('  ' + path);
  }
  if (stale.length > 0 || improved.length > 0) {
    console.error("Run 'node scripts/ci/check-dogfood-lint.mjs --update' and commit the result.");
  }

  if (added.length > 0 || regressions.length > 0 || stale.length > 0 || improved.length > 0) {
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
