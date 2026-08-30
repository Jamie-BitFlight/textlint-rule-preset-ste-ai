import { proseWords } from '../core/document.js';
import type { Sentence, SourceRange, TextBlock, Word } from '../core/types.js';

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

export interface IndexedTermMatch extends TermMatch {
  readonly termIndex: number;
}

/**
 * Build one sentence scanner for a priority-ordered term list.
 *
 * The zero-width lookahead considers every UTF-16 position, including overlapping candidates.
 * Matches are then processed in term-priority order and claimed exactly like the former nested
 * `for sentence -> for term -> findTerm` loops, but the sentence is traversed only once.
 */
export function buildClaimingTermScanner(
  terms: readonly string[],
): (sentence: Sentence) => readonly IndexedTermMatch[] {
  if (terms.some((term) => term.trim().length === 0)) {
    return (sentence) => {
      const claimed: SourceRange[] = [];
      const out: IndexedTermMatch[] = [];
      for (const [termIndex, term] of terms.entries()) {
        for (const match of findTerm(sentence, term)) {
          if (
            claimed.some((range) => match.range.start < range.end && range.start < match.range.end)
          )
            continue;
          claimed.push(match.range);
          out.push({ ...match, termIndex });
        }
      }
      return out;
    };
  }

  const alternatives = terms.map((term, index) => {
    const escaped = term
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+');
    return `(?<t${index}>${escaped}(?![\\p{L}\\p{N}_]))`;
  });
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?=(?:${alternatives.join('|')}))`, 'giu');

  return (sentence) => {
    const candidates: IndexedTermMatch[] = [];
    for (const match of sentence.masked.matchAll(pattern)) {
      const groups = match.groups ?? {};
      for (let termIndex = 0; termIndex < terms.length; termIndex += 1) {
        const text = groups[`t${termIndex}`];
        if (text === undefined) continue;
        const start = sentence.range.start + match.index;
        candidates.push({ range: { start, end: start + text.length }, text, termIndex });
        break;
      }
    }
    candidates.sort(
      (a, b) =>
        a.termIndex - b.termIndex || a.range.start - b.range.start || a.range.end - b.range.end,
    );
    const claimed: SourceRange[] = [];
    return candidates.filter((match) => {
      if (claimed.some((range) => match.range.start < range.end && range.start < match.range.end))
        return false;
      claimed.push(match.range);
      return true;
    });
  };
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
