import { z } from 'zod';
import readability from 'text-readability';
import { buildDiagnostic, type DeterministicRule, type RuleOutput } from '../../core/rule.js';
import type { Diagnostic, RuleMetadata, TextMode } from '../../core/types.js';
import { excerpt } from '../helpers.js';

const optionsSchema = z.object({
  /** Overrides the pack's grade-level limit when set. */
  maxGradeLevel: z.number().min(1).max(20).optional(),
  /** Overrides the pack's word-count floor when set. */
  floorWords: z.number().int().min(1).max(200).optional(),
  /** Headings are titles, not sentences; excluded by default. */
  includeHeadings: z.boolean().default(false),
  /** Table cells are often fragments; excluded by default. */
  includeTableCells: z.boolean().default(false),
});

type Options = z.output<typeof optionsSchema>;

function makeRule(mode: TextMode, meta: RuleMetadata): DeterministicRule<Options> {
  return {
    meta,
    optionsSchema,
    run({ doc, options, pack, policy, blockById }): RuleOutput {
      const maxGrade =
        options.maxGradeLevel ??
        (mode === 'procedural'
          ? pack.limits.proceduralMaxGradeLevel
          : pack.limits.descriptiveMaxGradeLevel);
      const floor = options.floorWords ?? pack.limits.sentenceReadabilityFloorWords;
      const diagnostics: Diagnostic[] = [];

      for (const sentence of doc.sentences) {
        if (sentence.mode !== mode) continue;
        const block = blockById.get(sentence.blockId);
        if (block === undefined) continue;
        if (block.kind === 'heading' && !options.includeHeadings) continue;
        if (block.kind === 'table-cell' && !options.includeTableCells) continue;

        const count = sentence.words.length;
        // Below the floor, the Flesch-Kincaid formula is not computed at all: it is normed on
        // multi-sentence passages, and on short input a single long or unfamiliar word can swing
        // the grade by tens of levels (see docs/provisional-rules.md#sentence-length-procedural
        // for measured examples). A short sentence is presumed simple regardless of vocabulary.
        if (count < floor) continue;

        // Scored against `sentence.masked`, not `sentence.raw`: opaque protected regions
        // (identifiers, quantities, code spans, URLs) are already replaced with placeholder runs
        // there. Feeding the literal spelling of a snake_case identifier or a part number into a
        // syllable-counting formula inflates its apparent complexity for reasons that have
        // nothing to do with how hard the sentence is to read — the exact failure mode the
        // `hard-negative` fixtures exist to catch. Masking keeps the formula's attention on
        // ordinary prose vocabulary and clause structure.
        const grade = readability.fleschKincaidGrade(sentence.masked);
        if (grade <= maxGrade) continue;

        diagnostics.push(
          buildDiagnostic(meta, policy, {
            category: 'deterministic-violation',
            message:
              `${mode === 'procedural' ? 'Procedural' : 'Descriptive'} sentence has an estimated ` +
              `Flesch-Kincaid grade level of ${grade.toFixed(1)} (${count} words); the configured ` +
              `limit is grade ${maxGrade}. Split it into shorter, simpler sentences.`,
            range: sentence.range,
            evidence: excerpt(sentence.raw),
            meta: { gradeLevel: grade, maxGradeLevel: maxGrade, wordCount: count, mode },
          }),
        );
      }
      return { diagnostics, candidates: [] };
    },
  };
}

export const sentenceLengthProceduralRule = makeRule('procedural', {
  id: 'sentence-length-procedural',
  title: 'Procedural sentence length',
  status: 'provisional',
  sourceRef: 'provisional:docs/provisional-rules.md#sentence-length-procedural',
  kind: 'deterministic',
  appliesTo: ['procedural'],
  defaultSeverity: 'error',
  fixable: false,
  inspectsProtectedRegions: false,
  description:
    'Reports a sentence classified as an instruction whose estimated Flesch-Kincaid reading ' +
    'grade level exceeds the configured limit, once the sentence is long enough for the formula ' +
    'to be meaningful. Scored against protected regions masked out, so identifiers and part ' +
    'numbers are not read as prose vocabulary — they still count towards the word-count floor.',
});

export const sentenceLengthDescriptiveRule = makeRule('descriptive', {
  id: 'sentence-length-descriptive',
  title: 'Descriptive sentence length',
  status: 'provisional',
  sourceRef: 'provisional:docs/provisional-rules.md#sentence-length-descriptive',
  kind: 'deterministic',
  appliesTo: ['descriptive'],
  defaultSeverity: 'error',
  fixable: false,
  inspectsProtectedRegions: false,
  description:
    'Reports a sentence classified as description whose estimated Flesch-Kincaid reading grade ' +
    'level exceeds the configured limit, once the sentence is long enough for the formula to be ' +
    'meaningful.',
});
