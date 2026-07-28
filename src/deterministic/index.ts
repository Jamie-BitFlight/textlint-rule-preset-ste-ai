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
 */
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
