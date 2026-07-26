import { z } from 'zod';
import { IMPERATIVE_VERBS } from '../../core/imperative-verbs.js';
import { buildDiagnostic, type DeterministicRule, type RuleOutput } from '../../core/rule.js';
import type {
  CandidatePassage,
  Diagnostic,
  RuleMetadata,
  SemanticEvaluatorId,
  Sentence,
  SourceRange,
} from '../../core/types.js';
import { excerpt, isFunctionWord } from '../helpers.js';

/**
 * Rules in this file never assert a violation on their own.
 *
 * Each detects a shape that *may* be a problem and hands it to a named semantic evaluator. With
 * semantic analysis disabled the finding is reported as `review-required`, which the diagnostic
 * policy can downgrade or drop. Nothing here is ever reported as a compliance failure, because
 * none of these shapes can be decided without reading meaning.
 */

interface CandidateRuleSpec {
  readonly meta: RuleMetadata;
  readonly evaluatorId: SemanticEvaluatorId;
  readonly invariants: readonly string[];
  readonly reviewMessage: string;
}

function pushCandidate(
  spec: CandidateRuleSpec,
  sentence: Sentence,
  range: SourceRange,
  payload: Readonly<Record<string, unknown>>,
  reason: string,
): CandidatePassage {
  return {
    id: `${spec.meta.id}:${sentence.id}:${range.start}`,
    ruleId: spec.meta.id,
    evaluatorId: spec.evaluatorId,
    range,
    passage: sentence.masked,
    passageOffset: sentence.range.start,
    payload,
    invariants: spec.invariants,
    reason,
    mode: sentence.mode,
    admonition: sentence.admonition,
  };
}

// ---------------------------------------------------------------------------
// passive-voice-candidate
// ---------------------------------------------------------------------------

/**
 * Irregular past participles. PROVENANCE: implementation assumption — ordinary English morphology.
 */
const PARTICIPLES = [
  'known',
  'given',
  'taken',
  'shown',
  'made',
  'done',
  'set',
  'put',
  'written',
  'held',
  'kept',
  'built',
  'found',
  'sent',
  'left',
  'seen',
  'driven',
  'drawn',
  'worn',
  'torn',
  'blown',
  'grown',
  'thrown',
  'begun',
  'broken',
  'chosen',
  'cut',
  'fed',
  'felt',
  'got',
  'gotten',
  'hidden',
  'hit',
  'laid',
  'led',
  'lit',
  'lost',
  'met',
  'paid',
  'read',
  'run',
  'said',
  'sold',
  'shut',
  'split',
  'spread',
  'stuck',
  'swollen',
  'taught',
  'told',
  'understood',
  'woven',
  'wound',
  'bent',
  'bound',
  'burnt',
  'dealt',
  'dug',
  'fitted',
  'ground',
  'hung',
  'meant',
  'rebuilt',
  'rewritten',
  'sought',
  'shot',
  'slid',
  'spent',
  'struck',
  'swept',
  'torn',
  'withdrawn',
].join('|');

const PASSIVE_RE = new RegExp(
  String.raw`\b(is|are|was|were|be|been|being|gets|get|got)\s+((?:[a-z]+ly\s+)?(?:[a-z]{3,}ed|${PARTICIPLES}))\b(\s+by\b)?`,
  'gi',
);

const passiveOptionsSchema = z.object({
  /** Require an explicit `by` agent before flagging. Fewer candidates, lower recall. */
  requireByAgent: z.boolean().default(false),
  adjudicate: z.boolean().default(true),
});

const passiveSpec: CandidateRuleSpec = {
  meta: {
    id: 'passive-voice-candidate',
    title: 'Suspected passive voice',
    status: 'provisional',
    sourceRef: 'provisional:docs/provisional-rules.md#passive-voice-candidate',
    kind: 'deterministic',
    appliesTo: ['procedural', 'descriptive'],
    defaultSeverity: 'info',
    fixable: false,
    inspectsProtectedRegions: false,
    description:
      'Detects a `be` form followed by a past participle. The construction is only a candidate: ' +
      'many such strings are adjectival ("the bolt is tightened" vs "the surface is clean"), and ' +
      'a passive is sometimes the clearest form in a description. Adjudication decides.',
  },
  evaluatorId: 'passive-voice-adjudication',
  invariants: ['actor responsibility', 'negation', 'modal force', 'action order'],
  reviewMessage:
    'This may be passive voice. In an instruction, name the actor and use the active voice.',
};

export const passiveVoiceCandidateRule: DeterministicRule<z.output<typeof passiveOptionsSchema>> = {
  meta: passiveSpec.meta,
  optionsSchema: passiveOptionsSchema,
  run({ doc, options, policy }): RuleOutput {
    const diagnostics: Diagnostic[] = [];
    const candidates: CandidatePassage[] = [];
    for (const sentence of doc.sentences) {
      for (const m of sentence.masked.matchAll(PASSIVE_RE)) {
        const hasAgent = m[3] !== undefined;
        if (options.requireByAgent && !hasAgent) continue;
        const range: SourceRange = {
          start: sentence.range.start + m.index,
          end: sentence.range.start + m.index + m[0].length,
        };
        if (options.adjudicate) {
          candidates.push(
            pushCandidate(
              passiveSpec,
              sentence,
              range,
              {
                construction: m[0],
                auxiliary: m[1],
                participle: m[2],
                hasExplicitAgent: hasAgent,
                offsetInPassage: m.index,
              },
              'Auxiliary plus past participle.',
            ),
          );
        } else if (policy.reportReviewRequired) {
          diagnostics.push(
            buildDiagnostic(passiveSpec.meta, policy, {
              category: 'review-required',
              message: passiveSpec.reviewMessage,
              range,
              evidence: excerpt(sentence.raw),
              meta: { construction: m[0] },
            }),
          );
        }
      }
    }
    return { diagnostics, candidates };
  },
};

// ---------------------------------------------------------------------------
// noun-cluster-candidate
// ---------------------------------------------------------------------------

const nounClusterOptionsSchema = z.object({
  /** Overrides the pack limit. A cluster longer than this becomes a candidate. */
  maxClusterLength: z.number().int().min(2).max(10).optional(),
  adjudicate: z.boolean().default(true),
});

const nounClusterSpec: CandidateRuleSpec = {
  meta: {
    id: 'noun-cluster-candidate',
    title: 'Difficult noun cluster',
    status: 'provisional',
    sourceRef: 'provisional:docs/provisional-rules.md#noun-cluster-candidate',
    kind: 'deterministic',
    appliesTo: ['procedural', 'descriptive'],
    defaultSeverity: 'info',
    fixable: false,
    inspectsProtectedRegions: false,
    description:
      'Detects a run of consecutive content words with no function word between them, which is ' +
      'the shape of a long noun cluster. Whether the cluster is actually hard to read, or is a ' +
      'single established technical name, needs adjudication.',
  },
  evaluatorId: 'noun-cluster-comprehension',
  invariants: ['component identity', 'identifiers', 'quantities'],
  reviewMessage:
    'This run of nouns may be hard to read. Consider using prepositions to show the relations.',
};

export const nounClusterCandidateRule: DeterministicRule<
  z.output<typeof nounClusterOptionsSchema>
> = {
  meta: nounClusterSpec.meta,
  optionsSchema: nounClusterOptionsSchema,
  run({ doc, options, pack, policy }): RuleOutput {
    const limit = options.maxClusterLength ?? pack.limits.maxNounClusterLength;
    const diagnostics: Diagnostic[] = [];
    const candidates: CandidatePassage[] = [];

    for (const sentence of doc.sentences) {
      let run: (typeof sentence.words)[number][] = [];
      const flush = (): void => {
        if (run.length <= limit) {
          run = [];
          return;
        }
        const first = run[0];
        const last = run[run.length - 1];
        if (first === undefined || last === undefined) {
          run = [];
          return;
        }
        const range: SourceRange = { start: first.range.start, end: last.range.end };
        const clusterText = doc.text.slice(range.start, range.end);
        if (options.adjudicate) {
          candidates.push(
            pushCandidate(
              nounClusterSpec,
              sentence,
              range,
              { cluster: clusterText, length: run.length, limit },
              `Run of ${run.length} content words with no function word.`,
            ),
          );
        } else if (policy.reportReviewRequired) {
          diagnostics.push(
            buildDiagnostic(nounClusterSpec.meta, policy, {
              category: 'review-required',
              message: `${nounClusterSpec.reviewMessage} Cluster: "${clusterText}".`,
              range,
              evidence: excerpt(sentence.raw),
              meta: { length: run.length, limit },
            }),
          );
        }
        run = [];
      };

      for (const word of sentence.words) {
        const breaksRun =
          word.protectedKind !== undefined ||
          isFunctionWord(word) ||
          IMPERATIVE_VERBS.has(word.lower) ||
          !/^[\p{L}][\p{L}-]*$/u.test(word.text);
        if (breaksRun) flush();
        else run.push(word);
      }
      flush();
    }
    return { diagnostics, candidates };
  },
};

// ---------------------------------------------------------------------------
// ambiguous-pronoun-candidate
// ---------------------------------------------------------------------------

const PRONOUNS = new Set(['it', 'they', 'them', 'this', 'these', 'those', 'which', 'its', 'their']);
const BARE_DEMONSTRATIVE_FOLLOWERS = new Set([
  'is',
  'are',
  'was',
  'were',
  'will',
  'can',
  'must',
  'should',
  'would',
  'may',
  'might',
  'does',
  'do',
  'did',
  'has',
  'have',
  'had',
  'allows',
  'causes',
  'means',
  'prevents',
  'ensures',
  'results',
  'requires',
  'makes',
  'gives',
  'provides',
  'shows',
  'stops',
  'starts',
  'happens',
  'occurs',
  'applies',
  'affects',
]);

const pronounOptionsSchema = z.object({
  /** Minimum number of candidate antecedents before `it`/`they` is flagged. */
  minAntecedents: z.number().int().min(1).max(10).default(2),
  adjudicate: z.boolean().default(true),
});

const pronounSpec: CandidateRuleSpec = {
  meta: {
    id: 'ambiguous-pronoun-candidate',
    title: 'Possibly ambiguous pronoun',
    status: 'provisional',
    sourceRef: 'provisional:docs/provisional-rules.md#ambiguous-pronoun-candidate',
    kind: 'deterministic',
    appliesTo: ['procedural', 'descriptive'],
    defaultSeverity: 'info',
    fixable: false,
    inspectsProtectedRegions: false,
    description:
      'Detects two shapes: a bare demonstrative used as a subject ("This prevents…"), and a ' +
      'pronoun in a sentence whose local context offers several possible antecedents. Which ' +
      'antecedent a reader will choose cannot be decided lexically, so these are candidates only.',
  },
  evaluatorId: 'pronoun-antecedent-ambiguity',
  invariants: ['which component or value is referred to', 'actor responsibility'],
  reviewMessage: 'The referent of this pronoun may be unclear. Repeat the noun.',
};

export const ambiguousPronounCandidateRule: DeterministicRule<
  z.output<typeof pronounOptionsSchema>
> = {
  meta: pronounSpec.meta,
  optionsSchema: pronounOptionsSchema,
  run({ doc, options, policy }): RuleOutput {
    const diagnostics: Diagnostic[] = [];
    const candidates: CandidatePassage[] = [];

    for (let s = 0; s < doc.sentences.length; s += 1) {
      const sentence = doc.sentences[s];
      if (sentence === undefined) continue;
      const previous = doc.sentences[s - 1];
      const words = sentence.words;

      const antecedents = countAntecedents(sentence, previous);

      for (let i = 0; i < words.length; i += 1) {
        const word = words[i];
        if (word === undefined || word.protectedKind !== undefined) continue;
        if (!PRONOUNS.has(word.lower)) continue;

        const next = words[i + 1];
        const isBareDemonstrative =
          i === 0 &&
          (word.lower === 'this' || word.lower === 'these' || word.lower === 'those') &&
          next !== undefined &&
          next.protectedKind === undefined &&
          BARE_DEMONSTRATIVE_FOLLOWERS.has(next.lower);

        const isMultiAntecedent =
          (word.lower === 'it' || word.lower === 'they' || word.lower === 'them') &&
          antecedents.length >= options.minAntecedents;

        if (!isBareDemonstrative && !isMultiAntecedent) continue;

        const reason = isBareDemonstrative
          ? 'Demonstrative used as a bare subject.'
          : `Pronoun with ${antecedents.length} possible antecedents.`;

        if (options.adjudicate) {
          candidates.push(
            pushCandidate(
              pronounSpec,
              sentence,
              word.range,
              {
                pronoun: word.text,
                offsetInPassage: word.range.start - sentence.range.start,
                possibleAntecedents: antecedents,
                previousSentence: previous?.masked ?? null,
              },
              reason,
            ),
          );
        } else if (policy.reportReviewRequired) {
          diagnostics.push(
            buildDiagnostic(pronounSpec.meta, policy, {
              category: 'review-required',
              message: `${pronounSpec.reviewMessage} (${reason})`,
              range: word.range,
              evidence: excerpt(sentence.raw),
              meta: { pronoun: word.lower, antecedents: antecedents.length },
            }),
          );
        }
      }
    }
    return { diagnostics, candidates };
  },
};

/** Candidate antecedents: content words in the current and previous sentence, de-duplicated. */
function countAntecedents(sentence: Sentence, previous: Sentence | undefined): string[] {
  const seen = new Set<string>();
  const collect = (s: Sentence | undefined): void => {
    if (s === undefined) return;
    for (const word of s.words) {
      if (word.protectedKind !== undefined) {
        seen.add(word.text);
        continue;
      }
      if (isFunctionWord(word)) continue;
      if (IMPERATIVE_VERBS.has(word.lower)) continue;
      if (!/^[\p{L}][\p{L}-]{2,}$/u.test(word.text)) continue;
      seen.add(word.lower);
    }
  };
  collect(previous);
  collect(sentence);
  return [...seen].slice(0, 12);
}
