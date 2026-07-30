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
