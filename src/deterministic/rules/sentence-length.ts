import { z } from 'zod';
import { buildDiagnostic, type DeterministicRule, type RuleOutput } from '../../core/rule.js';
import type { Diagnostic, RuleMetadata, TextMode } from '../../core/types.js';
import { excerpt } from '../helpers.js';

const optionsSchema = z.object({
  /** Overrides the pack limit when set. */
  maxWords: z.number().int().min(1).max(200).optional(),
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
      const limit =
        options.maxWords ??
        (mode === 'procedural'
          ? pack.limits.proceduralSentenceMaxWords
          : pack.limits.descriptiveSentenceMaxWords);
      const diagnostics: Diagnostic[] = [];

      for (const sentence of doc.sentences) {
        if (sentence.mode !== mode) continue;
        const block = blockById.get(sentence.blockId);
        if (block === undefined) continue;
        if (block.kind === 'heading' && !options.includeHeadings) continue;
        if (block.kind === 'table-cell' && !options.includeTableCells) continue;

        const count = sentence.words.length;
        if (count <= limit) continue;

        diagnostics.push(
          buildDiagnostic(meta, policy, {
            category: 'deterministic-violation',
            message:
              `${mode === 'procedural' ? 'Procedural' : 'Descriptive'} sentence has ${count} words; ` +
              `the configured limit is ${limit}. Split it into shorter sentences.`,
            range: sentence.range,
            evidence: excerpt(sentence.raw),
            meta: { wordCount: count, limit, mode },
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
    'Reports a sentence classified as an instruction whose word count exceeds the configured ' +
    'limit. Protected tokens such as quantities and identifiers each count as one word, because ' +
    'the reader still has to read them.',
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
    'Reports a sentence classified as description whose word count exceeds the configured limit.',
});
