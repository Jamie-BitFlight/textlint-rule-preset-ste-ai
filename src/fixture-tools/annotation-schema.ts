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

export const annotationSchema = z.object({
  fixtureId: z.string().min(1),
  original: z.string().min(1),
  compliant: z.string().min(1),
  split: z.enum(['dev', 'heldout']),
  changes: z.array(annotationChangeSchema),
  /** Literals a reviewer asserts must be byte-identical. Cross-checked against the extractor. */
  protectedLiterals: z.array(z.string()).default([]),
  reviewers: z.array(z.string().min(1)).min(1),
  notes: z.string().optional(),
});

export type Annotation = z.output<typeof annotationSchema>;
export type AnnotationChange = z.output<typeof annotationChangeSchema>;
