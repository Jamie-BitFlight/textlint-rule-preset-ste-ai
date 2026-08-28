import type { SemanticConfig } from '../core/config.js';
import { contentHash } from '../core/text.js';
import type { CandidatePassage, SemanticEvaluatorId } from '../core/types.js';
import type { ChatMessage } from '../model-client/types.js';
import { formatValue, renderTemplate, type FilePromptProvider } from './prompt-loader.js';

/**
 * Evaluator definitions.
 *
 * Each evaluator is one bounded classification task with its own prompt asset and its own minimal
 * payload. There is deliberately no "check this text against the whole scheme" evaluator: a single
 * broad request cannot be evaluated, cannot be calibrated, and cannot be traced back to a rule.
 */
export interface EvaluatorDefinition {
  readonly id: SemanticEvaluatorId;
  readonly title: string;
  /** Payload keys this evaluator sends. Anything else in the candidate payload is dropped. */
  readonly payloadKeys: readonly string[];
  /** Payload keys that must be present. */
  readonly requiredKeys: readonly string[];
  readonly description: string;
}

export const evaluatorDefinitions: readonly EvaluatorDefinition[] = [
  {
    id: 'approved-word-sense',
    title: 'Approved word sense in context',
    payloadKeys: ['word', 'permittedSenses', 'approvedAlternatives', 'offsetInPassage'],
    requiredKeys: ['word', 'offsetInPassage'],
    description:
      'Is this word used in a sense the active rule pack permits? Permitted senses are supplied ' +
      'at request time; the model is told to judge against that list and no other dictionary.',
  },
  {
    id: 'permitted-part-of-speech',
    title: 'Permitted part of speech',
    payloadKeys: ['word', 'permittedPartsOfSpeech', 'offsetInPassage'],
    requiredKeys: ['word', 'offsetInPassage'],
    description: 'Is this word used in a part of speech the active rule pack permits?',
  },
  {
    id: 'one-instruction-per-sentence',
    title: 'One instruction per sentence',
    payloadKeys: ['candidateVerbs'],
    requiredKeys: ['candidateVerbs'],
    description: 'Does this sentence tell the reader to perform more than one action?',
  },
  {
    id: 'passive-voice-adjudication',
    title: 'Passive voice adjudication',
    payloadKeys: ['construction', 'auxiliary', 'participle', 'hasExplicitAgent'],
    requiredKeys: ['construction'],
    description:
      'Is this be-form plus participle a true passive verb, or an adjectival state? Only the ' +
      'former is a defect, and only in an instruction.',
  },
  {
    id: 'pronoun-antecedent-ambiguity',
    title: 'Pronoun antecedent ambiguity',
    payloadKeys: ['pronoun', 'possibleAntecedents', 'previousSentence', 'offsetInPassage'],
    requiredKeys: ['pronoun'],
    description: 'Does this pronoun have more than one plausible antecedent?',
  },
  {
    id: 'noun-cluster-comprehension',
    title: 'Noun cluster comprehension',
    payloadKeys: ['cluster', 'length', 'limit'],
    requiredKeys: ['cluster'],
    description:
      'Is this run of nouns hard to read, or is it a single established name? Component identity ' +
      'outranks simplification.',
  },
  {
    id: 'technical-term-legitimacy',
    title: 'Technical term legitimacy',
    payloadKeys: ['term', 'domainHint', 'knownTerms'],
    requiredKeys: ['term'],
    description:
      'Is this unlisted word legitimate domain terminology or avoidable general vocabulary?',
  },
  {
    id: 'rewrite-equivalence',
    title: 'Rewrite semantic-equivalence verification',
    payloadKeys: ['original', 'rewritten', 'protectedLiterals'],
    requiredKeys: ['original', 'rewritten'],
    description:
      'Does a proposed rewrite preserve technical meaning, safety framing, negation, order, ' +
      'quantities, identifiers and modal force? This is the gate a semantic autofix must pass.',
  },
];

export function findEvaluator(id: string): EvaluatorDefinition | undefined {
  return evaluatorDefinitions.find((e) => e.id === id);
}

export interface EvaluatorRequest {
  readonly candidateId: string;
  readonly ruleId: string;
  readonly evaluatorId: SemanticEvaluatorId;
  readonly promptVersion: string;
  readonly messages: readonly ChatMessage[];
  /** Length of the string the model is told offsets refer to. */
  readonly passageLength: number;
  readonly contentHash: string;
}

export class EvaluatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluatorError';
  }
}

/**
 * Build the request for one candidate.
 *
 * Only the payload keys the evaluator declares are sent. That is the mechanism behind "each
 * request provides only the context required for that evaluator": a rule cannot widen the context
 * a model sees by stuffing extra fields into the candidate payload.
 */
export function buildEvaluatorRequest(
  candidate: CandidatePassage,
  config: SemanticConfig,
  prompts: FilePromptProvider,
): EvaluatorRequest {
  const definition = findEvaluator(candidate.evaluatorId);
  if (definition === undefined) {
    throw new EvaluatorError(`Unknown semantic evaluator "${candidate.evaluatorId}".`);
  }
  for (const key of definition.requiredKeys) {
    if (!(key in candidate.payload)) {
      throw new EvaluatorError(
        `Candidate ${candidate.id} for evaluator "${definition.id}" is missing payload key "${key}".`,
      );
    }
  }

  const template = prompts.get(config.promptVersion, definition.id);

  // `rewrite-equivalence` anchors offsets to the rewritten text; every other evaluator anchors
  // them to the passage.
  const rewritten = candidate.payload['rewritten'];
  const offsetTarget =
    definition.id === 'rewrite-equivalence' && typeof rewritten === 'string'
      ? rewritten
      : candidate.passage;

  const values: Record<string, string> = {};
  for (const variable of template.variables) {
    if (variable === 'ruleId') {
      values[variable] = candidate.ruleId;
      continue;
    }
    if (variable === 'passage') {
      values[variable] = candidate.passage;
      continue;
    }
    if (variable === 'invariants') {
      values[variable] = formatValue(candidate.invariants);
      continue;
    }
    if (variable === 'mode') {
      // `mode` is a candidate-level field (`sentence.mode`, set by every rule via `pushCandidate`),
      // never a payload key: no deterministic rule puts it in `candidate.payload`. Resolving it
      // from `payloadKeys` here, as passive-voice-adjudication's template does, silently reads
      // `undefined` and renders "none" in every real request — `mode` was never wired into the
      // rule's payload in the first place, only into hand-built test fixtures that happened to set
      // both places at once. Reproduced against a real candidate before this fix, from
      // `analyseTextDeterministic('The valve was closed by the technician.', ...)`.
      values[variable] = candidate.mode;
      continue;
    }
    if (!definition.payloadKeys.includes(variable)) {
      throw new EvaluatorError(
        `Prompt for "${definition.id}" uses {{${variable}}}, which the evaluator does not declare.`,
      );
    }
    values[variable] = formatValue(candidate.payload[variable]);
  }

  const system = template.system;
  const user = renderTemplate(template.user, values, `${config.promptVersion}/${definition.id}`);

  return {
    candidateId: candidate.id,
    ruleId: candidate.ruleId,
    evaluatorId: definition.id,
    promptVersion: template.version,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    passageLength: offsetTarget.length,
    // The hash covers everything that can change the answer. Two candidates that hash the same are
    // genuinely the same question and share one request and one cache entry.
    contentHash: contentHash(
      definition.id,
      template.version,
      config.model,
      String(config.temperature),
      system,
      user,
    ),
  };
}
