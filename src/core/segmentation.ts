import { split, SentenceSplitterSyntax, type splitOptions } from 'sentence-splitter';
import { English } from 'sentence-splitter/lang';
import type { SourceRange } from './types.js';

/**
 * Abbreviations that must not end a sentence, added on top of the splitter's English list.
 *
 * PROVENANCE: implementation assumption. Ordinary technical-writing abbreviations.
 */
const EXTRA_ABBREVIATIONS: readonly string[] = [
  'e.g.',
  'E.g.',
  'i.e.',
  'I.e.',
  'cf.',
  'Cf.',
  'etc.',
  'vs.',
  'Vs.',
  'approx.',
  'Approx.',
  'max.',
  'Max.',
  'min.',
  'Min.',
  'ref.',
  'Ref.',
  'Fig.',
  'fig.',
  'Figs.',
  'Eq.',
  'eq.',
  'Sec.',
  'sec.',
  'Ch.',
  'ch.',
  'Vol.',
  'vol.',
  'No.',
  'no.',
  'Nos.',
  'pp.',
  'p.',
  'Rev.',
  'rev.',
  'Std.',
  'std.',
  'Tbl.',
  'Para.',
  'para.',
  'Art.',
  'incl.',
  'excl.',
];

const SPLIT_OPTIONS: splitOptions = {
  AbbrMarker: {
    language: {
      ABBREVIATIONS: [...English.ABBREVIATIONS, ...EXTRA_ABBREVIATIONS],
      PREPOSITIVE_ABBREVIATIONS: [...English.PREPOSITIVE_ABBREVIATIONS],
      EXCLAMATION_WORDS: [...English.EXCLAMATION_WORDS],
    },
  },
};

/**
 * Split `text` into sentence ranges relative to `offset`.
 *
 * `text` must be masked text: masking protected content before splitting stops a version number
 * such as `1.2.3` or a path such as `./bin/run.sh` from being read as a sentence boundary.
 * Because masking preserves length, the returned ranges are valid ranges into the raw source.
 */
export function segmentSentences(text: string, offset = 0): SourceRange[] {
  const nodes = split(text, SPLIT_OPTIONS);
  const out: SourceRange[] = [];
  for (const node of nodes) {
    if (node.type !== SentenceSplitterSyntax.Sentence) continue;
    const [start, end] = node.range;
    if (end <= start) continue;
    out.push({ start: offset + start, end: offset + end });
  }
  return out;
}
