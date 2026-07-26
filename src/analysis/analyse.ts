import { resolveConfig, type SteAiConfig, type SteAiConfigInput } from '../core/config.js';
import { analyseDocument } from '../core/document.js';
import { runDeterministicRules } from '../core/runner.js';
import type {
  AnalysedDocument,
  Diagnostic,
  DocumentFormat,
  RulePack,
  RunNotice,
  SemanticTrace,
} from '../core/types.js';
import { deterministicRules } from '../deterministic/index.js';
import { LlamaCppClient } from '../model-client/llama-client.js';
import type { ModelTransport } from '../model-client/types.js';
import { resolveRulePack } from '../rule-pack/loader.js';
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

  const run = runDeterministicRules({ doc: document, rules: deterministicRules, config, pack });
  return {
    document,
    diagnostics: run.diagnostics,
    notices: run.notices,
    traces: [],
    pack,
    config,
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

  const run = runDeterministicRules({ doc: document, rules: deterministicRules, config, pack });

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
    candidates: run.candidates,
    broker,
    config: config.semantic,
    policy: config.diagnostics,
    autofix: config.autofix,
    ruleStatus: pack.metadata.authority,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  // Overlap resolution must see deterministic and semantic fixes together.
  const merged = resolveOverlappingFixes(
    [...run.diagnostics, ...semantic.diagnostics],
    config.diagnostics,
  );

  merged.diagnostics.sort(
    (a, b) =>
      a.range.start - b.range.start ||
      a.range.end - b.range.end ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.category.localeCompare(b.category),
  );

  return {
    document,
    diagnostics: merged.diagnostics,
    notices: [...run.notices, ...semantic.notices, ...merged.notices],
    traces: semantic.traces,
    pack,
    config,
  };
}
