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
 * how PR #100 went round after round of review -- each round fixed the file the reviewer named,
 * and nothing mechanical said whether the rest of the corpus still held.
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
 *     identical SQLite public-domain licence statement, verbatim, across separate fixtures. No
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
 *     also folds in `nearestHeading`, the finding's enclosing section, which the LICENSES.md
 *     occurrences turn out to already have one each of, distinct from one another. See
 *     `findingKey`'s own comment for what this closes and what it still, honestly, does not.
 *   - The paragraph clamp closed the neighbouring-block case, but not the case one level down:
 *     an earlier, unrelated sentence in the *same* paragraph can still sit within `CONTEXT_RADIUS`
 *     of an untouched violation later in it. Reproduced directly: fixing a filler sentence ahead of
 *     an untouched semicolon violation, in the same paragraph, still changed the violation's key --
 *     reported as both a regression and an improvement for a cleanup that never touched it.
 *     `localContext` now clamps to the sentence the finding sits in (see `sentenceBounds`), inside
 *     the existing paragraph clamp, so an edit to a different sentence in the same paragraph no
 *     longer reaches it.
 *   - `--update` refused to create a first baseline at all: with no file on disk, it compared every
 *     current finding against `{}`, so the entire dirty corpus counted as a regression and the run
 *     failed without `--accept-regressions` -- contradicting the assert-mode message telling a
 *     contributor to run `--update` to create the missing file. `--update` now only guards against
 *     regressions when a baseline already exists (see `regressionsToGuard`); creating one for the
 *     first time needs no flag beyond `--update` itself.
 *
 * `scripts/ci/dogfood-lint-baseline.json` -- not this script -- is machine-written and not meant to
 * be hand-edited, the same way `fixtures/provenance.lock.json` is (see `docs/fixtures.md`): both
 * exist so a change that affects their subject is a reviewable diff, not so a human composes them
 * by hand.
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
 *
 * The line terminator is `\r?\n`, not a bare `\n`: review found the bare-`\n` pattern never
 * matching a CRLF blank line (`\r\n\r\n`, since the first line's `\r` sits between the two `\n`
 * characters and is not `[ \t]`), so on a CRLF checkout this returned the whole document as one
 * "paragraph" -- widening `localContext`'s clamp back to the unbounded window it exists to
 * prevent, for the platform where its baseline was never generated.
 */
export function paragraphBounds(source, index) {
  const blankLine = /(\r?\n)[ \t]*\r?\n/g;
  let start = 0;
  for (const match of source.matchAll(blankLine)) {
    const boundary = match.index + match[0].length - 1; // keep the second line terminator's '\n' out
    if (boundary > index) break;
    start = boundary;
  }
  blankLine.lastIndex = index;
  const next = blankLine.exec(source);
  // Include the first line terminator of the pair -- its own captured length, not a hard-coded 1,
  // since it is `\r\n` on a CRLF checkout and `\n` on an LF one.
  const end = next === null ? source.length : next.index + next[1].length;
  return { start, end };
}

/**
 * The bounds of the sentence `index` sits inside, clamped to the paragraph containing it (see
 * `paragraphBounds`): the offset just after the nearest `.`, `!`, or `?` before `index` that is
 * followed by whitespace or the paragraph's end, and the offset of the nearest one at or after
 * `index`.
 *
 * This is a heuristic, not a real sentence segmenter: an abbreviation, a decimal, or a version
 * number can end in a period this treats as a sentence boundary. That only ever narrows the
 * window, though, never widens or misplaces it -- the returned range still contains `index`, and
 * it is still clamped inside the paragraph either way. A real segmenter
 * (`src/core/segmentation.ts`) needs a masking pass first, to stop exactly those characters from
 * being misread; this script has no reason to carry that machinery for a fingerprint window.
 */
export function sentenceBounds(source, index) {
  const { start: paraStart, end: paraEnd } = paragraphBounds(source, index);
  const terminator = /[.!?](?=\s|$)/g;
  let start = paraStart;
  for (const match of source.slice(paraStart, index).matchAll(terminator)) {
    start = paraStart + match.index + 1;
  }
  const next = terminator.exec(source.slice(index, paraEnd));
  const end = next === null ? paraEnd : index + next.index + 1;
  return { start, end };
}

/**
 * A short, whitespace-normalized slice of `source` centered on `index`, clamped to the sentence
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
 * into a neighbouring block a cleanup edit is actually likely to touch.
 *
 * The paragraph clamp alone was not enough: review reproduced the same false identity change one
 * level down, from editing an earlier, unrelated sentence in the *same* paragraph -- close enough
 * to an untouched violation that `CONTEXT_RADIUS` still reached back into the edited text, so
 * `findRegressions` and `findImprovements` both reported the untouched violation as changed. The
 * sentence clamp closes that: an edit to a different sentence in the same paragraph no longer
 * reaches a violation's own window at all. It does not fully retire `CONTEXT_RADIUS`:
 * `fixtures/LICENSES.md`'s colliding fixtures sit inside one long sentence-free bullet paragraph,
 * so the radius still bounds the key's size there, and `findingKey`'s ordinal still disambiguates
 * repeats within one sentence.
 */
export function localContext(source, index) {
  const { start: sentStart, end: sentEnd } = sentenceBounds(source, index);
  const start = Math.max(sentStart, index - CONTEXT_RADIUS);
  const end = Math.min(sentEnd, index + CONTEXT_RADIUS);
  return source.slice(start, end).replace(/\s+/g, ' ').trim();
}

/**
 * Byte ranges of fenced code blocks (``` or ~~~, three or more, up to three leading spaces),
 * paired with a same-character closing fence at least as long, per CommonMark. An unclosed fence
 * runs to the end of the source, since that is what every Markdown renderer already treats the
 * rest of the file as.
 *
 * An opening fence may carry an info string after the marker (` ```js `); a closing fence may not
 * -- CommonMark requires only trailing spaces or tabs there. Review found this treating both the
 * same way, so a code line that happens to start with the same marker followed by other text (a
 * fenced example showing ` ```not-a-closing-fence `) closed the range early. Everything after that
 * false close, up to the *real* closing fence, then read as ordinary prose again, so a heading-
 * shaped line still inside the block was accepted as real. A line is only treated as a close while
 * a fence is open and it has nothing but whitespace after the marker; any other fence-marker-shaped
 * line while open is ordinary code content and does not affect the open state at all.
 *
 * `[^\n]*` captures a trailing `\r` on a CRLF checkout, since `\r` is not `\n`. Review found the
 * whitespace-only check rejecting that `\r` the same way it rejects real trailing text, so every
 * closing fence in a CRLF file failed to close and the open range ran to EOF -- silently dropping
 * every later heading from `nearestHeading`'s view. An optional trailing `\r` is accepted alongside
 * spaces and tabs, matching how a line actually ends on either line-ending style.
 *
 * Per CommonMark, a backtick fence's info string may not itself contain a backtick -- a line like
 * that is not a fence at all, opening or closing, and is ordinary content instead. Only a tilde
 * fence's info string may contain backticks. Review found this line unconditionally treated as an
 * opening fence whenever no fence was already open, regardless of its marker character, so a code
 * example whose backtick-fence info string happened to contain a backtick opened a fence that
 * never legitimately closed, running to EOF and hiding every later heading the same way an
 * unclosed fence always does.
 */
function fencedCodeRanges(source) {
  const fenceLine = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/gm;
  const ranges = [];
  let open = null;
  for (const match of source.matchAll(fenceLine)) {
    const marker = match[1];
    const rest = match[2];
    if (open === null) {
      if (marker[0] === '`' && rest.includes('`')) continue;
      open = { char: marker[0], length: marker.length, start: match.index };
    } else if (
      marker[0] === open.char &&
      marker.length >= open.length &&
      /^[ \t]*\r?$/.test(rest)
    ) {
      ranges.push({ start: open.start, end: match.index + match[0].length });
      open = null;
    }
  }
  if (open !== null) ranges.push({ start: open.start, end: source.length });
  return ranges;
}

/**
 * The nearest Markdown ATX heading (`#` through `######`) at or before `index`, trimmed, or the
 * empty string when `index` sits before the file's first heading.
 *
 * This is a structural anchor: unlike `localContext`, it does not shrink or shift when unrelated
 * prose is edited elsewhere in the same section, and unlike `ordinal` (see `findingKey`), it stays
 * tied to which section a finding lives in rather than to how many identical findings happen to
 * precede it in document order.
 *
 * Review found the raw regex treating a heading-shaped line inside a fenced code block (`# example`
 * in a documentation snippet) as a real heading, so editing only that unrelated code example changed
 * an untouched finding's key -- reported as both a regression and an improvement, and demanding
 * `--accept-regressions` for a cleanup that never touched the finding at all. Reproduced directly: a
 * real heading, a fenced block containing `# example`, then a violation -- `nearestHeading` returned
 * `"# example"` instead of the real enclosing heading. A heading-shaped match inside a fenced range
 * is now skipped rather than accepted.
 *
 * Review also found the regex requiring the `#` to start at column zero, when CommonMark permits up
 * to three leading spaces on an ATX heading (the same allowance `fencedCodeRanges` already gives a
 * fence marker). A heading indented by one to three spaces was invisible to this function entirely,
 * so a finding moved from a heading at column zero to one indented under a list or blockquote kept
 * the same fingerprint as if it had no enclosing heading at all -- silently defeating the
 * cross-heading regression guard `findingKey` relies on this function for.
 *
 * Review also found this recognizing only ATX headings (`# Text`), when CommonMark also permits
 * Setext headings (a text line followed by an `=`- or `-`-only underline). A finding moved between
 * two differently named Setext sections kept the same enclosing-heading component (whatever ATX
 * heading precedes both, or none), silently defeating the same cross-heading guard. Both forms are
 * now collected and merged by position before picking the nearest one at or before `index`.
 *
 * Review also found the ATX pattern requiring the (up to 3) leading spaces to reach the `#`
 * directly, when CommonMark also permits an ATX heading inside a block quote (`> # Alpha`, or
 * nested, `> > # Alpha`). A finding moved from one blockquoted heading's section to a differently
 * named one kept the same empty-heading key, silently defeating the same cross-heading guard. Any
 * number of leading `>` markers (each optionally followed by a space, per CommonMark) is now
 * accepted before the existing leading-space allowance; the returned heading text excludes the
 * blockquote markers themselves, keeping the same `"# Text"` shape a non-blockquoted ATX heading
 * already returns.
 */
export function nearestHeading(source, index) {
  const fenced = fencedCodeRanges(source);
  const atx = /^(?:[ \t]{0,3}>[ \t]?)*([ \t]{0,3}#{1,6}[ \t]+.*)$/gm;
  const setext = /^ {0,3}([^\s#][^\n]*)\n {0,3}(=+|-+)[ \t]*$/gm;
  const matches = [];
  for (const match of source.matchAll(atx)) {
    matches.push({ index: match.index, text: match[1].trim() });
  }
  for (const match of source.matchAll(setext)) {
    matches.push({ index: match.index, text: match[1].trim() });
  }
  matches.sort((a, b) => a.index - b.index);
  let found = '';
  for (const match of matches) {
    if (match.index > index) break;
    if (fenced.some((range) => match.index >= range.start && match.index < range.end)) continue;
    found = match.text;
  }
  return found;
}

/**
 * `ruleId`, `message`, a local-context fingerprint, the enclosing heading, and an occurrence
 * ordinal joined into one baseline key, with a separator that cannot appear in `ruleId`,
 * `message`, the local-context fingerprint, or the enclosing heading: `message` is a single-line
 * string, `localContext` and `nearestHeading` both collapse or exclude newlines, and `ordinal` is a
 * decimal integer.
 *
 * The heading and the ordinal close two different gaps in the same problem: `localContext` alone
 * is not always unique within a file. Review found `fixtures/LICENSES.md` quoting the identical
 * SQLite public-domain licence statement verbatim across separate fixtures -- same rule, same
 * message, same surrounding text, because the surrounding text really is byte-identical, not
 * merely similarly shaped. No context radius fixes that.
 *
 * A first fix used only an ordinal: each finding's 1-based position among findings sharing the
 * same `(ruleId, message, context)` triple, assigned in document order. Review then found that
 * scheme still misses a swap: removing one of several identical occurrences and introducing an
 * identical one elsewhere in the file regenerates ordinals 1..N for whatever set remains, so
 * `findRegressions` and `findImprovements` both see no change -- confirmed by reproducing exactly
 * that swap between two headings and observing `dogfood lint holds` when a real defect had moved.
 * The LICENSES.md occurrences turned out to already sit each under its own distinct heading, so
 * folding in `nearestHeading` gives each one a key the others do not share, and a cross-heading
 * swap now changes two keys' counts instead of zero.
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
 * A repo-relative path, forward-slash-separated regardless of the host OS.
 *
 * `path.relative()` returns backslash-separated paths on Windows, but `discoverMarkdownFiles()`
 * (via `git ls-files`) and the committed baseline both always use forward slashes -- on Windows a
 * baseline key built from the raw `relative()` result would never match either, so every nested
 * dirty file would look new and every existing nested baseline entry would look stale.
 */
export function toForwardSlashes(path) {
  return path.replaceAll('\\', '/');
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
    const path = toForwardSlashes(relative(REPO_ROOT, file.filePath));
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
 * a brand-new finding (baseline count 0, whether because the file has no baseline entry at all or
 * because an existing entry never allowed this specific finding) and an existing one that got more
 * frequent.
 *
 * A file with no baseline entry at all is deliberately covered here too, not exempted: the
 * module's own contract above states new and renamed files cannot add debt, and only
 * `--accept-regressions` records it deliberately. Review first found this function silently
 * absorbing a brand-new file's debt into a baseline that already exists (treating "no prior
 * baseline entry" the same as the true bootstrap case, where the whole baseline file is missing --
 * see `regressionsToGuard`'s own comment for why that one case really is exempt), which let an
 * ordinary `--update` for an unrelated cleanup silently also record a new dirty file's debt with no
 * `--accept-regressions` confirmation at all -- exactly the "record new debt without deliberate
 * confirmation" defect this whole guard exists to prevent. `main()`'s `added` list separately names
 * the file so the contributor sees it either way.
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

/**
 * Regressions `--update` must refuse to write without `--accept-regressions`.
 *
 * Review found `--update` comparing every current finding against `{}` whenever the baseline file
 * did not exist yet, so it classified the entire dirty corpus as regressions and refused to run --
 * contradicting the assert-mode message (below) that says `--update` alone creates the file. A
 * missing baseline has no prior state to regress from: writing one for the first time is creation,
 * not growth, so it needs no guard at all.
 */
export function regressionsToGuard(byFile, baselineExists, existing) {
  return baselineExists ? findRegressions(byFile, existing) : [];
}

function main() {
  const update = process.argv.includes('--update');
  const acceptRegressions = process.argv.includes('--accept-regressions');
  const byFile = lint();
  if (byFile === undefined) return;

  if (update) {
    const baselineExists = existsSync(BASELINE_PATH);
    const existing = baselineExists ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {};
    const regressions = regressionsToGuard(byFile, baselineExists, existing);

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
    console.error('Fix them, or record the debt deliberately with --update --accept-regressions.');
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
