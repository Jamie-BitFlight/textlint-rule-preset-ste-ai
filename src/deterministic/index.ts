import type { DeterministicRule } from '../core/rule.js';
import {
  ambiguousPronounCandidateRule,
  nounClusterCandidateRule,
  passiveVoiceCandidateRule,
} from './rules/candidate-rules.js';
import {
  abbreviationIntroductionRule,
  noRepeatedWordsRule,
  numberUnitFormatRule,
  punctuationConstraintsRule,
} from './rules/mechanics.js';
import {
  sentenceLengthDescriptiveRule,
  sentenceLengthProceduralRule,
} from './rules/sentence-length.js';
import {
  listInstructionStructureRule,
  oneInstructionPerSentenceRule,
} from './rules/structure-rules.js';
import {
  noContractionsRule,
  preferredTerminologyRule,
  unapprovedVocabularyRule,
} from './rules/vocabulary.js';

/**
 * The deterministic rule registry.
 *
 * Order is the run order and is part of the tool's deterministic behaviour: do not sort this
 * array at runtime. New rules are appended.
 *
 * Element type is `DeterministicRule<never>`, asserted below rather than inferred, so that
 * retrieving a rule from this array or from {@link findDeterministicRule} yields a `run` that is
 * *uncallable* with any concrete options object — `never` is `run`'s parameter type, and nothing
 * except `never` itself (which has no values) is assignable to it. This is deliberate, not an
 * oversight: `run`'s own parameter is in method position, which TypeScript checks bivariantly
 * (`chatgpt-codex-connector`, P2, `discussion_r3707523461`) — a bare `DeterministicRule` (this
 * array's element type before this note, `TOptions`'s own default `object`) type-checks a direct
 * call with *any* options object, e.g. `findDeterministicRule('unapproved-vocabulary')!.run({
 * options: {} })`, which then throws at runtime (`options.allow.map` on `undefined`) because that
 * rule's real options require `allow: string[]`. `src/core/runner.ts` is the only sound way to call
 * `run` on an element of this array: for each rule it validates `rawOptions` with that *same*
 * rule's own `optionsSchema` before calling that *same* rule's `run`, a per-element correlation
 * this array's static type can never express either way — `DeterministicRule<never>` does not
 * (cannot) verify that correlation, it only closes off the *other*, actually-unsound path of
 * calling `run` directly from outside that correlation.
 *
 * The cast below is genuinely unavoidable, not merely unproven: `DeterministicRule.optionsSchema`
 * is `ZodType<TOptions>`, a plain (non-method) property, so it is checked covariantly, not
 * bivariantly — assigning a rule's own `ZodType<ConcreteOptions>` into a `ZodType<never>`-shaped
 * slot fails for every concrete `TOptions`, by construction (nothing but `never` itself narrows to
 * `never`). Every other unsafe-cast finding on this PR (see the PR description) was fixed by
 * building a real, checkable narrowing; this is the one case — flagged as such at the time — where
 * the very safety property being asserted (dropping to `never`) is exactly what defeats a real
 * narrowing from working, so the assertion itself, not a workaround for it, is the fix.
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- genuinely unavoidable, see above
export const deterministicRules: readonly DeterministicRule<never>[] = [
  sentenceLengthProceduralRule,
  sentenceLengthDescriptiveRule,
  unapprovedVocabularyRule,
  preferredTerminologyRule,
  noContractionsRule,
  punctuationConstraintsRule,
  noRepeatedWordsRule,
  abbreviationIntroductionRule,
  numberUnitFormatRule,
  listInstructionStructureRule,
  oneInstructionPerSentenceRule,
  passiveVoiceCandidateRule,
  nounClusterCandidateRule,
  ambiguousPronounCandidateRule,
] as unknown as readonly DeterministicRule<never>[];

export const deterministicRuleIds: readonly string[] = deterministicRules.map((r) => r.meta.id);

export function findDeterministicRule(id: string): DeterministicRule<never> | undefined {
  return deterministicRules.find((rule) => rule.meta.id === id);
}

export {
  abbreviationIntroductionRule,
  ambiguousPronounCandidateRule,
  listInstructionStructureRule,
  noContractionsRule,
  noRepeatedWordsRule,
  nounClusterCandidateRule,
  numberUnitFormatRule,
  oneInstructionPerSentenceRule,
  passiveVoiceCandidateRule,
  preferredTerminologyRule,
  punctuationConstraintsRule,
  sentenceLengthDescriptiveRule,
  sentenceLengthProceduralRule,
  unapprovedVocabularyRule,
};
