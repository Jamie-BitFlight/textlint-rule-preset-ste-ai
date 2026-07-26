import type {
  TextlintRuleContext,
  TextlintRuleErrorDetails,
  TextlintRuleModule,
  TextlintRuleReportHandler,
  TextlintRuleSeverityLevel,
} from '@textlint/types';
import { analyseText, type AnalysisResult } from '../analysis/analyse.js';
import type { SteAiConfigInput } from '../core/config.js';
import { contentHash } from '../core/text.js';
import type { Diagnostic } from '../core/types.js';
import { findDeterministicRule } from '../deterministic/index.js';
import { loadSharedConfig } from './shared-config.js';

/**
 * textlint adapter.
 *
 * The whole document is analysed once by the framework-neutral core and each textlint rule reports
 * the subset of diagnostics that carries its own rule id. Two consequences matter:
 *
 * - protected regions, sentence segmentation and the fix gate are applied once, identically, for
 *   every rule — a rule cannot disagree with its neighbours about what is code;
 * - offsets are absolute and are reported against the `Document` node, whose range starts at 0, so
 *   the relative padding textlint expects equals the absolute offset the core produced.
 *
 * No rule logic lives here.
 */

interface AnalysisCacheEntry {
  readonly promise: Promise<AnalysisResult>;
}

const analysisCache = new Map<string, AnalysisCacheEntry>();
const MAX_CACHE_ENTRIES = 32;

/**
 * Options a rule accepts from textlint.
 *
 * The index signature is what lets a rule receive its own arbitrary options, but it makes the type
 * incompatible with textlint's default `object` parameter — so the rule modules are typed with
 * textlint's own default and this shape is applied inside the reporter.
 */
export interface SteRuleOptions {
  readonly shared?: SteAiConfigInput;
  readonly [key: string]: unknown;
}

function cacheKey(text: string, ruleId: string, options: unknown, baseDir: string): string {
  void ruleId;
  return contentHash(text, baseDir, JSON.stringify(options ?? {}));
}

/**
 * Analyse the document once per (text, shared configuration) pair.
 *
 * Rules within one textlint run share the entry, so a 14-rule preset performs one analysis and, at
 * most, one round of semantic requests.
 */
export function getAnalysis(
  text: string,
  filePath: string | undefined,
  baseDir: string | undefined,
  shared: SteAiConfigInput | undefined,
  perRuleOptions: ReadonlyMap<string, Record<string, unknown>>,
): Promise<AnalysisResult> {
  const resolvedBaseDir = baseDir ?? process.cwd();
  const sharedFile = loadSharedConfig(baseDir);

  // Precedence for a rule's options, lowest first: shared config file, then a `shared` override in
  // textlint options, then the rule's own textlint options. Each layer is merged key by key —
  // replacing the object wholesale would silently drop an `enabled: false` set by a lower layer.
  const fileRules = sharedFile.config.rules as Record<string, Record<string, unknown>>;
  const sharedRules = (shared?.rules ?? {}) as Record<string, Record<string, unknown>>;
  const mergedRules: Record<string, Record<string, unknown>> = {};
  for (const id of new Set([
    ...Object.keys(fileRules),
    ...Object.keys(sharedRules),
    ...perRuleOptions.keys(),
  ])) {
    mergedRules[id] = {
      ...(fileRules[id] ?? {}),
      ...(sharedRules[id] ?? {}),
      ...(perRuleOptions.get(id) ?? {}),
    };
  }

  const config: SteAiConfigInput = {
    ...(sharedFile.config as unknown as SteAiConfigInput),
    ...(shared ?? {}),
    rules: mergedRules,
  };

  const key = cacheKey(text, '*', config, resolvedBaseDir);
  const existing = analysisCache.get(key);
  if (existing !== undefined) return existing.promise;

  const promise = analyseText(text, {
    ...(filePath === undefined ? {} : { path: filePath }),
    format: filePath !== undefined && /\.(txt|text)$/i.test(filePath) ? 'text' : 'markdown',
    config,
    baseDir: resolvedBaseDir,
  });
  analysisCache.set(key, { promise });
  while (analysisCache.size > MAX_CACHE_ENTRIES) {
    const oldest = analysisCache.keys().next();
    if (oldest.done === true) break;
    analysisCache.delete(oldest.value);
  }
  return promise;
}

/** Test seam: clears the per-document analysis cache. */
export function clearAnalysisCache(): void {
  analysisCache.clear();
}

/**
 * Human-readable prefix carrying the two facts a reader needs before acting on a finding: how it
 * was decided, and whether the rule behind it is normative.
 */
export function formatMessage(diagnostic: Diagnostic): string {
  const status = diagnostic.ruleStatus === 'normative' ? 'normative' : diagnostic.ruleStatus;
  return `[${diagnostic.category}][${status}] ${diagnostic.message}`;
}

/**
 * Map a core severity onto textlint's severity level.
 *
 * textlint takes a rule's severity from `.textlintrc` and applies it to every error the rule
 * reports, which made the per-category `diagnostics.severity` policy inert: an `info`-level
 * readability observation and an `error`-level violation both surfaced as errors. Reporting the
 * undocumented object form instead of a `RuleError` instance is the only way the kernel accepts a
 * per-diagnostic level (see `TextlintRuleContextImpl.report`), so that is what the adapter does.
 *
 * `none` (0) is deliberately unreachable: suppressing a finding is the core's decision, expressed
 * by not producing the diagnostic at all, and the kernel treats a falsy severity as `error` anyway.
 */
export function toTextlintSeverity(severity: Diagnostic['severity']): TextlintRuleSeverityLevel {
  switch (severity) {
    case 'info':
      return 3;
    case 'warning':
      return 1;
    default:
      return 2;
  }
}

/**
 * Build the textlint rule module for one core rule id.
 *
 * The same reporter is used for `linter` and `fixer`: a fix is attached whenever the core decided
 * one survives the autofix gate, and textlint only applies fixes in `--fix` mode.
 */
export function createSteTextlintRule(ruleId: string): TextlintRuleModule {
  const coreRule = findDeterministicRule(ruleId);
  if (coreRule === undefined) {
    throw new Error(`No core rule with id "${ruleId}".`);
  }

  const reporter = (
    context: Readonly<TextlintRuleContext>,
    rawOptions?: object,
  ): TextlintRuleReportHandler => {
    const { Syntax, report, fixer, locator, getSource } = context;
    const { shared, ...ownOptions } = (rawOptions ?? {}) as SteRuleOptions;

    return {
      [Syntax.Document]: async (node) => {
        const text = getSource(node);
        const nodeStart = node.range[0];
        const analysis = await getAnalysis(
          text,
          context.getFilePath(),
          context.getConfigBaseDir(),
          shared,
          new Map([[ruleId, ownOptions]]),
        );

        for (const diagnostic of analysis.diagnostics) {
          if (diagnostic.ruleId !== ruleId) continue;
          const start = diagnostic.range.start - nodeStart;
          const end = diagnostic.range.end - nodeStart;
          if (start < 0 || end <= start) continue;

          const details: TextlintRuleErrorDetails = {
            padding: locator.range([start, end]),
          };
          if (diagnostic.fix !== undefined) {
            details.fix = fixer.replaceTextRange(
              [diagnostic.fix.range.start - nodeStart, diagnostic.fix.range.end - nodeStart],
              diagnostic.fix.text,
            );
          }
          if (diagnostic.suggestions !== undefined && diagnostic.suggestions.length > 0) {
            // Suggestions are advisory: an editor may offer them, but `textlint --fix` applies
            // only `details.fix`, which the autofix gate has already approved.
            details.suggestions = diagnostic.suggestions.slice(0, 3).map((replacement, index) => ({
              id: `${ruleId}-${start}-${index}`,
              message: `Replace with "${replacement}"`,
              fix: fixer.replaceTextRange([start, end], replacement),
            }));
          }
          report(node, {
            ...details,
            message: formatMessage(diagnostic),
            severity: toTextlintSeverity(diagnostic.severity),
          });
        }

        // Run-level notices are surfaced once, by the first rule in the preset, anchored at the
        // start of the document. Without this a service outage would leave no trace in the report.
        if (ruleId === FIRST_RULE_ID) {
          for (const notice of analysis.notices) {
            if (notice.level === 'info') continue;
            report(node, {
              message: `[infrastructure-failure][${notice.code}] ${notice.message}`,
              padding: locator.range([0, Math.min(1, Math.max(0, text.length))]),
              severity: toTextlintSeverity(notice.level),
            });
          }
        }
      },
    };
  };

  return { linter: reporter, fixer: reporter };
}

/**
 * The rule that reports run-level notices. Fixed so the notice appears exactly once per run
 * regardless of which rules the user enabled — if this rule is disabled, notices are still
 * available through the programmatic API.
 */
export const FIRST_RULE_ID = 'sentence-length-procedural';
