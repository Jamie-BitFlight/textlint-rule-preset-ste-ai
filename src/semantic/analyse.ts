import type { AutofixPolicy, DiagnosticPolicy, SemanticConfig } from '../core/config.js';
import type {
  AnalysedDocument,
  CandidatePassage,
  Diagnostic,
  RuleStatus,
  RunNotice,
  SemanticTrace,
  SourceRange,
  TextFix,
} from '../core/types.js';
import { gateFix } from '../core/rule.js';
import type { SemanticBroker } from './broker.js';

export interface SemanticAnalysisInput {
  readonly doc: AnalysedDocument;
  readonly candidates: readonly CandidatePassage[];
  readonly broker: SemanticBroker;
  readonly config: SemanticConfig;
  readonly policy: DiagnosticPolicy;
  readonly autofix: AutofixPolicy;
  /** Status to stamp on semantic diagnostics; comes from the active rule pack. */
  readonly ruleStatus: RuleStatus;
  readonly signal?: AbortSignal;
}

export interface SemanticAnalysisResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly notices: readonly RunNotice[];
  readonly traces: readonly SemanticTrace[];
}

/**
 * Turn candidates into diagnostics.
 *
 * Three invariants hold here:
 *
 * 1. A model outage never becomes compliance. Every candidate that was not adjudicated is either
 *    reported as `review-required` or accounted for in a run notice, per the configured policy.
 * 2. Model-reported confidence is compared against an operator-owned threshold and both numbers
 *    are carried on the diagnostic, so a reader can see why a verdict was kept or suppressed.
 * 3. An evidence span is only used when it is inside the submitted passage and does not touch a
 *    protected region. Otherwise the diagnostic falls back to the candidate's own span.
 */
export async function analyseSemantically(
  input: SemanticAnalysisInput,
): Promise<SemanticAnalysisResult> {
  const { doc, candidates, broker, config, policy, ruleStatus } = input;
  if (candidates.length === 0) {
    return { diagnostics: [], notices: [], traces: [] };
  }

  const outcomes = await broker.adjudicate(candidates, input.signal);
  const byId = new Map(candidates.map((c) => [c.id, c]));

  const diagnostics: Diagnostic[] = [];
  const notices: RunNotice[] = [];
  const traces: SemanticTrace[] = [];

  const infrastructureFailures: { candidateId: string; message: string; kind: string }[] = [];
  let disabledCount = 0;

  for (const outcome of outcomes) {
    traces.push(outcome.trace);
    const candidate = byId.get(outcome.candidateId);
    if (candidate === undefined) continue;

    if (outcome.kind === 'failure') {
      if (outcome.failure.kind === 'disabled') {
        disabledCount += 1;
        pushReviewRequired(
          diagnostics,
          candidate,
          ruleStatus,
          policy,
          'Semantic adjudication did not run, so this candidate was not decided. A reviewer must ' +
            `decide it. Reason: ${candidate.reason}`,
        );
        continue;
      }
      infrastructureFailures.push({
        candidateId: candidate.id,
        message: outcome.failure.message,
        kind: outcome.failure.kind,
      });
      if (policy.onSemanticServiceFailure !== 'silent') {
        pushReviewRequired(
          diagnostics,
          candidate,
          ruleStatus,
          policy,
          'The semantic service did not return a usable verdict for this candidate, so it was ' +
            `not decided. Reason: ${outcome.failure.kind}.`,
        );
      }
      continue;
    }

    const verdict = outcome.verdict;
    const threshold =
      config.confidenceThresholds[candidate.evaluatorId] ?? config.defaultConfidenceThreshold;

    // A `compliant` verdict is exculpatory, so it must clear the operator's confidence bar just as
    // an adverse one must. Without this, `{"status":"compliant","confidence":0.01}` silently
    // removed a candidate from review — weak evidence could establish compliance while the same
    // confidence could not establish a violation.
    if (verdict.status === 'compliant') {
      if (verdict.confidence >= threshold) continue;
      pushReviewRequired(
        diagnostics,
        candidate,
        ruleStatus,
        policy,
        `Semantic adjudication returned "compliant" below the decision threshold ` +
          `(${verdict.confidence.toFixed(2)} < ${threshold.toFixed(2)}), so the passage was not ` +
          `decided: ${verdict.explanation}`,
        verdict.confidence,
        threshold,
      );
      continue;
    }

    if (verdict.status === 'uncertain') {
      pushReviewRequired(
        diagnostics,
        candidate,
        ruleStatus,
        policy,
        `Semantic adjudication returned "uncertain": ${verdict.explanation}`,
        verdict.confidence,
        threshold,
      );
      continue;
    }

    const range = resolveEvidenceRange(doc, candidate, verdict.evidenceStart, verdict.evidenceEnd);

    if (verdict.confidence < threshold) {
      if (!policy.reportSuppressed) continue;
      diagnostics.push({
        ruleId: candidate.ruleId,
        ruleStatus,
        category: 'suppressed-low-confidence',
        severity: policy.severity['suppressed-low-confidence'],
        message:
          `A semantic violation was reported below the decision threshold and was suppressed: ` +
          verdict.explanation,
        range,
        producedBy: 'semantic',
        candidateId: candidate.id,
        modelReportedConfidence: verdict.confidence,
        decisionThreshold: threshold,
        evidence: doc.text.slice(range.start, range.end),
        meta: { evaluatorId: candidate.evaluatorId, promptVersion: outcome.trace.promptVersion },
      });
      continue;
    }

    const fix = await maybeSemanticFix(input, candidate, verdict.suggestedReplacements, range);

    diagnostics.push({
      ruleId: candidate.ruleId,
      ruleStatus,
      category: 'probable-semantic-violation',
      severity: policy.severity['probable-semantic-violation'],
      message: `${verdict.explanation} (semantic adjudication, model-reported confidence ${verdict.confidence.toFixed(2)})`,
      range,
      producedBy: 'semantic',
      candidateId: candidate.id,
      modelReportedConfidence: verdict.confidence,
      decisionThreshold: threshold,
      evidence: doc.text.slice(range.start, range.end),
      ...(verdict.suggestedReplacements.length === 0
        ? {}
        : { suggestions: verdict.suggestedReplacements }),
      ...(fix === undefined ? {} : { fix }),
      meta: {
        evaluatorId: candidate.evaluatorId,
        promptVersion: outcome.trace.promptVersion,
        modelId: outcome.trace.modelId,
        meaningPreserved: verdict.meaningPreserved,
      },
    });
  }

  if (disabledCount > 0) {
    notices.push({
      code: 'semantic-disabled',
      level: 'info',
      message:
        `${disabledCount} passage(s) needed semantic adjudication, which is disabled. They are ` +
        'reported as review-required. No compliance conclusion was drawn about them.',
      detail: { candidates: disabledCount },
    });
  }

  if (infrastructureFailures.length > 0) {
    const first = infrastructureFailures[0];
    notices.push({
      code: 'semantic-service-failure',
      level: policy.onSemanticServiceFailure === 'error' ? 'error' : 'warning',
      message:
        `The semantic service failed for ${infrastructureFailures.length} of ${candidates.length} ` +
        `passage(s). No compliance conclusion was drawn about them. First failure: ` +
        `${first?.kind ?? 'unknown'} — ${first?.message ?? ''}`,
      detail: {
        failed: infrastructureFailures.length,
        total: candidates.length,
        policy: policy.onSemanticServiceFailure,
      },
    });
  }

  diagnostics.sort(
    (a, b) =>
      a.range.start - b.range.start ||
      a.range.end - b.range.end ||
      a.ruleId.localeCompare(b.ruleId),
  );
  return { diagnostics, notices, traces };
}

function pushReviewRequired(
  out: Diagnostic[],
  candidate: CandidatePassage,
  ruleStatus: RuleStatus,
  policy: DiagnosticPolicy,
  message: string,
  confidence?: number,
  threshold?: number,
): void {
  if (!policy.reportReviewRequired) return;
  out.push({
    ruleId: candidate.ruleId,
    ruleStatus,
    category: 'review-required',
    severity: policy.severity['review-required'],
    message,
    range: candidate.range,
    producedBy: 'semantic',
    candidateId: candidate.id,
    ...(confidence === undefined ? {} : { modelReportedConfidence: confidence }),
    ...(threshold === undefined ? {} : { decisionThreshold: threshold }),
    meta: { evaluatorId: candidate.evaluatorId },
  });
}

/**
 * Map a model-reported evidence span back to the source document.
 *
 * The model is told the offsets are into the passage exactly as supplied. Anything outside that
 * range, of zero length, or overlapping a protected region is discarded in favour of the
 * candidate's own span — a wrong highlight is worse than a coarse one.
 */
export function resolveEvidenceRange(
  doc: AnalysedDocument,
  candidate: CandidatePassage,
  evidenceStart: number,
  evidenceEnd: number,
): SourceRange {
  if (evidenceEnd <= evidenceStart) return candidate.range;
  if (evidenceEnd > candidate.passage.length) return candidate.range;
  const start = candidate.passageOffset + evidenceStart;
  const end = candidate.passageOffset + evidenceEnd;
  if (start < 0 || end > doc.text.length) return candidate.range;
  const range: SourceRange = { start, end };
  if (doc.isProtected(range)) return candidate.range;
  return range;
}

/**
 * Attach a semantic fix only after an independent meaning-preservation gate passes.
 *
 * The evaluator's own `meaningPreserved` flag is not sufficient: it comes from the same call that
 * proposed the change. A separate `rewrite-equivalence` request is made, and the replacement is
 * additionally checked to keep every protected literal in the span byte-identical.
 */
async function maybeSemanticFix(
  input: SemanticAnalysisInput,
  candidate: CandidatePassage,
  replacements: readonly string[],
  range: SourceRange,
): Promise<TextFix | undefined> {
  if (!input.autofix.enabled || !input.autofix.allowSemanticFixes) return undefined;
  if (candidate.admonition !== 'none') return undefined;
  const replacement = replacements[0];
  if (replacement === undefined || replacement.length === 0) return undefined;

  const original = input.doc.text.slice(range.start, range.end);
  if (original === replacement) return undefined;

  const literals = protectedLiteralsIn(input.doc, range);
  if (literals.some((literal) => !replacement.includes(literal))) return undefined;

  // A protected region that the fix range only partially covers would have its fragment rewritten,
  // so any overlap that is not full containment refuses the fix outright.
  if (overlapsProtectedRegionPartially(input.doc, range)) return undefined;

  const gate = await verifyRewriteEquivalence({
    broker: input.broker,
    ruleId: candidate.ruleId,
    original,
    rewritten: replacement,
    protectedLiterals: literals,
    invariants: candidate.invariants,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  // The gate's categorical flag must not override its own stated uncertainty when authorising a
  // source mutation, so an operator-owned minimum applies on top of it.
  if (!gate.equivalent) return undefined;
  if (gate.confidence < input.autofix.minimumSemanticFixConfidence) return undefined;

  const fix: TextFix = {
    range,
    text: replacement,
    rationale: `Independent rewrite-equivalence check passed (confidence ${gate.confidence.toFixed(2)}).`,
    safety: 'semantic-gated',
  };

  // The central gate, applied to the semantic branch as well as the deterministic one. An earlier
  // version attached this fix directly, so a model-proposed rewrite could change a quantity, a
  // negation, a modal verb or an ordering word — every refusal `checkFixSafety` exists to make.
  const refusal = gateFix({
    doc: input.doc,
    fix,
    admonition: candidate.admonition,
    ruleFixable: true,
    autofix: input.autofix,
  });
  if (refusal !== null) return undefined;

  return fix;
}

/**
 * True when `range` overlaps a protected region without wholly containing it.
 *
 * `protectedLiteralsIn` only collects regions the range fully contains, so a partial intersection
 * would leave a fragment of an identifier, command, path or URL eligible for rewriting while
 * escaping the preservation check entirely.
 */
export function overlapsProtectedRegionPartially(
  doc: AnalysedDocument,
  range: SourceRange,
): boolean {
  return doc.protectedRegions.some((region) => {
    if (!region.opaque) return false;
    const overlaps = region.range.start < range.end && range.start < region.range.end;
    if (!overlaps) return false;
    const contained = range.start <= region.range.start && region.range.end <= range.end;
    return !contained;
  });
}

/** Content-bearing protected literals inside a span, which any rewrite must keep verbatim. */
export function protectedLiteralsIn(doc: AnalysedDocument, range: SourceRange): string[] {
  const out: string[] = [];
  for (const region of doc.protectedRegions) {
    if (!region.opaque) continue;
    if (region.range.start < range.start || region.range.end > range.end) continue;
    if (
      region.kind === 'list-marker' ||
      region.kind === 'heading-marker' ||
      region.kind === 'blockquote-marker' ||
      region.kind === 'emphasis-marker' ||
      region.kind === 'table-markup'
    ) {
      continue;
    }
    out.push(doc.text.slice(region.range.start, region.range.end));
  }
  return [...new Set(out)];
}

export interface RewriteEquivalenceInput {
  readonly broker: SemanticBroker;
  readonly ruleId: string;
  readonly original: string;
  readonly rewritten: string;
  readonly protectedLiterals: readonly string[];
  readonly invariants: readonly string[];
  readonly signal?: AbortSignal;
}

export interface RewriteEquivalenceResult {
  readonly equivalent: boolean;
  readonly confidence: number;
  readonly explanation: string;
}

/**
 * Independent meaning-preservation check for a proposed rewrite.
 *
 * Exposed for the fixture-adjudication tooling as well as for the autofix gate. A failure of any
 * kind — transport, invalid output, uncertainty — returns `equivalent: false`. The gate fails
 * closed.
 */
export async function verifyRewriteEquivalence(
  input: RewriteEquivalenceInput,
): Promise<RewriteEquivalenceResult> {
  const candidate: CandidatePassage = {
    id: `rewrite-equivalence:${input.ruleId}`,
    ruleId: input.ruleId,
    evaluatorId: 'rewrite-equivalence',
    range: { start: 0, end: input.rewritten.length },
    passage: input.rewritten,
    passageOffset: 0,
    payload: {
      original: input.original,
      rewritten: input.rewritten,
      protectedLiterals: input.protectedLiterals,
    },
    invariants: input.invariants,
    reason: 'meaning-preservation gate',
    mode: 'procedural',
    admonition: 'none',
  };
  const [outcome] = await input.broker.adjudicate([candidate], input.signal);
  if (outcome === undefined || outcome.kind === 'failure') {
    return {
      equivalent: false,
      confidence: 0,
      explanation:
        outcome === undefined
          ? 'no verdict returned'
          : `gate failed: ${outcome.failure.kind} — ${outcome.failure.message}`,
    };
  }
  const verdict = outcome.verdict;
  return {
    equivalent: verdict.status === 'compliant' && verdict.meaningPreserved,
    confidence: verdict.confidence,
    explanation: verdict.explanation,
  };
}
