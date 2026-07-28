import { z } from 'zod';
import { IMPERATIVE_VERBS } from '../../core/imperative-verbs.js';
import { buildDiagnostic, type DeterministicRule, type RuleOutput } from '../../core/rule.js';
import type { CandidatePassage, Diagnostic, RuleMetadata } from '../../core/types.js';
import { excerpt, groupSiblingListItems } from '../helpers.js';

// ---------------------------------------------------------------------------
// list-instruction-structure
// ---------------------------------------------------------------------------

const listOptionsSchema = z.object({
  checkTerminalPunctuation: z.boolean().default(true),
  checkInitialCapital: z.boolean().default(true),
  /** Overrides the pack limit for sentences per numbered step. */
  maxSentencesPerStep: z.number().int().min(1).max(10).optional(),
});

const listMeta: RuleMetadata = {
  id: 'list-instruction-structure',
  title: 'List and instruction structure',
  status: 'provisional',
  sourceRef: 'provisional:docs/provisional-rules.md#list-instruction-structure',
  kind: 'deterministic',
  appliesTo: ['procedural', 'descriptive'],
  defaultSeverity: 'warning',
  fixable: false,
  inspectsProtectedRegions: false,
  description:
    'Reports malformed lists and steps: sibling items that disagree about terminal punctuation ' +
    'or initial capitalisation, and a numbered step that contains more sentences than the ' +
    'configured limit.',
};

export const listInstructionStructureRule: DeterministicRule<z.output<typeof listOptionsSchema>> = {
  meta: listMeta,
  optionsSchema: listOptionsSchema,
  run({ doc, options, pack, policy }): RuleOutput {
    const diagnostics: Diagnostic[] = [];
    const limit = options.maxSentencesPerStep ?? pack.limits.maxSentencesPerProceduralStep;

    // Sentences per numbered step.
    for (const block of doc.blocks) {
      if (block.kind !== 'list-item' || block.listOrdinal === undefined) continue;
      const sentences = doc.sentences.filter((s) => s.blockId === block.id);
      if (sentences.length <= limit) continue;
      diagnostics.push(
        buildDiagnostic(listMeta, policy, {
          category: 'deterministic-violation',
          message:
            `Numbered step ${block.listOrdinal} contains ${sentences.length} sentences; the ` +
            `limit is ${limit}. Give each action its own step.`,
          range: block.range,
          evidence: excerpt(block.text),
          meta: { sentences: sentences.length, limit, ordinal: block.listOrdinal },
        }),
      );
    }

    for (const group of groupSiblingListItems(doc.blocks)) {
      if (options.checkTerminalPunctuation) {
        const terminated = group.map((b) => /[.!?]$/.test(b.text.trimEnd()));
        const withCount = terminated.filter(Boolean).length;
        const withoutCount = terminated.length - withCount;
        if (withCount > 0 && withoutCount > 0) {
          const majorityTerminated = withCount >= withoutCount;
          for (let i = 0; i < group.length; i += 1) {
            if (terminated[i] === majorityTerminated) continue;
            const block = group[i];
            if (block === undefined) continue;
            diagnostics.push(
              buildDiagnostic(listMeta, policy, {
                category: 'deterministic-violation',
                message: majorityTerminated
                  ? 'This list item has no full stop while its sibling items do. Make the ' +
                    'punctuation of every item in a list the same.'
                  : 'This list item ends with a full stop while its sibling items do not. Make ' +
                    'the punctuation of every item in a list the same.',
                range: block.range,
                evidence: excerpt(block.text),
                meta: { issue: 'terminal-punctuation' },
              }),
            );
          }
        }
      }

      if (options.checkInitialCapital) {
        const capitals = group.map((b) => /^[A-Z]/.test(b.text.trimStart()));
        const withCount = capitals.filter(Boolean).length;
        const withoutCount = capitals.length - withCount;
        if (withCount > 0 && withoutCount > 0) {
          const majorityCapital = withCount >= withoutCount;
          for (let i = 0; i < group.length; i += 1) {
            if (capitals[i] === majorityCapital) continue;
            const block = group[i];
            if (block === undefined) continue;
            // A lower-case start is legitimate when the item begins with a protected literal.
            if (doc.isProtected({ start: block.range.start, end: block.range.start + 1 })) continue;
            diagnostics.push(
              buildDiagnostic(listMeta, policy, {
                category: 'deterministic-violation',
                message:
                  'The first letter of this list item does not match its sibling items. Start ' +
                  'every item in a list the same way.',
                range: {
                  start: block.range.start,
                  end: Math.min(block.range.end, block.range.start + 20),
                },
                evidence: excerpt(block.text),
                meta: { issue: 'initial-capital' },
              }),
            );
          }
        }
      }
    }

    return { diagnostics, candidates: [] };
  },
};

// ---------------------------------------------------------------------------
// one-instruction-per-sentence
// ---------------------------------------------------------------------------

const oneInstructionOptionsSchema = z.object({
  /** Conjunctions that join two instructions. */
  conjunctions: z.array(z.string()).default(['and', 'then', 'and then', 'or']),
  /**
   * Send comma-joined candidates to the semantic subsystem instead of reporting them as
   * review-required with no adjudication.
   */
  adjudicate: z.boolean().default(true),
});

const oneInstructionMeta: RuleMetadata = {
  id: 'one-instruction-per-sentence',
  title: 'One instruction per sentence',
  status: 'provisional',
  sourceRef: 'provisional:docs/provisional-rules.md#one-instruction-per-sentence',
  kind: 'deterministic',
  appliesTo: ['procedural'],
  defaultSeverity: 'error',
  fixable: false,
  inspectsProtectedRegions: false,
  description:
    'Reports an instruction that contains two obvious imperative clauses joined by a ' +
    'coordinating conjunction. Less clear shapes — comma-joined clauses — become candidates for ' +
    'semantic adjudication rather than violations. No fix: splitting a sentence is a decision ' +
    'about procedural order.',
};

export const oneInstructionPerSentenceRule: DeterministicRule<
  z.output<typeof oneInstructionOptionsSchema>
> = {
  meta: oneInstructionMeta,
  optionsSchema: oneInstructionOptionsSchema,
  run({ doc, options, policy }): RuleOutput {
    const diagnostics: Diagnostic[] = [];
    const candidates: CandidatePassage[] = [];
    const conjunctions = new Set(options.conjunctions.map((c) => c.toLowerCase()));

    for (const sentence of doc.sentences) {
      if (sentence.mode !== 'procedural') continue;
      const words = sentence.words.filter((w) => w.protectedKind === undefined);
      const first = words[0];
      if (first === undefined) continue;
      const startsImperative =
        IMPERATIVE_VERBS.has(first.lower) || /^(?:do|never|always)$/.test(first.lower);
      if (!startsImperative) continue;

      let conjunctionHit: { index: number; verb: (typeof words)[number] } | null = null;
      for (let i = 1; i < words.length - 1; i += 1) {
        const word = words[i];
        const next = words[i + 1];
        if (word === undefined || next === undefined) continue;
        if (!conjunctions.has(word.lower)) continue;
        // `and then install` — skip the adverb and look at the following word.
        const candidateVerb = next.lower === 'then' ? words[i + 2] : next;
        if (candidateVerb === undefined) continue;
        if (!IMPERATIVE_VERBS.has(candidateVerb.lower)) continue;
        conjunctionHit = { index: i, verb: candidateVerb };
        break;
      }

      if (conjunctionHit !== null) {
        diagnostics.push(
          buildDiagnostic(oneInstructionMeta, policy, {
            category: 'deterministic-violation',
            message:
              `This instruction contains two actions ("${first.text}" and ` +
              `"${conjunctionHit.verb.text}"). Write one instruction in each sentence.`,
            range: sentence.range,
            evidence: excerpt(sentence.raw),
            meta: { firstVerb: first.lower, secondVerb: conjunctionHit.verb.lower },
          }),
        );
        continue;
      }

      // Comma-joined clause with a second imperative verb: shape is ambiguous, so adjudicate.
      const commaIndex = sentence.masked.indexOf(',');
      if (commaIndex < 0) continue;
      const afterComma = words.filter((w) => w.range.start > sentence.range.start + commaIndex);
      const secondVerb = afterComma.find((w) => IMPERATIVE_VERBS.has(w.lower));
      if (secondVerb === undefined) continue;

      if (!options.adjudicate) {
        if (!policy.reportReviewRequired) continue;
        diagnostics.push(
          buildDiagnostic(oneInstructionMeta, policy, {
            category: 'review-required',
            message:
              'This instruction may contain more than one action. Semantic adjudication is ' +
              'disabled, so a reviewer must decide.',
            range: sentence.range,
            evidence: excerpt(sentence.raw),
          }),
        );
        continue;
      }

      candidates.push({
        id: `${oneInstructionMeta.id}:${sentence.id}`,
        ruleId: oneInstructionMeta.id,
        evaluatorId: 'one-instruction-per-sentence',
        range: sentence.range,
        passage: sentence.masked,
        passageOffset: sentence.range.start,
        payload: { candidateVerbs: [first.text, secondVerb.text] },
        invariants: [
          'the order of the actions',
          'quantities and tolerances',
          'identifiers and command syntax',
          'negation and modal force',
        ],
        reason: 'Comma-joined clause with a second candidate imperative verb.',
        mode: sentence.mode,
        admonition: sentence.admonition,
      });
    }

    return { diagnostics, candidates };
  },
};
