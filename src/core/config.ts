import { z } from 'zod';

export const severitySchema = z.enum(['info', 'warning', 'error']);

/**
 * Every object in this configuration is strict: an unrecognised key is an error, not something to
 * drop quietly.
 *
 * A stripped key is the worst possible outcome for a policy file. `diagnostics.severity` keyed on a
 * misspelt category, a mistyped `semantic` timeout, a rule id that does not exist — each of those
 * parsed successfully and then applied nothing, so the operator read their own file as proof of a
 * setting the linter had already discarded. Rejecting the key names the mistake at the boundary
 * where it can still be fixed.
 *
 * The one deliberate exception is {@link ruleUserConfigSchema}, whose catch-all is documented there.
 */

/** How each diagnostic category is surfaced. Configurable per category. */
export const diagnosticPolicySchema = z.strictObject({
  /**
   * When false, heuristic candidates that were never adjudicated are dropped instead of being
   * reported as `review-required`. Deterministic violations are unaffected.
   */
  reportReviewRequired: z.boolean().default(true),
  severity: z
    .strictObject({
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

export const autofixPolicySchema = z.strictObject({
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
  /**
   * Minimum model-reported confidence from the independent rewrite-equivalence gate before a
   * semantic fix may be attached. Deliberately stricter than the diagnostic threshold: reporting a
   * finding and mutating a source file are different levels of trust.
   */
  minimumSemanticFixConfidence: z.number().min(0).max(1).default(0.9),
});

export type AutofixPolicy = z.output<typeof autofixPolicySchema>;

export const suppressionPolicySchema = z.strictObject({
  /**
   * Inline directives are honoured. When false the document is not scanned at all: no directive
   * is parsed, no record is produced and no suppression notice is emitted.
   */
  enabled: z.boolean().default(true),
  /**
   * Permit an inline directive to withhold a finding inside a danger, warning or caution
   * admonition. Off by default, and every such suppression is recorded either way.
   */
  allowInAdmonitions: z.boolean().default(false),
});

export type SuppressionPolicy = z.output<typeof suppressionPolicySchema>;

export const semanticConfigSchema = z.strictObject({
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

/**
 * Per-rule user options.
 *
 * The catch-all is deliberate and must stay. Every rule declares its own `optionsSchema`, and the
 * runner validates the merged options against it (`src/core/runner.ts`), emitting a
 * `rule-options-invalid` notice when they do not fit. This schema therefore cannot know which keys
 * are legitimate — making it strict would reject every rule-specific option in existence, and would
 * move option validation away from the only place that knows the answer.
 *
 * The rule *ids* are still checked: the runner emits an `unknown-rule-id` notice for a key here that
 * names no registered rule.
 */
export const ruleUserConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    severity: severitySchema.optional(),
  })
  .catchall(z.unknown());

export const steAiConfigSchema = z.strictObject({
  /**
   * Path to an authorised rule pack JSON file, or an inline pack object. When absent the bundled
   * provisional pack is used and every diagnostic is marked provisional.
   */
  rulePack: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  /**
   * Packs the operator has decided to trust, by `metadata.id`.
   *
   * Schema validation proves a pack's *shape*, never its *authority*. Any JSON file can declare
   * `authority: "normative"`, so an imported pack is untrusted by default and its self-declared
   * authority is reported as supplier-declared metadata only. A pack must be named here before the
   * linter treats its authority as application-verified.
   */
  trustedRulePackIds: z.array(z.string()).default([]),
  /** Project terminology protected as literal names. */
  approvedTerms: z.array(z.string()).default([]),
  /** Extra regular expressions protected as identifiers. */
  extraProtectedPatterns: z.array(z.string()).default([]),
  extraImperativeVerbs: z.array(z.string()).default([]),
  autofix: autofixPolicySchema.prefault({}),
  semantic: semanticConfigSchema.prefault({}),
  diagnostics: diagnosticPolicySchema.prefault({}),
  suppressions: suppressionPolicySchema.prefault({}),
  /** Per-rule options, keyed by bare rule id (for example `sentence-length-procedural`). */
  rules: z.record(z.string(), ruleUserConfigSchema).prefault({}),
});

export type SteAiConfig = z.output<typeof steAiConfigSchema>;
export type SteAiConfigInput = z.input<typeof steAiConfigSchema>;

/** Thrown when the shared configuration does not validate. Names every offending key by path. */
export class SteAiConfigError extends Error {
  readonly issues: readonly { readonly path: string; readonly message: string }[];

  constructor(issues: readonly { readonly path: string; readonly message: string }[]) {
    super(
      `Invalid ste-ai configuration:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`,
    );
    this.name = 'SteAiConfigError';
    this.issues = issues;
  }
}

/**
 * Formatted rather than raw: a `ZodError`'s own message is a JSON dump of its issue list, and the
 * one thing the reader of a rejected config file needs — which key, where — is the hardest part of
 * it to find. The shape matches the runner's `rule-options-invalid` notice for the same reason.
 */
export function formatConfigIssues(
  error: z.ZodError,
): readonly { readonly path: string; readonly message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.') || '<root>',
    message: issue.message,
  }));
}

export function resolveConfig(input: unknown): SteAiConfig {
  const result = steAiConfigSchema.safeParse(input ?? {});
  if (!result.success) throw new SteAiConfigError(formatConfigIssues(result.error));
  return result.data;
}
