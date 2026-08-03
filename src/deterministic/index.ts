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
 * The trailing `as unknown as readonly DeterministicRule<never>[]` is a genuine escape hatch, not
 * a shortcut: `DeterministicRule<TOptions>.run` takes `TOptions` as a parameter, so `TOptions` is
 * contravariant, `DeterministicRule<A>` and `DeterministicRule<B>` are unrelated by subtyping for
 * any two distinct option types, and no single element type describes this genuinely heterogeneous
 * array. `src/core/runner.ts` is what makes this sound in practice: for each rule it validates
 * `rawOptions` with that *same* rule's own `optionsSchema` before calling that *same* rule's `run`,
 * so the options a rule receives always came from its own schema — a per-element correlation the
 * array's static type can't express, only erase. (The disable directive sits on the declaration,
 * not the closing bracket below, because the diagnostic's span starts at the array literal.)
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
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
