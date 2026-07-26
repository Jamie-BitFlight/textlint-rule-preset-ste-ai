import { z } from 'zod';

/**
 * Rule-pack schema — the **only** supported route by which normative controlled-language data
 * enters this package.
 *
 * Nothing in `src/deterministic` hard-codes vocabulary. Every word list, term mapping and numeric
 * limit is read from a pack that satisfies this schema, so an authorised licensee can supply the
 * real dictionary and rule data without changing a line of rule code.
 *
 * See `docs/rule-pack-import.md` for the import procedure and the licence obligations.
 */

export const ruleStatusSchema = z.enum(['normative', 'supplementary', 'provisional']);
export const severitySchema = z.enum(['info', 'warning', 'error']);

export const rulePackMetadataSchema = z.object({
  id: z.string().min(1),
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
  proceduralSentenceMaxWords: z.number().int().min(1).max(200),
  descriptiveSentenceMaxWords: z.number().int().min(1).max(200),
  maxNounClusterLength: z.number().int().min(2).max(10),
  maxSentencesPerProceduralStep: z.number().int().min(1).max(10),
  maxParagraphSentences: z.number().int().min(1).max(50),
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
