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

function isAbbreviation(text: string, periodIndex: number, sentenceStart: number): boolean {
  for (const abbreviation of ABBREVIATIONS) {
    const abbreviationStart = periodIndex + 1 - abbreviation.length;
    if (abbreviationStart < sentenceStart) continue;
    if (text.slice(abbreviationStart, periodIndex + 1).toLowerCase() !== abbreviation) continue;
    const before = text[abbreviationStart - 1];
    if (before === undefined || /[\s([{"'’]/u.test(before)) return true;
  }

  const prefix = text.slice(sentenceStart, periodIndex + 1);
  const initialism = /(?:^|\s)((?:[a-z]\.){1,4})$/iu.exec(prefix);
  if (initialism === null) return false;
  const initials = initialism[1]?.match(/[a-z]\./giu)?.length ?? 0;
  if (initials === 1) return true;

  // A dotted acronym near the start usually modifies the next noun (`The U.S. Department`).
  // Later in a sentence it is more likely sentence-final (`It applies in the U.S. Restart.`).
  const beforeAcronym = prefix.slice(0, initialism.index).trim();
  const priorTokens = beforeAcronym.length === 0 ? 0 : beforeAcronym.split(/\s+/u).length;
  return priorTokens <= 1;
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
    if (char === '.' && isAbbreviation(text, index, start)) continue;
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
