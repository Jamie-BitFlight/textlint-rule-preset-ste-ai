import type { SourceRange } from './types.js';

/** Small technical abbreviation set for the edit-time splitter. */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'e.g.',
  'i.e.',
  'cf.',
  'etc.',
  'vs.',
  'approx.',
  'max.',
  'min.',
  'ref.',
  'fig.',
  'figs.',
  'eq.',
  'sec.',
  'ch.',
  'vol.',
  'no.',
  'nos.',
  'pp.',
  'p.',
  'rev.',
  'std.',
  'tbl.',
  'para.',
  'art.',
  'incl.',
  'excl.',
]);

function isAbbreviation(text: string, periodIndex: number): boolean {
  const prefix = text.slice(Math.max(0, periodIndex - 12), periodIndex + 1).toLowerCase();
  for (const abbreviation of ABBREVIATIONS) {
    if (prefix.endsWith(abbreviation)) return true;
  }
  // Single initials and acronym components (`A. Smith`, `U.S.`) do not end a sentence.
  return /(?:^|\s)(?:[a-z]\.){1,4}$/iu.test(prefix);
}

function pushTrimmed(out: SourceRange[], text: string, start: number, end: number, offset: number) {
  while (start < end && /\s/u.test(text[start] ?? '')) start += 1;
  while (end > start && /\s/u.test(text[end - 1] ?? '')) end -= 1;
  if (end > start) out.push({ start: offset + start, end: offset + end });
}

/**
 * Split masked prose in one linear pass. This intentionally favours speed and stable offsets over
 * exhaustive natural-language sentence-boundary disambiguation.
 */
export function segmentSentences(text: string, offset = 0): SourceRange[] {
  const out: SourceRange[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '.' && char !== '!' && char !== '?') continue;
    if (char === '.' && isAbbreviation(text, index)) continue;
    let end = index + 1;
    while (/['’”"\])}]/u.test(text[end] ?? '')) end += 1;
    const next = text[end];
    if (next !== undefined && !/\s/u.test(next)) continue;
    pushTrimmed(out, text, start, end, offset);
    start = end;
    index = end - 1;
  }
  pushTrimmed(out, text, start, text.length, offset);
  return out;
}
