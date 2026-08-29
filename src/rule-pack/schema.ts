import { z } from 'zod';
import { RULE_PACK_ID_MAX_LENGTH, RULE_PACK_ID_PATTERN } from '../core/rule-pack-id.js';

/**
 * Rule-pack schema — the **only** supported route by which normative controlled-language data
 * enters this package.
 *
 * The controlled-language dictionary, the term mappings and the numeric limits are read from a
 * pack that satisfies this schema, so an authorised licensee can supply the real dictionary and
 * rule data without changing a line of rule code.
 *
 * That is not the same as "no rule hard-codes vocabulary", which this comment used to claim and
 * which is false: `src/deterministic/rules/candidate-rules.ts` holds `PARTICIPLES`, `PRONOUNS` and
 * `BARE_DEMONSTRATIVE_FOLLOWERS` in code, and no field here reaches them. A pack can suppress one
 * of those triggers, because `approvedTechnicalTerms` protects a token before any rule scans it,
 * but it cannot add a word to the list. The limitation runs one way only.
 *
 * Do not restate the control surface in prose here or anywhere else. It is generated from this
 * schema into `docs/rule-pack-import.md` and enforced by
 * `test/architecture/doc-pack-control-surface.test.ts`; every hand-maintained version of the list
 * has gone stale and been caught in review.
 *
 * See `docs/rule-pack-import.md` for the import procedure and the licence obligations.
 */

export const ruleStatusSchema = z.enum(['normative', 'supplementary', 'provisional']);
export const severitySchema = z.enum(['info', 'warning', 'error']);

/**
 * `id` is a match key, compared by exact string membership against `trustedRulePackIds`
 * (`src/rule-pack/loader.ts`'s `verifiedAuthority`/`packPermitsConformanceClaim`) and, for the one
 * bundled pack, by object identity (`src/core/runner.ts`). It is never displayed as prose on its
 * own — the withheld-citation message in `runner.ts` interpolates it, which only stays safe
 * because `RULE_PACK_ID_PATTERN` (`src/core/rule-pack-id.ts`) excludes every character that could
 * make it read as something other than an id: no space (so it cannot be a phrase, PR #116 round
 * 5/10), no `"` (so it cannot break out of the quoted template, round 7), no control character or
 * Unicode line/paragraph separator (round 5/10 again), no bidirectional-override character.
 * `metadata.name`, `metadata.notice` and `metadata.source` remain unconstrained free text for
 * anything meant to be read.
 *
 * `runner.ts` also checks this same pattern directly, at the point it interpolates the id, rather
 * than trusting that every `RulePack` it receives passed through this schema (round 11: a caller
 * of the public `runDeterministicRules` API can hand it a pack literal that never went through
 * `parseRulePack` at all).
 */
const rulePackIdSchema = z
  .string()
  .min(1)
  .max(RULE_PACK_ID_MAX_LENGTH)
  .regex(
    RULE_PACK_ID_PATTERN,
    'must start with a letter, digit, or @, and contain only letters, digits, and . _ : @ / + -',
  );

export const rulePackMetadataSchema = z.object({
  id: rulePackIdSchema,
  name: z.string().min(1),
  version: z.string().min(1),
  /**
   * `normative` asserts that the pack carries the rule data of a controlled-language standard and
   * that the supplier is licensed to do so. The linter never sets this value itself.
   */
  authority: ruleStatusSchema,
  licence: z.string().min(1),
  source: z.string().min(1),
  retrievedAt: z.string().optional(),
  conformanceClaim: z.enum(['none', 'partial', 'declared-by-supplier']),
  notice: z.string().optional(),
});

export const approvedTermSchema = z.object({
  term: z.string().min(1),
  partsOfSpeech: z.array(z.string()).optional(),
  senses: z.array(z.string()).optional(),
});

export const unapprovedTermSchema = z.object({
  term: z.string().min(1),
  alternatives: z.array(z.string()).default([]),
  note: z.string().optional(),
  /**
   * True only if replacing the term with `alternatives[0]` cannot change technical meaning in any
   * context this pack covers. Packs must default this to false; the linter never infers it.
   */
  safeSubstitution: z.boolean().default(false),
  partOfSpeech: z.string().optional(),
});

export const preferredTermSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  safeSubstitution: z.boolean().default(false),
  note: z.string().optional(),
});

export const rulePackLimitsSchema = z.object({
  /**
   * Flesch-Kincaid grade level above which a procedural (instruction) sentence is reported.
   * Replaces the old `proceduralSentenceMaxWords` word-count limit — see
   * `docs/provisional-rules.md#sentence-length-procedural` for why, and for the granularity
   * caveat that motivates `sentenceReadabilityFloorWords` below.
   */
  proceduralMaxGradeLevel: z.number().min(1).max(20),
  /** As above, applied to descriptive (non-instruction) sentences. */
  descriptiveMaxGradeLevel: z.number().min(1).max(20),
  /**
   * Minimum word count a sentence must reach before the grade-level check applies at all.
   * Readability formulas are normed on passages, not single short sentences; below this floor a
   * sentence is presumed simple regardless of its vocabulary, and the grade-level score is not
   * computed. See `docs/provisional-rules.md#sentence-length-procedural`.
   */
  sentenceReadabilityFloorWords: z.number().int().min(1).max(200),
  maxNounClusterLength: z.number().int().min(2).max(10),
  maxSentencesPerProceduralStep: z.number().int().min(1).max(10),
});

export const rulePackRuleSpecSchema = z.object({
  ruleId: z.string().min(1),
  status: ruleStatusSchema,
  /**
   * Reference for the rule's authority. For provisional rules this points at this repository's
   * own documentation; it must never be a citation of a standard the pack is not licensed to
   * reproduce.
   */
  sourceRef: z.string().min(1),
  enabled: z.boolean().default(true),
  severity: severitySchema.optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

export const rulePackSchema = z.object({
  metadata: rulePackMetadataSchema,
  limits: rulePackLimitsSchema,
  dictionary: z.object({
    approved: z.array(approvedTermSchema).default([]),
    unapproved: z.array(unapprovedTermSchema).default([]),
    preferred: z.array(preferredTermSchema).default([]),
  }),
  contractions: z.array(preferredTermSchema).default([]),
  approvedTechnicalTerms: z.array(z.string()).default([]),
  rules: z.array(rulePackRuleSpecSchema).default([]),
});

export type ParsedRulePack = z.output<typeof rulePackSchema>;
