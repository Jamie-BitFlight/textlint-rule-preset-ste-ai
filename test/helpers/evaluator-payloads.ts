import type { CandidatePassage, SemanticEvaluatorId } from '../../src/core/types.js';

/**
 * Representative payloads, one per evaluator, shared by the prompt suites.
 *
 * These live here rather than in a single test file because two suites need the same fixtures for
 * different reasons: `prompts.test.ts` checks that a request can be built at all, and
 * `prompt-corpus.test.ts` checks how the result renders. Keeping one copy means a new evaluator is
 * added to one map, and both suites start covering it.
 */
export const EVALUATOR_PAYLOADS: Record<SemanticEvaluatorId, Record<string, unknown>> = {
  'approved-word-sense': {
    word: 'close',
    permittedSenses: ['to shut'],
    approvedAlternatives: ['near'],
    offsetInPassage: 4,
  },
  'permitted-part-of-speech': {
    word: 'test',
    permittedPartsOfSpeech: ['verb'],
    offsetInPassage: 4,
  },
  'one-instruction-per-sentence': { candidateVerbs: ['Remove', 'install'] },
  'passive-voice-adjudication': {
    construction: 'must be replaced',
    auxiliary: 'be',
    participle: 'replaced',
    hasExplicitAgent: false,
  },
  'pronoun-antecedent-ambiguity': {
    pronoun: 'It',
    possibleAntecedents: ['sensor', 'controller'],
    previousSentence: 'Connect the sensor to the controller.',
    offsetInPassage: 0,
  },
  'noun-cluster-comprehension': { cluster: 'engine oil pressure lamp', length: 4, limit: 3 },
  'technical-term-legitimacy': {
    term: 'hysteresis',
    domainHint: 'control systems',
    knownTerms: ['gain'],
  },
  'rewrite-equivalence': {
    original: 'Prior to installation, remove the bracket.',
    rewritten: 'Before installation, remove the bracket.',
    protectedLiterals: [],
  },
};

/**
 * The same payloads, with every array widened to at least two entries.
 *
 * A one-entry array renders as a single `- item` line, which hides the defect class this exists to
 * catch: `formatValue` joins array entries with newlines, so an array substituted into the middle
 * of a line leaves every entry after the first stranded on its own line with no label. One entry is
 * never enough to see that. Real rule packs supply several permitted senses, several approved
 * alternatives and several antecedents, so the multi-entry case is the normal case, not an edge.
 */
export const MULTI_VALUE_PAYLOADS: Record<SemanticEvaluatorId, Record<string, unknown>> = {
  'approved-word-sense': {
    word: 'close',
    permittedSenses: ['to shut', 'to seal'],
    approvedAlternatives: ['near', 'adjacent'],
    offsetInPassage: 4,
  },
  'permitted-part-of-speech': {
    word: 'test',
    permittedPartsOfSpeech: ['verb', 'noun'],
    offsetInPassage: 4,
  },
  'one-instruction-per-sentence': { candidateVerbs: ['Remove', 'install', 'tighten'] },
  'passive-voice-adjudication': {
    construction: 'must be replaced',
    auxiliary: 'be',
    participle: 'replaced',
    hasExplicitAgent: false,
  },
  'pronoun-antecedent-ambiguity': {
    pronoun: 'It',
    possibleAntecedents: ['sensor', 'controller', 'housing'],
    previousSentence: 'Connect the sensor to the controller.',
    offsetInPassage: 0,
  },
  'noun-cluster-comprehension': { cluster: 'engine oil pressure lamp', length: 4, limit: 3 },
  'technical-term-legitimacy': {
    term: 'hysteresis',
    domainHint: 'control systems',
    knownTerms: ['gain', 'setpoint'],
  },
  'rewrite-equivalence': {
    original: 'Prior to installation, remove the bracket.',
    rewritten: 'Before installation, remove the bracket.',
    protectedLiterals: ['M6', 'P/N 4471-A'],
  },
};

/** Build a candidate for one evaluator, with the supplied payload. */
export function candidateFor(
  evaluatorId: SemanticEvaluatorId,
  payload: Record<string, unknown>,
): CandidatePassage {
  return {
    id: `c-${evaluatorId}`,
    ruleId: 'rule-x',
    evaluatorId,
    range: { start: 0, end: 5 },
    passage: 'The filter must be replaced every 500 hours.',
    passageOffset: 0,
    payload,
    invariants: ['negation', 'modal force'],
    reason: 'test',
    mode: 'descriptive',
    admonition: 'none',
  };
}
