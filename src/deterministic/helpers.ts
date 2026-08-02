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

/**
 * Closed-class function words. Used by heuristics that need to know whether a token could be a
 * content word without running a part-of-speech tagger.
 *
 * PROVENANCE: implementation assumption — an ordinary English function-word list.
 */
export const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'nor',
  'so',
  'yet',
  'for',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'with',
  'from',
  'into',
  'onto',
  'upon',
  'over',
  'under',
  'above',
  'below',
  'between',
  'through',
  'during',
  'before',
  'after',
  'while',
  'until',
  'since',
  'about',
  'against',
  'among',
  'around',
  'as',
  'because',
  'if',
  'then',
  'than',
  'that',
  'this',
  'these',
  'those',
  'there',
  'here',
  'when',
  'where',
  'which',
  'who',
  'whom',
  'whose',
  'what',
  'why',
  'how',
  'not',
  'no',
  'all',
  'any',
  'both',
  'each',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'only',
  'own',
  'same',
  'too',
  'very',
  'can',
  'will',
  'just',
  'should',
  'now',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'having',
  'do',
  'does',
  'did',
  'doing',
  'would',
  'could',
  'may',
  'might',
  'must',
  'shall',
  'it',
  'its',
  'they',
  'them',
  'their',
  'you',
  'your',
  'we',
  'our',
  'us',
  'he',
  'him',
  'his',
  'she',
  'her',
  'i',
  'me',
  'my',
  'also',
  'per',
  'via',
  'etc',
  'ie',
  'eg',
  'out',
  'up',
  'down',
  'off',
  'again',
  'further',
]);

export function isFunctionWord(word: Word): boolean {
  return FUNCTION_WORDS.has(word.lower);
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
