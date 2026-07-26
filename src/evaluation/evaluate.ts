import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig, type SteAiConfigInput } from '../core/config.js';
import { analyseDocument } from '../core/document.js';
import { runDeterministicRules } from '../core/runner.js';
import type { CandidatePassage, SemanticEvaluatorId, SourceRange } from '../core/types.js';
import { deterministicRules } from '../deterministic/index.js';
import type { ModelTransport } from '../model-client/types.js';
import { resolveRulePack } from '../rule-pack/loader.js';
import { SemanticBroker } from '../semantic/broker.js';
import { annotationSchema, type Annotation } from '../fixture-tools/annotation-schema.js';
import { fixtureManifestSchema, type FixtureEntry } from '../fixture-tools/manifest-schema.js';

/**
 * Semantic-evaluator measurement.
 *
 * Ground truth comes from the fixture adjudication records, not from the linter's own output:
 *
 * - a candidate whose span is covered by an **accepted** change for the same rule is a gold
 *   violation — a reviewer decided the passage really was defective;
 * - a candidate covered by a **disputed** change is a gold non-violation — a reviewer decided the
 *   deterministic pass was wrong;
 * - anything else is **unlabelled** and is excluded from the confusion matrix and reported
 *   separately, so the numbers are never inflated by guessing at unreviewed passages.
 *
 * Splits are enforced: evaluating on `heldout` refuses to touch `dev` fixtures. Prompt and
 * threshold tuning belongs on `dev`; a number quoted from `heldout` means something only if it was
 * never tuned against.
 */

export type GoldLabel = 'violation' | 'non-violation' | 'unlabelled';
export type Prediction = 'violation' | 'non-violation' | 'uncertain' | 'failed';

export interface EvaluationCase {
  readonly fixtureId: string;
  readonly split: 'dev' | 'heldout';
  readonly candidateId: string;
  readonly ruleId: string;
  readonly evaluatorId: SemanticEvaluatorId;
  readonly quote: string;
  readonly gold: GoldLabel;
  readonly prediction: Prediction;
  readonly modelReportedConfidence: number | null;
  readonly threshold: number;
  readonly latencyMs: number;
  readonly cacheHit: boolean;
  readonly detail: string;
}

export interface EvaluatorMetrics {
  readonly evaluatorId: string;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly trueNegatives: number;
  readonly falseNegatives: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
  readonly uncertainRate: number;
  readonly failureRate: number;
  readonly unlabelled: number;
  readonly labelled: number;
  readonly latencyMs: { p50: number; p90: number; p99: number; mean: number };
}

export interface EvaluationReport {
  readonly split: 'dev' | 'heldout' | 'all';
  readonly model: string;
  readonly promptVersion: string;
  readonly endpoint: string;
  readonly generatedAt: string;
  readonly fixtures: readonly string[];
  readonly overall: EvaluatorMetrics;
  readonly perEvaluator: readonly EvaluatorMetrics[];
  readonly cases: readonly EvaluationCase[];
}

function overlaps(a: SourceRange, b: SourceRange): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Gold label for one candidate, from the reviewer's adjudication record. */
export function goldLabelFor(
  candidate: CandidatePassage,
  annotation: Annotation | undefined,
): GoldLabel {
  if (annotation === undefined) return 'unlabelled';
  for (const change of annotation.changes) {
    if (!change.ruleIds.includes(candidate.ruleId)) continue;
    const covers =
      change.originalSpans.some((span) => overlaps(span, candidate.range)) ||
      change.expectedDiagnostics.some((e) => e.ruleId === candidate.ruleId);
    if (!covers) continue;
    if (change.status === 'accepted') return 'violation';
    if (change.status === 'disputed') return 'non-violation';
    return 'unlabelled';
  }
  return 'unlabelled';
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function metricsFor(evaluatorId: string, cases: readonly EvaluationCase[]): EvaluatorMetrics {
  const labelled = cases.filter((c) => c.gold !== 'unlabelled');
  const decided = labelled.filter(
    (c) => c.prediction === 'violation' || c.prediction === 'non-violation',
  );
  const tp = decided.filter((c) => c.gold === 'violation' && c.prediction === 'violation').length;
  const fp = decided.filter(
    (c) => c.gold === 'non-violation' && c.prediction === 'violation',
  ).length;
  const tn = decided.filter(
    (c) => c.gold === 'non-violation' && c.prediction === 'non-violation',
  ).length;
  const fn = decided.filter(
    (c) => c.gold === 'violation' && c.prediction === 'non-violation',
  ).length;

  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);

  const latencies = cases.filter((c) => !c.cacheHit).map((c) => c.latencyMs);
  return {
    evaluatorId,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    precision,
    recall,
    f1,
    uncertainRate:
      cases.length === 0
        ? 0
        : cases.filter((c) => c.prediction === 'uncertain').length / cases.length,
    failureRate:
      cases.length === 0 ? 0 : cases.filter((c) => c.prediction === 'failed').length / cases.length,
    unlabelled: cases.length - labelled.length,
    labelled: labelled.length,
    latencyMs: {
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      p99: percentile(latencies, 99),
      mean: latencies.length === 0 ? 0 : latencies.reduce((a, b) => a + b, 0) / latencies.length,
    },
  };
}

export interface EvaluateOptions {
  readonly fixturesDir: string;
  readonly split: 'dev' | 'heldout' | 'all';
  readonly config: SteAiConfigInput;
  /** Injected for tests; the CLI supplies a real llama.cpp client. */
  readonly transport: ModelTransport;
  readonly signal?: AbortSignal;
}

export async function evaluateSemanticEvaluators(
  options: EvaluateOptions,
): Promise<EvaluationReport> {
  const manifest = fixtureManifestSchema.parse(
    JSON.parse(readFileSync(join(options.fixturesDir, 'manifest.json'), 'utf8')),
  );
  const selected: FixtureEntry[] = manifest.fixtures.filter(
    (f) => options.split === 'all' || f.split === options.split,
  );
  if (selected.length === 0) {
    throw new Error(`No fixtures in split "${options.split}".`);
  }

  const config = resolveConfig(options.config);
  const pack = resolveRulePack(config.rulePack);
  const broker = new SemanticBroker(config.semantic, { transport: options.transport });

  const cases: EvaluationCase[] = [];

  for (const fixture of selected) {
    const originalPath = join(options.fixturesDir, fixture.originalPath);
    const annotationPath = join(options.fixturesDir, fixture.annotationPath);
    const text = readFileSync(originalPath, 'utf8');
    const annotation = existsSync(annotationPath)
      ? annotationSchema.parse(JSON.parse(readFileSync(annotationPath, 'utf8')))
      : undefined;

    const doc = analyseDocument(
      { id: fixture.id, format: 'markdown', text, path: originalPath },
      {
        protectedRegions: {
          approvedTerms: [...config.approvedTerms, ...pack.approvedTechnicalTerms],
          extraPatterns: config.extraProtectedPatterns,
        },
        structure: { extraImperativeVerbs: config.extraImperativeVerbs },
      },
    );
    const run = runDeterministicRules({ doc, rules: deterministicRules, config, pack });
    if (run.candidates.length === 0) continue;

    const outcomes = await broker.adjudicate(run.candidates, options.signal);
    const byId = new Map(run.candidates.map((c) => [c.id, c]));

    for (const outcome of outcomes) {
      const candidate = byId.get(outcome.candidateId);
      if (candidate === undefined) continue;
      const threshold =
        config.semantic.confidenceThresholds[candidate.evaluatorId] ??
        config.semantic.defaultConfidenceThreshold;

      let prediction: Prediction;
      let confidence: number | null = null;
      let detail: string;
      if (outcome.kind === 'failure') {
        prediction = 'failed';
        detail = `${outcome.failure.kind}: ${outcome.failure.message}`;
      } else {
        confidence = outcome.verdict.confidence;
        detail = outcome.verdict.explanation;
        if (outcome.verdict.status === 'uncertain') prediction = 'uncertain';
        else if (outcome.verdict.status === 'compliant') prediction = 'non-violation';
        else prediction = confidence >= threshold ? 'violation' : 'non-violation';
      }

      cases.push({
        fixtureId: fixture.id,
        split: fixture.split,
        candidateId: candidate.id,
        ruleId: candidate.ruleId,
        evaluatorId: candidate.evaluatorId,
        quote: text.slice(candidate.range.start, candidate.range.end),
        gold: goldLabelFor(candidate, annotation),
        prediction,
        modelReportedConfidence: confidence,
        threshold,
        latencyMs: outcome.trace.durationMs,
        cacheHit: outcome.trace.cacheHit,
        detail,
      });
    }
  }

  const evaluatorIds = [...new Set(cases.map((c) => c.evaluatorId))].sort();
  return {
    split: options.split,
    model: config.semantic.model,
    promptVersion: config.semantic.promptVersion,
    endpoint: config.semantic.endpoint,
    generatedAt: new Date().toISOString(),
    fixtures: selected.map((f) => f.id),
    overall: metricsFor('__overall__', cases),
    perEvaluator: evaluatorIds.map((id) =>
      metricsFor(
        id,
        cases.filter((c) => c.evaluatorId === id),
      ),
    ),
    cases,
  };
}

function fmt(value: number | null): string {
  return value === null ? '  n/a' : value.toFixed(3);
}

export function formatEvaluationReport(report: EvaluationReport): string {
  const lines: string[] = [];
  lines.push(
    `Semantic evaluation — split=${report.split} model=${report.model} prompts=${report.promptVersion}`,
  );
  lines.push(
    `endpoint=${report.endpoint}  fixtures=${report.fixtures.length}  cases=${report.cases.length}`,
  );
  lines.push('');
  lines.push(
    'evaluator                         TP  FP  TN  FN  precision  recall     F1  uncertain  failed  labelled  p50ms  p90ms',
  );
  const row = (m: EvaluatorMetrics): string =>
    `${m.evaluatorId.padEnd(32)} ${String(m.truePositives).padStart(3)} ${String(m.falsePositives).padStart(3)} ` +
    `${String(m.trueNegatives).padStart(3)} ${String(m.falseNegatives).padStart(3)}  ` +
    `${fmt(m.precision).padStart(9)}  ${fmt(m.recall).padStart(6)} ${fmt(m.f1).padStart(6)}  ` +
    `${m.uncertainRate.toFixed(3).padStart(9)}  ${m.failureRate.toFixed(3).padStart(6)}  ` +
    `${String(m.labelled).padStart(8)}  ${String(Math.round(m.latencyMs.p50)).padStart(5)}  ` +
    `${String(Math.round(m.latencyMs.p90)).padStart(5)}`;
  for (const m of report.perEvaluator) lines.push(row(m));
  lines.push('');
  lines.push(row(report.overall));
  lines.push('');
  lines.push(
    `Unlabelled candidates excluded from the matrix: ${report.overall.unlabelled}. ` +
      'These are passages no reviewer adjudicated; counting them would invent ground truth.',
  );
  lines.push(
    'Model-reported confidence is not a calibrated probability. Thresholds are operator-owned.',
  );
  return lines.join('\n');
}
