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
 */
export function stripUnsafeCharacters(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '').replace(BIDI_CONTROL_CHARS, '');
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
 * Fast-path canonical form for {@link findCaseConflicts}'s grouping: NFKC folds some
 * compatibility variants `toLowerCase()` alone does not (confirmed directly: `'ſ'.normalize
 * ('NFKC').toLowerCase() === 's'`, unifying the Latin long s with plain `s`), which is exactly
 * the pair Codex's review on this PR flagged `toLowerCase()`-only grouping for missing.
 */
function canonicalKey(term: string): string {
  return term.trim().normalize('NFKC').toLowerCase();
}

/**
 * Above this many `additional` entries, {@link findCaseConflicts} skips the exhaustive pairwise
 * merge below and returns {@link canonicalKey}'s grouping alone.
 *
 * That merge step exists only for a case-fold pair `canonicalKey` itself does not unify — Greek
 * final sigma `ς`/`σ` is the standing example (confirmed directly: `'ς'.normalize('NFKC')
 * .toLowerCase() !== 'σ'.toLowerCase()`, but `termPattern`'s `/iu` regex does treat them as the
 * same letter). Finding every such pair exhaustively means testing every remaining group against
 * every other, which is quadratic in the number of *distinct spellings* after canonicalisation —
 * measured directly at roughly 800ms for 2,000 pairwise-distinct entries, the DoS-shaped cost
 * Codex's review on this PR flagged in the pairwise-only version of this function. `additional`
 * maps are operator- or pack-authored vocabulary lists; one this large is already unusual, so
 * degrading to canonical-only grouping (which still catches every conflict this function shipped
 * with before this pairwise refinement existed) is an acceptable trade against stalling a lint run.
 */
const EXHAUSTIVE_FOLD_MERGE_LIMIT = 500;

/**
 * Group the keys of a term map by case-fold equivalence and report every group whose members do
 * not all resolve to the same value.
 *
 * `termPattern()` matches case-insensitively, so `Use` and `use` claim the same source span; the
 * first one in object key order silently wins and the other's mapping never applies. That is only
 * a real conflict when the two keys disagree about the replacement — `{ Use: ['employ'], use:
 * ['employ'] }` is redundant but not contradictory.
 */
export function findCaseConflicts<T>(
  entries: Readonly<Record<string, T>>,
  valuesEqual: (a: T, b: T) => boolean,
): string[][] {
  const items = Object.entries(entries);

  // Fast path: O(n) grouping by canonical form, catching every plain-case and NFKC-decomposable
  // pair (which covers everything `String.prototype.toLowerCase()` alone caught, plus more).
  const byCanonical = new Map<string, [key: string, value: T][]>();
  for (const item of items) {
    const canonical = canonicalKey(item[0]);
    const group = byCanonical.get(canonical);
    if (group === undefined) byCanonical.set(canonical, [item]);
    else group.push(item);
  }
  let groups = [...byCanonical.values()];

  // Precise path: merge any remaining groups `sameTermSpan` still considers equivalent, bounded
  // so an unusually large map degrades to the fast path alone instead of stalling.
  if (items.length <= EXHAUSTIVE_FOLD_MERGE_LIMIT) {
    const merged: typeof groups = [];
    const consumed = new Set<number>();
    for (let i = 0; i < groups.length; i++) {
      if (consumed.has(i)) continue;
      let combined = groups[i];
      if (combined === undefined) continue;
      consumed.add(i);
      for (let j = i + 1; j < groups.length; j++) {
        if (consumed.has(j)) continue;
        const candidate = groups[j];
        const combinedFirst = combined[0];
        if (candidate === undefined || combinedFirst === undefined) continue;
        const candidateFirst = candidate[0];
        if (candidateFirst === undefined) continue;
        if (sameTermSpan(combinedFirst[0], candidateFirst[0])) {
          combined = [...combined, ...candidate];
          consumed.add(j);
        }
      }
      merged.push(combined);
    }
    groups = merged;
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
  return conflicts;
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
