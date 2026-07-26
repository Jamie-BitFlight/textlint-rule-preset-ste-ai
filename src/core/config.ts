import { z } from 'zod';
import type { DiagnosticCategory, Severity } from './types.js';

export const severitySchema = z.enum(['info', 'warning', 'error']);

/** How each diagnostic category is surfaced. Configurable per category. */
export const diagnosticPolicySchema = z.object({
  /**
   * When false, heuristic candidates that were never adjudicated are dropped instead of being
   * reported as `review-required`. Deterministic violations are unaffected.
   */
  reportReviewRequired: z.boolean().default(true),
  severity: z
    .object({
      'deterministic-violation': severitySchema.default('error'),
      'probable-semantic-violation': severitySchema.default('warning'),
      'review-required': severitySchema.default('info'),
      'suppressed-low-confidence': severitySchema.default('info'),
      'infrastructure-failure': severitySchema.default('warning'),
    })
    .prefault({}),
  /** Report suppressed low-confidence verdicts. Off by default: they are noise for most runs. */
  reportSuppressed: z.boolean().default(false),
  /**
   * What happens when the semantic service cannot be reached or returns unusable output.
   *
   * - `notice` — emit one `infrastructure-failure` diagnostic per run and no semantic findings.
   * - `silent` — emit nothing. Only safe when the caller checks the returned notices itself.
   * - `error`  — emit the notice at `error` severity so the run fails.
   *
   * A failure is never converted into "compliant": no policy suppresses the fact that
   * adjudication did not happen except `silent`, which requires the caller to read notices.
   */
  onSemanticServiceFailure: z.enum(['notice', 'silent', 'error']).default('notice'),
});

export type DiagnosticPolicy = z.output<typeof diagnosticPolicySchema>;

export const autofixPolicySchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Accept fixes that were gated by a semantic meaning-preservation evaluation. Off by default:
   * enabling it means trusting a model verdict to authorise a source rewrite.
   */
  allowSemanticFixes: z.boolean().default(false),
  /**
   * Never true. Present so that the refusal is explicit and testable rather than implicit.
   * Warnings, cautions and danger notices are not autofixed by this package.
   */
  allowInAdmonitions: z.literal(false).default(false),
});

export type AutofixPolicy = z.output<typeof autofixPolicySchema>;

export const semanticConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** llama.cpp server base URL. The OpenAI-compatible `/v1/chat/completions` route is used. */
  endpoint: z.string().default('http://127.0.0.1:8080'),
  /** Model identifier recorded in every trace. llama.cpp ignores it when one model is loaded. */
  model: z.string().default('local-ste-adjudicator'),
  apiKey: z.string().optional(),
  promptVersion: z.string().default('v1'),
  maxConcurrency: z.number().int().min(1).max(32).default(2),
  requestTimeoutMs: z.number().int().min(100).max(600_000).default(20_000),
  /** Retries for transport faults only. Invalid output is never retried by this setting. */
  maxTransportRetries: z.number().int().min(0).max(5).default(2),
  /**
   * One bounded re-ask when a response fails schema validation. The repair prompt restates the
   * schema and nothing else. Zero disables repair entirely.
   */
  maxRepairAttempts: z.number().int().min(0).max(1).default(1),
  cache: z.boolean().default(true),
  temperature: z.number().min(0).max(2).default(0),
  maxOutputTokens: z.number().int().min(64).max(4096).default(512),
  /** Emit a structured trace line per request to the configured trace sink. */
  trace: z.boolean().default(false),
  /**
   * Minimum model-reported confidence for a `violation` verdict to become a diagnostic, per
   * evaluator id. Below the threshold the verdict becomes `suppressed-low-confidence`.
   *
   * These are decision thresholds owned by the operator. They are deliberately kept separate
   * from the model's self-reported number, which is not a calibrated probability.
   */
  confidenceThresholds: z.record(z.string(), z.number().min(0).max(1)).default({}),
  defaultConfidenceThreshold: z.number().min(0).max(1).default(0.7),
  /** Evaluators to run. Empty means every evaluator that has candidates. */
  evaluators: z.array(z.string()).default([]),
});

export type SemanticConfig = z.output<typeof semanticConfigSchema>;

export const ruleUserConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    severity: severitySchema.optional(),
  })
  .catchall(z.unknown());

export const steAiConfigSchema = z.object({
  /**
   * Path to an authorised rule pack JSON file, or an inline pack object. When absent the bundled
   * provisional pack is used and every diagnostic is marked provisional.
   */
  rulePack: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  /** Project terminology protected as literal names. */
  approvedTerms: z.array(z.string()).default([]),
  /** Extra regular expressions protected as identifiers. */
  extraProtectedPatterns: z.array(z.string()).default([]),
  extraImperativeVerbs: z.array(z.string()).default([]),
  autofix: autofixPolicySchema.prefault({}),
  semantic: semanticConfigSchema.prefault({}),
  diagnostics: diagnosticPolicySchema.prefault({}),
  /** Per-rule options, keyed by bare rule id (for example `sentence-length-procedural`). */
  rules: z.record(z.string(), ruleUserConfigSchema).prefault({}),
});

export type SteAiConfig = z.output<typeof steAiConfigSchema>;
export type SteAiConfigInput = z.input<typeof steAiConfigSchema>;

export function resolveConfig(input: unknown): SteAiConfig {
  return steAiConfigSchema.parse(input ?? {});
}

export function severityFor(policy: DiagnosticPolicy, category: DiagnosticCategory): Severity {
  return policy.severity[category];
}
