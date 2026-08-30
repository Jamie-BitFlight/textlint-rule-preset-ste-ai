import { proseWords } from '../core/document.js';
import type { Sentence, SourceRange, TextBlock, Word } from '../core/types.js';

/**
 * Unicode bidirectional-control code points: the ones actually capable of reordering how
 * surrounding text visually renders (the Trojan Source attack class), rather than every character
 * Unicode classifies as "format" (`\p{Cf}`). Listed explicitly rather than derived from a broader
 * property, because `\p{Cf}` also contains characters with a real, local effect on the word they
 * sit inside — ZWJ (U+200D, joins emoji into one glyph), ZWNJ (U+200C, controls letter-joining in
 * Persian/Arabic script), soft hyphen — none of which move *surrounding* text the way a bidi
 * override does. `stripUnsafeCharacters` (below) used to strip the whole `\p{Cf}` category and, in
 * doing so, mangled exactly that class of legitimate rule-pack replacement text (confirmed
 * directly: stripping ZWJ from `👩‍🔧` produces `👩🔧`, a different emoji).
 *
 * ALM, LRM, RLM (U+061C, U+200E, U+200F): directional marks with no visible glyph of their own.
 * LRE/RLE/PDF/LRO/RLO (U+202A–U+202E) and LRI/RLI/FSI/PDI (U+2066–U+2069): the embedding, override
 * and isolate controls.
 */
const BIDI_CONTROL_CHARS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/**
 * Remove characters that make a supplier-controlled string actively dangerous once it is
 * interpolated into rendered output (a diagnostic `message`, a fix `rationale`) or written into a
 * document (a fix's actual replacement text) — not merely unusual-looking ones.
 *
 * Rule-pack text fields such as `preferred.to`, `unapproved.alternatives` and `note` carry no
 * format constraint in `src/rule-pack/schema.ts`. Unlike `metadata.id` (`src/core/rule-pack-id.ts`),
 * free display text cannot be reduced to an allowed character set without breaking legitimate
 * non-English terms, so this strips categories of character rather than a fixed list — closing the
 * class the way the id allowlist does, instead of chasing individual characters. Removed:
 * `\p{Cc}` (C0/C1 controls), {@link BIDI_CONTROL_CHARS} (bidirectional overrides and embeddings),
 * and `\p{Zl}`/`\p{Zp}` (line/paragraph separators) — every one of which can rewrite how
 * surrounding terminal or log output reads, or reorder text around it. General Unicode format
 * characters (`\p{Cf}`) outside that explicit list are left alone: a real word or replacement can
 * legitimately need one.
 *
 * The whitespace-shaped members of those categories — tab, newline, CR, vertical tab, form feed,
 * NEL (U+0085, a C1 control that is also a line break), and the two Unicode line/paragraph
 * separators — are normalised to an ordinary space rather than deleted outright, and normalised
 * *before* the rest of the category is stripped. This sanitizer runs on the actual replacement
 * text a fix writes into a document, not just display strings (`sanitizeQuotedValue`'s doc comment
 * on `note` is the display-only exception, not the rule) — so a legitimately schema-permitted pack
 * value like `sign\tin` or `do\nnot` deleting straight to `signin`/`donot` would silently glue two
 * words together, corrupting the actual suggestion and fix. Every other control character in these
 * categories has no legitimate word-internal role, so it is still deleted rather than replaced.
 */
const WHITESPACE_SHAPED_CONTROLS = /[\t\n\v\f\r\u0085\u2028\u2029]/gu;

export function stripUnsafeCharacters(text: string): string {
  return text
    .replace(WHITESPACE_SHAPED_CONTROLS, ' ')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '')
    .replace(BIDI_CONTROL_CHARS, '');
}

/**
 * As {@link stripUnsafeCharacters}, and also replaces a literal `"` with `'`.
 *
 * Use this only where the caller interpolates the result directly inside a double-quoted phrase in
 * the message template itself (`` `Use "${...}" instead of…` ``) — an embedded `"` would otherwise
 * let fabricated pack text visually escape that quoting. Free-standing text that the template does
 * not wrap in its own quotes (a `note` appended after the quoted phrase) should use
 * {@link stripUnsafeCharacters} instead: that text's own internal quoting (`Ambiguous: "it is" or
 * "it has".`) is legitimate authored prose, not an escape attempt, and rewriting it changes
 * correct, trusted message text for no safety benefit.
 */
export function sanitizeQuotedValue(text: string): string {
  return stripUnsafeCharacters(text).replace(/"/g, "'");
}

/**
 * Code-point count of a term, treating each internal whitespace run as a single unit, matching
 * how {@link escapeForMatching}/{@link sameTermSpan} actually treat whitespace.
 *
 * Used only as a *necessary* pre-filter for {@link findCaseConflicts}, never as a verdict on its
 * own: JS's `/iu` regex canonicalisation is confirmed directly to be one-code-point-to-one
 * (`new RegExp('^ß$', 'iu').test('ss')` is `false` — unlike full Unicode case folding, which
 * would expand `ß` to `ss`), so two strings `termPattern` actually treats as the same span always
 * have equal code-point length — *once whitespace is normalised the same way the matcher itself
 * normalises it*. `escapeForMatching` turns every whitespace run into a flexible `\s+` (matching
 * one or more characters, of any length, on either side), so `"foo bar"` and `"foo  bar"` are
 * `sameTermSpan`-equivalent despite differing raw code-point counts — confirmed directly, and a
 * real miss in an earlier version of this pre-filter, which bucketed by raw length and so never
 * even tested that pair against each other. Collapsing every whitespace run to one code point
 * before counting restores the invariant.
 *
 * A length match is still only ever a candidate to confirm with {@link sameTermSpan}, never a
 * substitute for it — equal length does not imply equivalence (ASCII `A` and fullwidth `Ａ` are
 * both length 1, and are visually/case-fold-similar enough that an NFKC-based canonicalisation
 * this function used to rely on falsely merged them, confirmed directly: `'Ａ'.normalize('NFKC')
 * .toLowerCase() === 'a'` while `/^A$/iu.test('Ａ')` is `false`).
 *
 * `Array.from` over a string iterates *code points*, not user-perceived grapheme clusters (an
 * `Intl.Segmenter` count), which is exactly what this needs: the invariant above is about
 * code-point count, not grapheme count.
 */
function codePointLength(term: string): number {
  return Array.from(term.trim().replace(/\s+/g, ' ')).length;
}

/**
 * Above this many entries sharing the same {@link codePointLength}, {@link findCaseConflicts}
 * reports that whole bucket as {@link CaseConflictScan.unchecked} instead of exhaustively
 * confirming it.
 *
 * The check is quadratic per length bucket, which is the DoS-shaped cost Codex's review on this PR
 * flagged (`additional` is reachable from an untrusted pack's own `rules[].options`, per
 * {@link reportCaseConflict}'s doc comment, so this is a real cost an untrusted pack can impose,
 * not only an operator's own mistake) — reproduce the shape with a same-length benchmark of a few
 * thousand entries rather than trusting a one-off measurement committed here. Silently treating an
 * oversized bucket as conflict-free was
 * tried first and rejected on review: a bucket this large could still contain a genuine conflict
 * (`Foo`/`foo` among 500 unrelated same-length keys, say), and reporting "no conflict" without
 * having checked is a false all-clear. Failing the rule instead, honestly naming the bucket as
 * unverified, is the safer default — {@link reportUncheckedGroup} is the caller-side half of this.
 */
const EXHAUSTIVE_FOLD_SCAN_LIMIT_PER_LENGTH = 500;

/**
 * Total pairwise `sameTermSpan` comparisons {@link findCaseConflicts} will attempt across every
 * length bucket combined, not just within any one bucket.
 *
 * {@link EXHAUSTIVE_FOLD_SCAN_LIMIT_PER_LENGTH} alone bounds cost per bucket, but not in total: an
 * untrusted pack can keep every bucket at exactly that limit and supply arbitrarily many buckets
 * — Codex's review on this PR flagged exactly this shape (many buckets, each individually within
 * the per-bucket limit). `test/unit/rules.test.ts`'s "bounds total cost across many buckets" test
 * reproduces the adversarial shape and asserts a wall-clock ceiling directly, rather than this
 * comment committing a one-off measurement that would drift from the real cost as the
 * implementation or runtime changes. Once processing a bucket would push the running total over
 * this budget, that bucket (and every one after it) is reported as
 * {@link CaseConflictScan.unchecked} instead of partially or fully processed — the same
 * fail-closed behaviour as one bucket over the per-length limit, just budgeted globally instead of
 * per length. The chosen value leaves room for several buckets at the per-length cap, or many more
 * smaller ones, before the budget is spent.
 *
 * This counts comparisons, not the work each one costs — see {@link MAX_TOTAL_COMPARISON_WORK} for
 * the budget that closes that gap.
 */
const MAX_TOTAL_COMPARISONS = 500_000;

/**
 * Total `pairs × key-length` work {@link findCaseConflicts} will attempt across every length
 * bucket combined, alongside (not instead of) {@link MAX_TOTAL_COMPARISONS}.
 *
 * {@link MAX_TOTAL_COMPARISONS} treats every `sameTermSpan` comparison as equal-cost, but a regex
 * match's cost scales with the length of the strings it matches — Codex's review on this PR found
 * that a bucket comfortably within the pair-count budget can still be expensive if its keys are
 * individually very long, so the whole bucket's cost scales with `pairs × length`, not `pairs`
 * alone.
 *
 * The length used is each bucket's *raw, untrimmed* code-point count (tracked alongside the bucket
 * during grouping), not {@link codePointLength} — two follow-up rounds of the same review each
 * found a different way the collapsed/trimmed length under-charges the real cost:
 *
 * - `codePointLength` collapses a long *internal* whitespace run to one unit, but
 *   `escapeForMatching`/{@link sameTermSpan} still scan every one of those whitespace characters
 *   on every comparison, so a key built almost entirely of internal whitespace bucketed (and
 *   costed) as short.
 * - Trimming *leading/trailing* whitespace before measuring hid the same problem in the other
 *   direction: `escapeForMatching`'s own `.trim()` call, and `sameTermSpan`'s `b.trim()`, each cost
 *   time proportional to the *untrimmed* length regardless of how much they strip, so a key with a
 *   long leading or trailing run was still expensive to re-trim on every comparison even though the
 *   trimmed result was short.
 *
 * Charging the collapsed or trimmed length would have let either shape bypass this budget.
 * `test/unit/rules.test.ts`'s "bounds total cost by key length", "...uncollapsed whitespace", and
 * "...untrimmed length" tests reproduce all three shapes directly, rather than this comment
 * committing a one-off measurement. Once a bucket's own or the running weighted total would exceed
 * this budget, it is reported as {@link CaseConflictScan.unchecked} the same way as the other two
 * limits.
 */
const MAX_TOTAL_COMPARISON_WORK = 25_000_000;

/**
 * One {@link CaseConflictScan.unchecked} group, naming both its keys and *why* they went
 * unconfirmed — a bucket that individually exceeds {@link EXHAUSTIVE_FOLD_SCAN_LIMIT_PER_LENGTH}
 * is a different situation for a caller (and a reader of the resulting notice) than a
 * comfortably-sized bucket that only lost out to the total {@link MAX_TOTAL_COMPARISONS} or
 * {@link MAX_TOTAL_COMPARISON_WORK} budget because earlier buckets already spent most of it, or a
 * bucket whose keys were too long for the underlying regex engine to compare at all (`'comparison-
 * failed'`; see the `try`/`catch` in {@link findCaseConflicts}) — collapsing all three into one
 * shape would report the wrong constraint as the reason a rule got skipped.
 */
export interface UncheckedGroup {
  /** The keys in this bucket, unconfirmed either way. */
  readonly keys: string[];
  /** Which limit stopped this bucket from being checked. */
  readonly reason: 'bucket-too-large' | 'total-budget-exceeded' | 'comparison-failed';
}

/** {@link findCaseConflicts}'s result: confirmed conflicts, and buckets too large to confirm. */
export interface CaseConflictScan {
  /** Groups confirmed, via the real matcher, to map to different values. */
  readonly conflicts: string[][];
  /** Groups whose case-conflict status was never determined; see {@link UncheckedGroup.reason}. */
  readonly unchecked: UncheckedGroup[];
}

/**
 * Group the keys of a term map by case-fold equivalence and report every group whose members do
 * not all resolve to the same value.
 *
 * `termPattern()` matches case-insensitively, so `Use` and `use` claim the same source span; the
 * first one in object key order silently wins and the other's mapping never applies. That is only
 * a real conflict when the two keys disagree about the replacement — `{ Use: ['employ'], use:
 * ['employ'] }` is redundant but not contradictory.
 *
 * Every reported conflict is confirmed with {@link sameTermSpan} — the actual matcher — rather
 * than a cheaper canonicalisation, because a canonicalisation broad enough to catch every case
 * `sameTermSpan` recognises (Greek final sigma, the Latin long s) is also broad enough to falsely
 * merge keys the matcher treats as distinct (ASCII/fullwidth Latin letters); see
 * {@link codePointLength}'s doc comment for both confirmed examples. {@link codePointLength}
 * narrows the candidates checked, as a size (not a correctness) optimisation.
 */
export function findCaseConflicts<T>(
  entries: Readonly<Record<string, T>>,
  valuesEqual: (a: T, b: T) => boolean,
): CaseConflictScan {
  const items = Object.entries(entries);

  const byLength = new Map<number, { bucket: [key: string, value: T][]; maxRawLength: number }>();
  for (const item of items) {
    const length = codePointLength(item[0]);
    const rawLength = Array.from(item[0]).length;
    const entry = byLength.get(length);
    if (entry === undefined) byLength.set(length, { bucket: [item], maxRawLength: rawLength });
    else {
      entry.bucket.push(item);
      if (rawLength > entry.maxRawLength) entry.maxRawLength = rawLength;
    }
  }

  const groups: [key: string, value: T][][] = [];
  const unchecked: UncheckedGroup[] = [];
  let comparisonsSpent = 0;
  let workSpent = 0;
  for (const { bucket, maxRawLength } of byLength.values()) {
    if (bucket.length > EXHAUSTIVE_FOLD_SCAN_LIMIT_PER_LENGTH) {
      unchecked.push({ keys: bucket.map(([key]) => key), reason: 'bucket-too-large' });
      continue;
    }
    const bucketCost = (bucket.length * (bucket.length - 1)) / 2;
    const bucketWork = bucketCost * maxRawLength;
    if (
      comparisonsSpent + bucketCost > MAX_TOTAL_COMPARISONS ||
      workSpent + bucketWork > MAX_TOTAL_COMPARISON_WORK
    ) {
      unchecked.push({ keys: bucket.map(([key]) => key), reason: 'total-budget-exceeded' });
      continue;
    }
    comparisonsSpent += bucketCost;
    workSpent += bucketWork;
    // `sameTermSpan` compiles a `RegExp` from each key, and the underlying engine refuses to
    // compile one past its own internal size limit — a version-specific threshold this comment
    // does not pin a number to; `test/unit/rules.test.ts`'s "degrades to unchecked instead of
    // crashing" test reproduces the failure directly on whatever engine runs it. Neither
    // `MAX_TOTAL_COMPARISONS` nor `MAX_TOTAL_COMPARISON_WORK` catches this: a bucket of just two
    // such keys costs one comparison, comfortably under both budgets. Uncaught, that exception
    // would escape this whole function, then the `superRefine` callback calling it, then
    // `safeParse` itself, crashing the run instead of the schema-validation failure this rule is
    // supposed to degrade to. Buffer this bucket's groups locally and only merge them in on
    // success, so a bucket that fails partway through reports honestly as
    // {@link CaseConflictScan.unchecked} rather than contributing a
    // partial, silently-incomplete scan.
    try {
      const bucketGroups: [key: string, value: T][][] = [];
      const consumed = new Set<number>();
      for (let i = 0; i < bucket.length; i++) {
        if (consumed.has(i)) continue;
        const current = bucket[i];
        if (current === undefined) continue;
        const group: [string, T][] = [current];
        consumed.add(i);
        for (let j = i + 1; j < bucket.length; j++) {
          if (consumed.has(j)) continue;
          const candidate = bucket[j];
          if (candidate === undefined) continue;
          if (sameTermSpan(current[0], candidate[0])) {
            group.push(candidate);
            consumed.add(j);
          }
        }
        bucketGroups.push(group);
      }
      groups.push(...bucketGroups);
    } catch {
      unchecked.push({ keys: bucket.map(([key]) => key), reason: 'comparison-failed' });
    }
  }

  const conflicts: string[][] = [];
  for (const group of groups) {
    if (group.length < 2) continue;
    const first = group[0];
    if (first === undefined) continue;
    const [, firstValue] = first;
    if (group.some(([, value]) => !valuesEqual(value, firstValue))) {
      conflicts.push(group.map(([key]) => key));
    }
  }
  return { conflicts, unchecked };
}

/**
 * Minimal shape `ctx.addIssue` needs, matching zod v4's `$RefinementCtx` — kept structural so this
 * helper does not depend on zod's internal types directly.
 */
export interface IssueReporter {
  addIssue(issue: { code: 'custom'; path: PropertyKey[]; message: string }): void;
}

/**
 * Report one `findCaseConflicts` group through a `superRefine` context, naming the conflicting
 * keys.
 *
 * The keys themselves are supplier-controlled in the same sense `preferred.to`/`unapproved
 * .alternatives` are (`options.additional` is user config, but `rule.optionsSchema.safeParse`
 * also runs against `packSpec.options` — src/core/runner.ts's `rawOptions = { ...packSpec
 * ?.options, ...stripControlKeys(userConfig) }` — and `rulePackRuleSpecSchema.options` is an
 * unconstrained `z.record(z.string(), z.unknown())`, src/rule-pack/schema.ts). This message is
 * rendered verbatim by the CLI and the textlint adapter's notice reporting, the same as
 * `Diagnostic.message`, so the keys go through {@link sanitizeQuotedValue} before interpolation.
 */
export function reportCaseConflict(
  ctx: IssueReporter,
  group: readonly string[],
  noun: 'alternatives' | 'replacements',
): void {
  ctx.addIssue({
    code: 'custom',
    path: ['additional'],
    message:
      `${group.map((key) => `"${sanitizeQuotedValue(key)}"`).join(' and ')} are case-equivalent ` +
      `keys that resolve to the same source span but map to different ${noun}.`,
  });
}

/**
 * Report one `findCaseConflicts` {@link CaseConflictScan.unchecked} group: keys that could not be
 * confirmed, one way or the other, whether any of them collide.
 *
 * The message names which limit stopped the check ({@link UncheckedGroup.reason}) rather than
 * always blaming this group's own length: a bucket well under
 * {@link EXHAUSTIVE_FOLD_SCAN_LIMIT_PER_LENGTH} can still end up unchecked if earlier buckets
 * already spent most of {@link MAX_TOTAL_COMPARISONS} or {@link MAX_TOTAL_COMPARISON_WORK}, and
 * telling that caller "too many keys share this length" would misidentify the actual constraint
 * and the actual fix (reduce keys overall, or their length, not just how many share this length).
 *
 * Names a sample rather than every key, both because the full list can be long and because each
 * key is display text (see {@link reportCaseConflict}'s doc comment on provenance) sanitized the
 * same way.
 */
export function reportUncheckedGroup(
  ctx: IssueReporter,
  group: UncheckedGroup,
  noun: 'alternatives' | 'replacements',
): void {
  const sample = group.keys
    .slice(0, 3)
    .map((key) => `"${sanitizeQuotedValue(key)}"`)
    .join(', ');
  let message: string;
  if (group.reason === 'bucket-too-large') {
    message =
      `${group.keys.length} keys (for example ${sample}) are the same length once whitespace ` +
      `runs are normalised — too many to exhaustively check for a case-insensitive collision ` +
      `over their ${noun}. Reduce how many keys share this length, or split them across more ` +
      'than one rule configuration.';
  } else if (group.reason === 'total-budget-exceeded') {
    message =
      `${group.keys.length} keys (for example ${sample}) could not be checked for a ` +
      `case-insensitive collision over their ${noun}: checking them would exceed the total ` +
      `comparison budget shared across every key length in this "additional" map, even though ` +
      'this group alone is well within the per-length limit. Reduce the total number of keys, ' +
      'their length, or split them across more than one rule configuration.';
  } else {
    message =
      `${group.keys.length} keys (for example ${sample}) could not be checked for a ` +
      `case-insensitive collision over their ${noun}: at least one of them is too long for the ` +
      'underlying matcher to compare. Shorten these keys, or split them across more than one ' +
      'rule configuration.';
  }
  ctx.addIssue({ code: 'custom', path: ['additional'], message });
}

/** Escape regex metacharacters and collapse whitespace runs to a flexible `\s+`. */
function escapeForMatching(term: string): string {
  return term
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
}

/** Build a whole-word, case-insensitive matcher for a term or multi-word phrase. */
export function termPattern(term: string): RegExp {
  const escaped = escapeForMatching(term);
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu');
}

/**
 * Whether `a` and `b` are the same term for `termPattern()`'s matching purposes — not merely
 * `String.prototype.toLowerCase()`-equal.
 *
 * `/iu` implements full Unicode case folding, which is not the same relation `toLowerCase()`
 * computes: `/s/iu` matches the Latin small letter long s (`ſ`, U+017F), but `'s'.toLowerCase()
 * !== 'ſ'.toLowerCase()` — confirmed directly. A case-conflict check keyed on `toLowerCase()`
 * would therefore miss a real collision between `additional` keys `s` and `ſ`, or their Greek and
 * Turkish counterparts, leaving exactly the "object key order silently decides" ambiguity #125
 * exists to reject. This asks the same regex engine `findTerm` actually uses, anchored to the
 * whole string on both sides, rather than reimplementing its notion of "the same letter".
 */
export function sameTermSpan(a: string, b: string): boolean {
  return new RegExp(`^${escapeForMatching(a)}$`, 'iu').test(b.trim());
}

export interface TermMatch {
  readonly range: SourceRange;
  readonly text: string;
}

/**
 * Find every occurrence of `term` in a sentence.
 *
 * Matching runs against `sentence.masked`, so a term can never match inside protected content.
 * Returned ranges are absolute offsets into the source document.
 */
export function findTerm(sentence: Sentence, term: string): TermMatch[] {
  const out: TermMatch[] = [];
  for (const m of sentence.masked.matchAll(termPattern(term))) {
    const start = sentence.range.start + m.index;
    out.push({ range: { start, end: start + m[0].length }, text: m[0] });
  }
  return out;
}

/**
 * Apply the source's capitalisation to a replacement.
 *
 * `Utilise` → `Use`, `UTILISE` → `USE`, `utilise` → `use`.
 */
export function matchCapitalisation(source: string, replacement: string): string {
  if (source.length === 0) return replacement;
  const isUpper = source === source.toUpperCase() && /[A-Z]/.test(source);
  if (isUpper) return replacement.toUpperCase();
  const first = source[0];
  if (first !== undefined && first === first.toUpperCase() && first !== first.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/** Prose words of a sentence: protected tokens removed. */
export function sentenceProseWords(sentence: Sentence): Word[] {
  return proseWords(sentence.words);
}

/** A short excerpt for the `evidence` field, collapsed to one line. */
export function excerpt(text: string, max = 120): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

/** Sibling list items: same depth, contiguous in document order, all `list-item`. */
export function groupSiblingListItems(blocks: readonly TextBlock[]): TextBlock[][] {
  const groups: TextBlock[][] = [];
  let current: TextBlock[] = [];
  let currentDepth = -1;
  for (const block of blocks) {
    if (block.kind !== 'list-item') {
      if (current.length > 0) groups.push(current);
      current = [];
      currentDepth = -1;
      continue;
    }
    if (current.length === 0 || block.depth === currentDepth) {
      current.push(block);
      currentDepth = block.depth;
    } else {
      groups.push(current);
      current = [block];
      currentDepth = block.depth;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups.filter((g) => g.length >= 2);
}
