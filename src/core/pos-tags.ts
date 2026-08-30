import { IMPERATIVE_VERBS } from './imperative-verbs.js';
import type { Sentence, Word } from './types.js';

/** Fast lexical substrate for edit-time agent feedback. */
const NEGATIVE_IMPERATIVE_PREFIX = /^(?:do not|don['’]t|never|always)\b/iu;
const LEADING = /^[\s>*_-]+/u;
const LEADING_MASKED_SUBJECT = /^\uFFFD+\s/u;
const WORD_RE = /[\p{L}]+(?:['’-][\p{L}]+)*/gu;

const FALSE_IMPERATIVE_OPENERS = new Set(['vacuum', 'list']);
const AMBIGUOUS_AUXILIARY_VERBS = new Set([
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'be',
  'being',
  'been',
  'get',
  'gets',
  'got',
  'go',
  'goes',
]);

const FUNCTION_WORDS: ReadonlySet<string> = new Set([
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

function normalizedExtras(extraVerbs: readonly string[]): readonly string[] {
  return [...new Set(extraVerbs.map((verb) => verb.trim().toLowerCase()).filter(Boolean))];
}

function opensConfiguredPhrase(text: string, extras: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return extras.some((phrase) => {
    if (!lower.startsWith(phrase)) return false;
    const next = lower[phrase.length];
    return next === undefined || !/[\p{L}\p{N}_]/u.test(next);
  });
}

export function sentenceOpensImperative(text: string, extraVerbs: readonly string[] = []): boolean {
  const stripped = text.replace(LEADING, '');
  if (stripped.length === 0) return false;
  if (/^[\p{L}]+:/u.test(stripped)) return false;
  if (NEGATIVE_IMPERATIVE_PREFIX.test(stripped)) return true;
  if (LEADING_MASKED_SUBJECT.test(stripped) || /^\d/u.test(stripped)) return false;
  const extras = normalizedExtras(extraVerbs);
  if (opensConfiguredPhrase(stripped, extras)) return true;
  const first = /^[\p{L}]+/u.exec(stripped)?.[0]?.toLowerCase();
  if (first === undefined || FALSE_IMPERATIVE_OPENERS.has(first)) return false;
  return IMPERATIVE_VERBS.has(first);
}

export function sentencesOpenImperative(
  texts: readonly string[],
  extraVerbs: readonly string[] = [],
): readonly boolean[] {
  return texts.map((text) => sentenceOpensImperative(text, extraVerbs));
}

export function tagByOffset(
  text: string,
  extraVerbs: readonly string[] = [],
): Map<number, readonly string[]> {
  const extras = new Set(normalizedExtras(extraVerbs));
  const tags = new Map<number, readonly string[]>();
  for (const match of text.matchAll(WORD_RE)) {
    const lower = match[0].toLowerCase();
    if (FUNCTION_WORDS.has(lower)) tags.set(match.index, ['Function']);
    else if (IMPERATIVE_VERBS.has(lower) || extras.has(lower)) {
      tags.set(match.index, ['Verb', 'PresentTense', 'Infinitive']);
    } else tags.set(match.index, ['Content']);
  }
  return tags;
}

export function isFunctionTagSet(tags: readonly string[]): boolean {
  return tags.includes('Function');
}

export function isBareVerbTagSet(tags: readonly string[]): boolean {
  return tags.includes('Verb') && !tags.includes('PastTense') && !tags.includes('Gerund');
}

export function isImperativeOpenerTagSet(tags: readonly string[]): boolean {
  return isBareVerbTagSet(tags) && tags.includes('Infinitive');
}

export interface SentencePosIndex {
  tagsAt(sourceStart: number): readonly string[] | undefined;
}

export function buildSentencePosIndex(
  sentence: Sentence,
  extraVerbs: readonly string[] = [],
): SentencePosIndex {
  const tags = tagByOffset(sentence.masked, extraVerbs);
  return { tagsAt: (sourceStart) => tags.get(sourceStart - sentence.range.start) };
}

export function buildSentencePosIndexes(
  sentences: readonly Sentence[],
  extraVerbs: readonly string[] = [],
): ReadonlyMap<Sentence, SentencePosIndex> {
  return new Map(
    sentences.map((sentence) => [sentence, buildSentencePosIndex(sentence, extraVerbs)]),
  );
}

export function isKnownFunctionWord(word: Word): boolean {
  return FUNCTION_WORDS.has(word.lower);
}

export function isFunctionWord(word: Word, _index: SentencePosIndex): boolean {
  return isKnownFunctionWord(word);
}

export function isImperativeVerbWord(word: Word, index: SentencePosIndex): boolean {
  const tags = index.tagsAt(word.range.start) ?? [];
  return !AMBIGUOUS_AUXILIARY_VERBS.has(word.lower) && isImperativeOpenerTagSet(tags);
}

export function isImperativeOpenerWord(word: Word, index: SentencePosIndex): boolean {
  return isImperativeVerbWord(word, index);
}
