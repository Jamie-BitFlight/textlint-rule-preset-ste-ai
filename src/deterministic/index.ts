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
 * Element type is bare `DeterministicRule` — `TOptions`'s own default (`object`, see
 * `src/core/rule.ts`), not a cast. `TOptions` sits in `run`'s parameter position, so it is
 * contravariant: `DeterministicRule<A>` and `DeterministicRule<B>` are unrelated by subtyping for
 * any two distinct option types, and no single *concrete* option type describes this genuinely
 * heterogeneous array. `object` is not a concrete option type standing in for one rule's options —
 * it is the same upper bound every concrete option type already satisfies (`DeterministicRule`'s
 * own `TOptions extends object`), so every element here is already a valid `DeterministicRule` on
 * its own terms, nothing is erased or asserted past what the type checker verified when each rule
 * literal was written. `src/core/runner.ts` is what makes calling `run` through this element type
 * sound in practice: for each rule it validates `rawOptions` with that *same* rule's own
 * `optionsSchema` before calling that *same* rule's `run`, so the options a rule receives always
 * came from its own schema — a per-element correlation this array's static type was never able to
 * express either way.
 */
export const deterministicRules: readonly DeterministicRule[] = [
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
];

export const deterministicRuleIds: readonly string[] = deterministicRules.map((r) => r.meta.id);

export function findDeterministicRule(id: string): DeterministicRule | undefined {
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
