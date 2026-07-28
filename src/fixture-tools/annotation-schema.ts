import { z } from 'zod';

/**
 * Adjudication record for one original/compliant fixture pair.
 *
 * The record is the audit trail for a rewrite: what changed, which rule motivated it, where the
 * violation was in the original, what the linter is expected to report, why the change is safe, and
 * what a reviewer was unwilling to decide.
 */

export const spanSchema = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(0),
});

export const expectedDiagnosticSchema = z.object({
  ruleId: z.string().min(1),
  category: z.enum([
    'deterministic-violation',
    'probable-semantic-violation',
    'review-required',
    'suppressed-low-confidence',
    'infrastructure-failure',
  ]),
  /** Exact substring of the original that the diagnostic must cover. */
  quote: z.string().min(1),
});

export const annotationChangeSchema = z.object({
  passageId: z.string().min(1),
  originalText: z.string().min(1),
  rewrittenText: z.string().min(1),
  ruleIds: z.array(z.string().min(1)).min(1),
  originalSpans: z.array(spanSchema).min(1),
  expectedDiagnostics: z.array(expectedDiagnosticSchema),
  reason: z.string().min(10),
  /** What must be identical in both versions. Prose, not code — a reviewer's statement of intent. */
  semanticInvariants: z.array(z.string().min(3)).min(1),
  unresolved: z.array(z.string()).default([]),
  status: z.enum(['accepted', 'disputed', 'deferred']),
  reviewerConfidence: z.number().min(0).max(1),
});

/**
 * A reviewer's verdict on a heuristic candidate passage.
 *
 * `changes` records rewrites, and a rewrite is the wrong shape for this judgement: deciding that a
 * passive sentence is acceptable produces no rewritten text, no invariants to preserve and nothing
 * to diff. Without a place to record "reviewed, and it is fine", every candidate the deterministic
 * pass could not decide stayed unlabelled — which left the semantic evaluation with no ground truth
 * at all and made precision and recall permanently incomputable.
 *
 * These records are ground truth for the semantic evaluators, so they are bound to a location: a
 * verdict applies to the span it was written about, never to every occurrence of the same rule in
 * the document.
 */
export const candidateAdjudicationSchema = z.object({
  /**
   * Run-local label, not an identity.
   *
   * Candidate ids embed a sentence ordinal, and that ordinal moves whenever segmentation changes
   * earlier in the document — fixing reStructuredText admonition detection renumbered every sentence
   * after a `.. note::` and changed six of these while their spans did not move a byte. Nothing joins
   * on this field: `goldLabelFor` binds by rule and span overlap, and the merge tool binds by rule,
   * span and quote.
   */
  passageId: z.string().min(1),
  ruleId: z.string().min(1),
  evaluatorId: z.string().min(1),
  /** Exact substring of the original that the reviewer judged. Half of the binding, with `span`. */
  quote: z.string().min(1),
  span: spanSchema,
  /**
   * `violation` — the passage really is defective under the rule's stated intent.
   * `non-violation` — the heuristic fired but the passage is acceptable.
   * `undecidable` — the reviewer declined; excluded from the confusion matrix.
   */
  verdict: z.enum(['violation', 'non-violation', 'undecidable']),
  reason: z.string().min(10),
  reviewer: z.string().min(1),
  reviewerConfidence: z.number().min(0).max(1),
});

export const annotationSchema = z.object({
  fixtureId: z.string().min(1),
  original: z.string().min(1),
  compliant: z.string().min(1),
  split: z.enum(['dev', 'heldout']),
  changes: z.array(annotationChangeSchema),
  /** Verdicts on heuristic candidates that produced no rewrite. */
  candidateAdjudications: z.array(candidateAdjudicationSchema).default([]),
  /** Literals a reviewer asserts must be byte-identical. Cross-checked against the extractor. */
  protectedLiterals: z.array(z.string()).default([]),
  reviewers: z.array(z.string().min(1)).min(1),
  notes: z.string().optional(),
});

export type Annotation = z.output<typeof annotationSchema>;
export type AnnotationChange = z.output<typeof annotationChangeSchema>;
export type CandidateAdjudication = z.output<typeof candidateAdjudicationSchema>;
