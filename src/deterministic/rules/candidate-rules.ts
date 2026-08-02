import { z } from 'zod';
import {
  buildSentencePosIndex,
  isFunctionWord,
  isImperativeVerbWord,
  type SentencePosIndex,
} from '../../core/pos-tags.js';
import { buildDiagnostic, type DeterministicRule, type RuleOutput } from '../../core/rule.js';
import type {
  CandidatePassage,
  Diagnostic,
  RuleMetadata,
  SemanticEvaluatorId,
  Sentence,
  SourceRange,
} from '../../core/types.js';
import { buildWinkPosIndex, type WinkPosIndex } from '../../core/wink-tags.js';
import { excerpt } from '../helpers.js';

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
 *
 * This list, and the `[a-z]{3,}ed` regular-participle shape below, are kept **verbatim** from the
 * pre-`wink-nlp` heuristic, deliberately, so this prototype changes exactly one variable: what
 * decides whether a matched `be + word` construction is really a passive, not what constructions
 * get matched in the first place. See {@link isPassiveParticiple} for why, and the "known gap
 * found, not fixed here" note below it for a real regex-shape gap corpus validation surfaced but
 * that is out of scope for that reason.
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

/**
 * Matches the same auxiliary set as the pre-`wink-nlp` heuristic (`is/are/was/were/be/been/
 * being/gets/get/got`) — unchanged, deliberately, per the prototype's own scope — and the same
 * word shape: a regular `-ed` participle of at least 5 letters, or a member of the irregular
 * {@link PARTICIPLES} list. {@link isPassiveParticiple} then adds `wink-nlp`'s POS tag as an
 * **additional** condition on top of that shape, rather than replacing the shape check, so this
 * prototype can only ever emit a subset of the candidates the old regex emitted, never a new span
 * — see the note below on why coverage expansion is deliberately out of scope here.
 */
const PASSIVE_RE = new RegExp(
  String.raw`\b(?<aux>is|are|was|were|be|been|being|gets|get|got)\s+(?<construction>(?:[a-z]+ly\s+)?(?<participle>[a-z]{3,}ed|${PARTICIPLES}))\b(?<agent>\s+by\b)?`,
  'gid',
);

interface PassiveMatchGroups {
  readonly aux: string;
  readonly construction: string;
  readonly participle: string;
  readonly agent?: string;
}

/**
 * Words `wink-nlp` mistags as `VERB` directly after a `be`-auxiliary with no article ("The SQLite
 * library **is code** that implements…"), regardless of surrounding sentence context — confirmed
 * directly, reproducible across several rewordings of the same sentence, not a one-off. `code` is
 * verb/noun-ambiguous the way `record`/`file`/`access` are (see `imperative-verbs.ts`), and
 * `wink-nlp`'s coarser universal tagset resolves the ambiguity the wrong way here where
 * `compromise`'s tagger (used elsewhere in this codebase) resolves the equivalent case correctly.
 * A small, empirically-justified override list, found by corpus validation, not enumerated in
 * advance — the same pattern used for `compromise`'s own false positives in `pos-tags.ts`.
 */
const WINK_FALSE_VERB_TAGS: ReadonlySet<string> = new Set(['code']);

/**
 * Is the word at `[start, end)` in `text` tagged as a verb by `wink-nlp`, rather than an adjective
 * or anything else? This is the tag-conditioned filter added on top of the old `PARTICIPLES`-list
 * shape check: it rejects an adjectival reading the list could not distinguish ("the SSL Engine is
 * disabled" tags `disabled` as `ADJ`, not `VERB` — confirmed directly).
 *
 * **Known gap found, not fixed here:** `[a-z]{3,}ed` requires at least 5 letters, so a real
 * 4-letter regular participle like `used` never reaches this function at all — "that protocol
 * **is used**" and "**be used** inside a `VirtualHost`" (`fixtures/original/curl-url-option-
 * reference.md`, `fixtures/original/httpd-mod-ssl-directive-config.md`) are genuine passives the
 * pre-`wink-nlp` regex has always missed. `wink-nlp` tags `used` `VERB` correctly and would catch
 * both if the shape gate above were loosened to admit them. That loosening is deliberately not
 * made part of this change: it would emit spans no reviewer has ever adjudicated, which the
 * project's own candidate/ground-truth invariant (`test/fixtures/corpus.test.ts`) exists to
 * prevent without a human review pass. Reported honestly rather than silently dropped or quietly
 * worked around by excluding `used` the way `code` is excluded above — `used` is not a tagging
 * mistake, unlike `code`.
 */
function isPassiveParticiple(index: WinkPosIndex, start: number, word: string): boolean {
  if (WINK_FALSE_VERB_TAGS.has(word.toLowerCase())) return false;
  return index.tagAt(start) === 'VERB';
}

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
      'Detects a `be` form followed by a word `wink-nlp` tags as a verb (a prototype POS-tag-' +
      'conditioned replacement for a closed participle list; see docs/provisional-rules.md). The ' +
      'construction is only a candidate: many such strings are adjectival ("the bolt is ' +
      'tightened" vs "the surface is clean"), and a passive is sometimes the clearest form in a ' +
      'description. Adjudication decides.',
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
      const matches = [...sentence.masked.matchAll(PASSIVE_RE)];
      if (matches.length === 0) continue;
      const winkIndex = buildWinkPosIndex(sentence.masked);
      for (const m of matches) {
        const groups = m.groups as PassiveMatchGroups | undefined;
        const participleRange = m.indices?.groups?.['participle'];
        if (groups === undefined || participleRange === undefined || m.index === undefined) {
          continue;
        }
        if (!isPassiveParticiple(winkIndex, participleRange[0], groups.participle)) continue;
        const hasAgent = groups.agent !== undefined;
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
                auxiliary: groups.aux,
                participle: groups.construction,
                hasExplicitAgent: hasAgent,
                offsetInPassage: m.index,
              },
              'Auxiliary plus a word wink-nlp tags as a verb.',
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
  run({ doc, options, pack, policy, extraImperativeVerbs }): RuleOutput {
    const limit = options.maxClusterLength ?? pack.limits.maxNounClusterLength;
    const diagnostics: Diagnostic[] = [];
    const candidates: CandidatePassage[] = [];

    for (const sentence of doc.sentences) {
      const posIndex = buildSentencePosIndex(sentence, extraImperativeVerbs);
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
          isFunctionWord(word, posIndex) ||
          isImperativeVerbWord(word, posIndex) ||
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
  run({ doc, options, policy, extraImperativeVerbs }): RuleOutput {
    const diagnostics: Diagnostic[] = [];
    const candidates: CandidatePassage[] = [];

    for (let s = 0; s < doc.sentences.length; s += 1) {
      const sentence = doc.sentences[s];
      if (sentence === undefined) continue;
      const previous = doc.sentences[s - 1];
      const words = sentence.words;

      const antecedents = countAntecedents(sentence, previous, extraImperativeVerbs);

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

/**
 * Candidate antecedents: content words in the current and previous sentence, de-duplicated.
 *
 * A protected token contributes a **placeholder naming its kind**, never its literal text. A path,
 * an inline code span or a configuration value is a candidate referent — the model needs to know one
 * is present — but transmitting the literal would leak content the protected-region machinery exists
 * to keep out of requests. `«file-path»` carries the whole of the signal that matters here.
 */
function countAntecedents(
  sentence: Sentence,
  previous: Sentence | undefined,
  extraImperativeVerbs: readonly string[],
): string[] {
  const seen = new Set<string>();
  const collect = (s: Sentence | undefined): void => {
    if (s === undefined) return;
    const posIndex: SentencePosIndex = buildSentencePosIndex(s, extraImperativeVerbs);
    for (const word of s.words) {
      if (word.protectedKind !== undefined) {
        seen.add(`«${word.protectedKind}»`);
        continue;
      }
      if (isFunctionWord(word, posIndex)) continue;
      if (isImperativeVerbWord(word, posIndex)) continue;
      if (!/^[\p{L}][\p{L}-]{2,}$/u.test(word.text)) continue;
      seen.add(word.lower);
    }
  };
  collect(previous);
  collect(sentence);
  return [...seen].slice(0, 12);
}
