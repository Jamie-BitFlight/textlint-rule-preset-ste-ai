import { resolveConfig, type SteAiConfig, type SteAiConfigInput } from '../core/config.js';
import { analyseDocument } from '../core/document.js';
import { runDeterministicRules } from '../core/runner.js';
import {
  applySuppressions,
  DIRECTIVE_TEXT_REASON,
  directiveFor,
  refuseInAdmonition,
  scanSuppressions,
} from '../core/suppressions.js';
import { maskRanges } from '../core/text.js';
import type {
  AnalysedDocument,
  CandidatePassage,
  Diagnostic,
  DocumentFormat,
  RulePack,
  RunNotice,
  SemanticTrace,
  SourceRange,
  SuppressionDirective,
  SuppressionRecord,
} from '../core/types.js';
import { deterministicRules } from '../deterministic/index.js';
import { LlamaCppClient } from '../model-client/llama-client.js';
import type { ModelTransport } from '../model-client/types.js';
import { resolveRulePack, verifiedAuthority } from '../rule-pack/loader.js';
import { analyseSemantically } from '../semantic/analyse.js';
import { SemanticBroker, type SemanticBrokerDeps } from '../semantic/broker.js';
import { resolveOverlappingFixes } from '../core/runner.js';

/**
 * The programmatic entry point.
 *
 * This module composes the pieces — rule pack, document analysis, deterministic rules, optional
 * semantic adjudication — and contains no rule logic of its own. It is what both the textlint
 * adapter and the CLI call.
 */

export interface AnalyseTextOptions {
  readonly id?: string;
  readonly path?: string;
  readonly format?: DocumentFormat;
  readonly config?: SteAiConfigInput;
  /** Base directory used to resolve a relative `rulePack` path. */
  readonly baseDir?: string;
  /** Injected transport. When absent and semantic analysis is on, a llama.cpp client is built. */
  readonly transport?: ModelTransport;
  readonly brokerDeps?: Partial<Omit<SemanticBrokerDeps, 'transport'>>;
  readonly signal?: AbortSignal;
}

export interface AnalysisResult {
  readonly document: AnalysedDocument;
  readonly diagnostics: readonly Diagnostic[];
  /**
   * Passages the deterministic rules handed to a semantic evaluator.
   *
   * Exposed because these, and only these, are what the semantic evaluators are measured on: the
   * evaluation harness and the fixture-adjudication tooling both need the exact passage list, with
   * spans, and recomputing it from diagnostics would not recover the evaluator routing or payload.
   */
  readonly candidates: readonly CandidatePassage[];
  /**
   * Findings an inline directive withheld, with the reason the author gave.
   *
   * A suppression is an authored claim, not a deletion. `docs/diagnostic-policy.md` forbids silence
   * from meaning compliance, so what was withheld leaves the diagnostic list and stays in the
   * result.
   */
  readonly suppressions: readonly SuppressionRecord[];
  readonly notices: readonly RunNotice[];
  readonly traces: readonly SemanticTrace[];
  readonly pack: RulePack;
  readonly config: SteAiConfig;
}

/** Deterministic-only analysis. Never performs I/O beyond reading the rule pack. */
export function analyseTextDeterministic(
  text: string,
  options: AnalyseTextOptions = {},
): AnalysisResult {
  const config = resolveConfig(options.config ?? {});
  const pack = resolveRulePack(config.rulePack, options.baseDir ?? process.cwd());
  const format = options.format ?? 'markdown';

  const document = analyseDocument(
    {
      id: options.id ?? options.path ?? 'document',
      format,
      text,
      ...(options.path === undefined ? {} : { path: options.path }),
    },
    {
      protectedRegions: {
        approvedTerms: [...config.approvedTerms, ...pack.approvedTechnicalTerms],
        extraPatterns: config.extraProtectedPatterns,
      },
      structure: { extraImperativeVerbs: config.extraImperativeVerbs },
    },
  );

  // Fix conflicts are resolved below instead, once the suppressed findings are out of the list: a
  // finding nobody will be shown must not be able to veto another finding's fix.
  const run = runDeterministicRules({
    doc: document,
    rules: deterministicRules,
    config,
    pack,
    resolveFixes: false,
  });

  const pass = suppressCandidates(document, run.candidates, config);

  // Candidates are passages no deterministic rule could decide. Returning only `run.diagnostics`
  // discarded them, so a document whose only findings needed adjudication reported clean — the
  // exact "silence means compliant" failure the diagnostic policy exists to prevent.
  const undecided = undecidedCandidateDiagnostics(
    pass.candidates,
    config,
    verifiedAuthority(pack, config.trustedRulePackIds),
  );

  const suppressed = suppressDiagnostics(
    document,
    [...run.diagnostics, ...undecided.diagnostics],
    pass,
    config,
  );

  const resolved = resolveOverlappingFixes(suppressed.diagnostics);

  return {
    document,
    candidates: pass.candidates,
    suppressions: suppressed.suppressions,
    diagnostics: [...resolved.diagnostics].sort(
      (a, b) =>
        a.range.start - b.range.start ||
        a.range.end - b.range.end ||
        a.ruleId.localeCompare(b.ruleId),
    ),
    notices: [...run.notices, ...undecided.notices, ...suppressed.notices, ...resolved.notices],
    traces: [],
    pack,
    config,
  };
}

/** What the candidate pass removed, and what the diagnostic pass needs to know about it. */
interface CandidateSuppressionPass {
  readonly directives: readonly SuppressionDirective[];
  readonly notices: readonly RunNotice[];
  /** The candidates that survived. */
  readonly candidates: readonly CandidatePassage[];
  readonly records: readonly SuppressionRecord[];
  /** Directives that claimed a candidate, so the applier does not call them dead. */
  readonly claimed: readonly SuppressionDirective[];
  /**
   * Candidates refused inside a safety admonition, already reported here.
   *
   * A refused candidate proceeds to adjudication and produces a diagnostic that `applySuppressions`
   * will match against the very same directive — passed through so it does not report the same
   * refusal a second time.
   */
  readonly refused: readonly { readonly ruleId: string; readonly range: SourceRange }[];
}

/**
 * Scan for inline directives and drop every candidate one of them claims.
 *
 * Candidates are filtered here — before adjudication — rather than alongside the diagnostics.
 * Filtering afterwards would withhold the diagnostic but still have sent the passage to the model:
 * an operator who has already ruled on a passage would keep paying for it to be re-adjudicated, and
 * text they had deliberately marked as settled would still leave the process.
 */
function suppressCandidates(
  document: AnalysedDocument,
  candidates: readonly CandidatePassage[],
  config: SteAiConfig,
): CandidateSuppressionPass {
  // `enabled: false` means the document is not read for directives at all, not that the directives
  // are parsed and ignored — an audit run must see the document as written.
  if (!config.suppressions.enabled) {
    return { directives: [], notices: [], candidates, records: [], claimed: [], refused: [] };
  }

  const scan = scanSuppressions(document);
  const notices: RunNotice[] = [...scan.notices];
  const kept: CandidatePassage[] = [];
  const records: SuppressionRecord[] = [];
  const claimed = new Set<SuppressionDirective>();
  const refused: { ruleId: string; range: SourceRange }[] = [];

  for (const candidate of candidates) {
    // Unconditional, and ahead of any directive match: in `format: 'text'` the comment is not
    // masked, so the reason an author wrote inside one is lintable prose and would otherwise be
    // shipped to the model — spending a request on text nobody wrote for a reader, and sending the
    // very passage the directive exists to keep in the process.
    const commentRange = scan.commentRanges.find(
      (range) => candidate.range.start >= range.start && candidate.range.start < range.end,
    );
    if (commentRange !== undefined) {
      records.push(candidateRecord(candidate, DIRECTIVE_TEXT_REASON, commentRange));
      continue;
    }

    const directive = directiveFor(scan.directives, candidate.ruleId, candidate.range.start);
    if (directive === undefined) {
      kept.push(redactDirectiveComments(candidate, scan.commentRanges));
      continue;
    }
    // Counted as used even when the claim is refused below: the directive did point at a real
    // passage, so `suppression-unused` would be a second and misleading complaint about it.
    claimed.add(directive);

    // A refused claim leaves the candidate in the run, so the passage is still adjudicated and
    // still reported. Withholding it here would silence a safety notice more completely than any
    // directive aimed at a diagnostic can.
    const refusal = refuseInAdmonition(
      candidate.ruleId,
      candidate.admonition,
      config.suppressions.allowInAdmonitions,
    );
    if (refusal !== undefined) {
      notices.push(refusal);
      refused.push({ ruleId: candidate.ruleId, range: candidate.range });
      kept.push(redactDirectiveComments(candidate, scan.commentRanges));
      continue;
    }

    records.push(candidateRecord(candidate, directive.reason, directive.directiveRange));
  }

  return {
    directives: scan.directives,
    notices,
    candidates: kept,
    records,
    claimed: [...claimed],
    refused,
  };
}

/**
 * Mask any directive-comment text caught inside a surviving candidate's passage.
 *
 * `passage` is built from the whole sentence a candidate's match falls in
 * (`pushCandidate` in `src/deterministic/rules/candidate-rules.ts`), and a directive comment can
 * share a sentence with the prose it annotates — in `format: 'text'` a comment is not masked out at
 * all, and even in markdown a sentence can run from a comment straight into unpunctuated prose. A
 * candidate anchored in the prose therefore is not itself suppressed, but without this its passage
 * would still carry the comment's raw text — an unrelated rule id, another rule's reason, the
 * directive's own reason — out to the semantic service. `docs/suppression.md` promises a suppressed
 * passage never leaves the process; a passage that merely shares a sentence with one should not
 * leak the directive's text either.
 *
 * Masked with {@link maskRanges} rather than deleted, so `passageOffset` stays a valid arithmetic
 * base for every span in the passage, exactly as `doc.maskedText` never changes length.
 */
function redactDirectiveComments(
  candidate: CandidatePassage,
  commentRanges: readonly SourceRange[],
): CandidatePassage {
  const local = commentRanges
    .map((range) => ({
      start: range.start - candidate.passageOffset,
      end: range.end - candidate.passageOffset,
    }))
    .filter((range) => range.end > 0 && range.start < candidate.passage.length);
  if (local.length === 0) return candidate;
  return { ...candidate, passage: maskRanges(candidate.passage, local) };
}

/**
 * A record for a candidate withheld before adjudication.
 *
 * `review-required` is the category the candidate would have carried had it survived, so that is
 * what the record says was withheld; its `reason` field is the candidate's own, which is the
 * message the diagnostic would have explained itself with.
 */
function candidateRecord(
  candidate: CandidatePassage,
  reason: string,
  directiveRange: SourceRange,
): SuppressionRecord {
  return {
    ruleId: candidate.ruleId,
    category: 'review-required',
    range: candidate.range,
    message: candidate.reason,
    reason,
    directiveRange,
  };
}

interface DiagnosticSuppressionResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly suppressions: readonly SuppressionRecord[];
  readonly notices: readonly RunNotice[];
}

/** Apply the directives found by {@link suppressCandidates} to the final diagnostic list. */
function suppressDiagnostics(
  document: AnalysedDocument,
  diagnostics: readonly Diagnostic[],
  pass: CandidateSuppressionPass,
  config: SteAiConfig,
): DiagnosticSuppressionResult {
  if (!config.suppressions.enabled) return { diagnostics, suppressions: [], notices: [] };

  const applied = applySuppressions({
    doc: document,
    diagnostics,
    directives: pass.directives,
    allowInAdmonitions: config.suppressions.allowInAdmonitions,
    knownRuleIds: deterministicRules.map((rule) => rule.meta.id),
    alreadyClaimed: pass.claimed,
    alreadyRefused: pass.refused,
  });

  const suppressions = [...pass.records, ...applied.suppressions].sort(
    (a, b) => a.range.start - b.range.start || a.ruleId.localeCompare(b.ruleId),
  );

  return {
    diagnostics: applied.diagnostics,
    suppressions,
    notices: [...pass.notices, ...withRunTotal(applied.notices, suppressions.length)],
  };
}

/**
 * Restate `suppressions-applied` over the whole run.
 *
 * `applySuppressions` can only count the diagnostics it withheld; the candidates were filtered
 * before it ran and never reach it. Left alone its count would disagree with the `suppressions`
 * array it purports to describe, and a count that under-reports what was withheld is precisely the
 * failure this feature's record keeping exists to prevent.
 */
function withRunTotal(notices: readonly RunNotice[], total: number): RunNotice[] {
  const rest = notices.filter((notice) => notice.code !== 'suppressions-applied');
  if (total === 0) return rest;
  return [
    ...rest,
    {
      code: 'suppressions-applied',
      level: 'info',
      message: `${total} finding(s) were withheld by an inline suppression directive.`,
      detail: { count: total },
    },
  ];
}

/**
 * Turn unadjudicated candidates into `review-required` diagnostics plus a run notice.
 *
 * Used by the deterministic-only path, which never contacts a service and therefore never receives
 * a verdict for them. The semantic path does the equivalent through `analyseSemantically`.
 */
function undecidedCandidateDiagnostics(
  candidates: readonly CandidatePassage[],
  config: SteAiConfig,
  ruleStatus: RulePack['metadata']['authority'],
): { diagnostics: Diagnostic[]; notices: RunNotice[] } {
  if (candidates.length === 0) return { diagnostics: [], notices: [] };

  const diagnostics: Diagnostic[] = config.diagnostics.reportReviewRequired
    ? candidates.map((candidate) => ({
        ruleId: candidate.ruleId,
        ruleStatus,
        category: 'review-required' as const,
        severity: config.diagnostics.severity['review-required'],
        message:
          'This passage needs semantic adjudication, which did not run, so it was not decided. ' +
          `A reviewer must decide it. Reason: ${candidate.reason}`,
        range: candidate.range,
        producedBy: 'deterministic' as const,
        meta: { evaluatorId: candidate.evaluatorId },
      }))
    : [];

  return {
    diagnostics,
    notices: [
      {
        code: 'semantic-disabled',
        level: 'info',
        message:
          `${candidates.length} passage(s) needed semantic adjudication, which did not run. They ` +
          'are reported as review-required. No compliance conclusion was drawn about them.',
        detail: { candidates: candidates.length },
      },
    ],
  };
}

/**
 * Full analysis: deterministic rules, then semantic adjudication of any candidates when the
 * semantic subsystem is enabled.
 *
 * With `semantic.enabled` false this returns exactly what {@link analyseTextDeterministic}
 * returns plus `review-required` diagnostics for undecided candidates, and performs no network I/O.
 */
export async function analyseText(
  text: string,
  options: AnalyseTextOptions = {},
): Promise<AnalysisResult> {
  const config = resolveConfig(options.config ?? {});
  const pack = resolveRulePack(config.rulePack, options.baseDir ?? process.cwd());
  const format = options.format ?? 'markdown';

  const document = analyseDocument(
    {
      id: options.id ?? options.path ?? 'document',
      format,
      text,
      ...(options.path === undefined ? {} : { path: options.path }),
    },
    {
      protectedRegions: {
        approvedTerms: [...config.approvedTerms, ...pack.approvedTechnicalTerms],
        extraPatterns: config.extraProtectedPatterns,
      },
      structure: { extraImperativeVerbs: config.extraImperativeVerbs },
    },
  );

  // Overlap resolution is deferred to the merged, post-suppression list below. It has to see the
  // semantic fixes anyway, and a withheld finding must not veto a surviving finding's fix.
  const run = runDeterministicRules({
    doc: document,
    rules: deterministicRules,
    config,
    pack,
    resolveFixes: false,
  });

  const pass = suppressCandidates(document, run.candidates, config);

  const transport: ModelTransport =
    options.transport ??
    new LlamaCppClient({
      endpoint: config.semantic.endpoint,
      requestTimeoutMs: config.semantic.requestTimeoutMs,
      ...(config.semantic.apiKey === undefined ? {} : { apiKey: config.semantic.apiKey }),
    });

  const broker = new SemanticBroker(config.semantic, { transport, ...options.brokerDeps });

  const semantic = await analyseSemantically({
    doc: document,
    candidates: pass.candidates,
    broker,
    config: config.semantic,
    policy: config.diagnostics,
    autofix: config.autofix,
    // The authority the linter acts on, not the authority the pack claims for itself. An
    // untrusted pack's findings are reported as `supplementary`, never `normative`.
    ruleStatus: verifiedAuthority(pack, config.trustedRulePackIds),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const suppressed = suppressDiagnostics(
    document,
    [...run.diagnostics, ...semantic.diagnostics],
    pass,
    config,
  );

  // Overlap resolution must see deterministic and semantic fixes together, and must see only the
  // findings that survived suppression.
  const merged = resolveOverlappingFixes(suppressed.diagnostics);
  const diagnostics = [...merged.diagnostics].sort(
    (a, b) =>
      a.range.start - b.range.start ||
      a.range.end - b.range.end ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.category.localeCompare(b.category),
  );

  return {
    document,
    candidates: pass.candidates,
    suppressions: suppressed.suppressions,
    diagnostics,
    notices: [...run.notices, ...semantic.notices, ...suppressed.notices, ...merged.notices],
    traces: semantic.traces,
    pack,
    config,
  };
}
