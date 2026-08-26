import { describe, expect, it } from 'vite-plus/test';
import { analyseTextDeterministic } from '../../src/analysis/analyse.js';
import { semanticConfigSchema, type SteAiConfigInput } from '../../src/core/config.js';
import type { CandidatePassage, SemanticEvaluatorId } from '../../src/core/types.js';
import { buildEvaluatorRequest, evaluatorDefinitions } from '../../src/semantic/evaluators.js';
import { FilePromptProvider, formatValue } from '../../src/semantic/prompt-loader.js';

/**
 * `test/unit/prompt-corpus.test.ts` checks the declared contract: `payloadKeys` against what the
 * template consumes. It never checks that a real deterministic rule actually produces a candidate
 * satisfying that declaration — every candidate it renders is a hand-built fixture from
 * `test/helpers/evaluator-payloads.ts`.
 *
 * That gap hid a real defect: `passive-voice-adjudication` declared `mode` as a payload key, but
 * `pushCandidate` (`src/deterministic/rules/candidate-rules.ts`) only ever set it as a top-level
 * `CandidatePassage.mode` field. Every real request rendered `Passage classification from the
 * deterministic pass: none`, because `candidate.payload.mode` was always `undefined` — the hand-built
 * fixture masked this by setting `mode` in both places. Fixed in `src/semantic/evaluators.ts` by
 * resolving `mode` as a shared candidate-level variable, the same way `ruleId`, `passage` and
 * `invariants` already are.
 *
 * This file closes the gap that let it through: it drives real trigger documents through
 * `analyseTextDeterministic`, takes the actual `CandidatePassage` a deterministic rule produced, and
 * confirms every variable the evaluator's prompt template consumes resolves to a real value on that
 * candidate — not `formatValue`'s `undefined` -> `"none"` fallback standing in for data nobody wired
 * through.
 */

const config = semanticConfigSchema.parse({ enabled: true, model: 'test-model' });
const provider = new FilePromptProvider();

interface Trigger {
  readonly text: string;
  /** Per-rule config overrides beyond `semantic.enabled`, when a rule needs one to adjudicate. */
  readonly rules?: SteAiConfigInput['rules'];
}

/**
 * One document per evaluator that has a deterministic rule producing its candidate, each verified
 * to actually produce a candidate (not just a diagnostic) before being added here. An evaluator
 * with no producing rule cannot be exercised this way and is not listed -- see the `KNOWN_GAPS`
 * note below.
 *
 * `one-instruction-per-sentence` only reaches its candidate path for the ambiguous comma-joined
 * case (`src/deterministic/rules/structure-rules.ts`); a clear "and"-joined instruction is decided
 * deterministically and never produces a candidate at all. `approved-word-sense`'s only producer
 * gates on `adjudicateSense`, which defaults to `false` and is not implied by `semantic.enabled`.
 */
const TRIGGER_DOCUMENTS: Partial<Record<SemanticEvaluatorId, Trigger>> = {
  'passive-voice-adjudication': { text: 'The valve was closed by the technician.' },
  'noun-cluster-comprehension': {
    text: 'Check the engine oil pressure warning lamp test procedure.',
  },
  'pronoun-antecedent-ambiguity': {
    text: 'Connect the sensor to the controller. It must be earthed.',
  },
  'one-instruction-per-sentence': { text: 'Remove the cover, install the new filter.' },
  'approved-word-sense': {
    text: 'Utilise the torque wrench on each of the four bolts.',
    rules: { 'unapproved-vocabulary': { adjudicateSense: true } },
  },
};

/**
 * Evaluator variables allowed to resolve from missing data today, each tracked by an open issue
 * rather than silently permitted. A gap landing here without a citation is a regression this test
 * must still catch -- only a cited, already-known gap belongs on this list.
 *
 * `approved-word-sense`'s only real producer (`src/deterministic/rules/vocabulary.ts`, the
 * unapproved-vocabulary path) never populates `permittedSenses`: nothing in `src/` reads the rule
 * pack's `senses` field at all, so the sense-adjudication feature the schema, prompt and evaluator
 * all support has no working trigger yet. See
 * https://github.com/Jamie-BitFlight/textlint-rule-preset-ste-ai/issues/111.
 */
const KNOWN_GAPS: ReadonlySet<string> = new Set(['approved-word-sense.permittedSenses']);

function candidatesFor(evaluatorId: SemanticEvaluatorId, trigger: Trigger): CandidatePassage[] {
  const result = analyseTextDeterministic(trigger.text, {
    config: {
      semantic: { enabled: true, model: 'test-model' },
      ...(trigger.rules === undefined ? {} : { rules: trigger.rules }),
    },
  });
  return result.candidates.filter((c) => c.evaluatorId === evaluatorId);
}

describe('real candidates satisfy their evaluator payload contract', () => {
  const covered = evaluatorDefinitions
    .map((d) => d.id)
    .filter((id) => TRIGGER_DOCUMENTS[id] !== undefined);

  it('covers every evaluator that has a deterministic producer', () => {
    // Fails loudly if a new candidate-producing rule is added without a trigger document here,
    // rather than the new evaluator silently going unchecked.
    for (const definition of evaluatorDefinitions) {
      const trigger = TRIGGER_DOCUMENTS[definition.id];
      if (trigger === undefined) continue;
      const candidates = candidatesFor(definition.id, trigger);
      expect(
        candidates.length,
        `${definition.id}: trigger document produced no candidate`,
      ).toBeGreaterThan(0);
    }
  });

  for (const evaluatorId of covered) {
    it(`${evaluatorId}: the rendered request carries the real candidate's own data`, () => {
      const trigger = TRIGGER_DOCUMENTS[evaluatorId];
      if (trigger === undefined) throw new Error('unreachable: covered only lists documented ids');
      const produced = candidatesFor(evaluatorId, trigger)[0];
      if (produced === undefined) throw new Error(`no candidate produced for ${evaluatorId}`);
      const candidate: CandidatePassage = produced;

      const template = provider.get(config.promptVersion, evaluatorId);

      // What each template variable *should* resolve to, read directly off the real candidate --
      // the same three shared fields plus `mode` that `buildEvaluatorRequest` special-cases, or the
      // payload otherwise. This does not call `buildEvaluatorRequest`; it is the independent source
      // of truth the rendered request is checked against below, so a bug in that function's own
      // resolution logic cannot hide by also being read here.
      function realValueFor(variable: string): unknown {
        if (variable === 'ruleId') return candidate.ruleId;
        if (variable === 'passage') return candidate.passage;
        if (variable === 'invariants') return candidate.invariants;
        if (variable === 'mode') return candidate.mode;
        return candidate.payload[variable];
      }

      for (const variable of template.variables) {
        const gapKey = `${evaluatorId}.${variable}`;
        const isKnownGap = KNOWN_GAPS.has(gapKey);
        const isDefined = realValueFor(variable) !== undefined;
        const message = isKnownGap
          ? `${gapKey} is listed as a known gap but now has real data -- remove it from KNOWN_GAPS`
          : `${gapKey}: real candidate has no value for {{${variable}}}`;
        expect(isDefined, message).toBe(!isKnownGap);
      }

      // The request the real pipeline would actually send. Checked against `realValueFor` above,
      // not against the fixtures `test/unit/prompts.test.ts` uses -- this is what would have caught
      // the `mode` defect: `candidate.payload.mode` was `undefined`, `candidate.mode` was
      // `'descriptive'`, and only rendering the request and checking for `'descriptive'` verbatim
      // catches a resolution path that reads the wrong one.
      const request = buildEvaluatorRequest(candidate, config, provider);
      const rendered = request.messages[1]?.content ?? '';
      for (const variable of template.variables) {
        const gapKey = `${evaluatorId}.${variable}`;
        if (KNOWN_GAPS.has(gapKey)) continue;
        const expected = formatValue(realValueFor(variable));
        expect(
          rendered,
          `${gapKey}: rendered request does not contain the real candidate's value for ` +
            `{{${variable}}} -- buildEvaluatorRequest resolved it from somewhere else`,
        ).toContain(expected);
      }
    });
  }
});
