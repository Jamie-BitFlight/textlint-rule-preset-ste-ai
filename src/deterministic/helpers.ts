import { proseWords } from '../core/document.js';
import type { Sentence, SourceRange, TextBlock, Word } from '../core/types.js';

/**
 * Remove characters that make a supplier-controlled string actively dangerous once it is
 * interpolated into rendered output (a diagnostic `message`, a fix `rationale`) — not merely
 * unusual-looking ones.
 *
 * Rule-pack text fields such as `preferred.to`, `unapproved.alternatives` and `note` carry no
 * format constraint in `src/rule-pack/schema.ts`. Unlike `metadata.id` (`src/core/rule-pack-id.ts`),
 * free display text cannot be reduced to an allowed character set without breaking legitimate
 * non-English terms, so this strips categories of character rather than a fixed list — closing the
 * class the way the id allowlist does, instead of chasing individual characters. Removed:
 * `\p{Cc}`/`\p{Cf}` (C0/C1 controls, zero-width and bidirectional-override characters) and
 * `\p{Zl}`/`\p{Zp}` (line/paragraph separators), any of which can rewrite how surrounding terminal
 * or log output reads.
 */
export function stripUnsafeCharacters(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');
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
 * Group the keys of a term map by case-insensitive equality and report every group whose members
 * do not all resolve to the same value.
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
  const groups = new Map<string, [key: string, value: T][]>();
  for (const [key, value] of Object.entries(entries)) {
    const lower = key.toLowerCase();
    const group = groups.get(lower);
    if (group === undefined) groups.set(lower, [[key, value]]);
    else group.push([key, value]);
  }
  const conflicts: string[][] = [];
  for (const group of groups.values()) {
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

/** Build a whole-word, case-insensitive matcher for a term or multi-word phrase. */
export function termPattern(term: string): RegExp {
  const escaped = term
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu');
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
