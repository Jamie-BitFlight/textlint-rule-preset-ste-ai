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
 * Which run-level notices have already been reported for a given Document AST node this run,
 * identified by `code` + `message`.
 *
 * Keyed by object identity on the outer map, not content: a fresh AST node is a fresh key, so this
 * needs no manual reset between lint runs the way {@link analysisCache} does (see
 * {@link clearAnalysisCache}) — an old node simply becomes unreachable and is collected once its
 * run ends.
 *
 * Deduplicates rather than gating on "has any rule reported yet" (an earlier version's design,
 * found broken in external review): `getAnalysis` computes a config scoped to whichever rule is
 * calling it — its own `perRuleOptions` entry merges in, every other rule's does not — so two
 * rules enabled in the same run can genuinely compute *different* `AnalysisResult`s, each with its
 * own distinct notices (e.g. a `rule-options-invalid` specific to the second rule's own bad
 * options, absent from the first rule's differently-scoped analysis). Gating on "the first rule to
 * arrive claims it" silently dropped every notice specific to a rule that was not first. Identity
 * by content, rather than object identity on the notice itself, is what lets the *same* notice
 * computed redundantly by several rules (e.g. one that depends only on `shared`, not on any rule's
 * own options) still collapse to one report, while distinct notices all surface.
 */
const reportedRunNoticesFor = new WeakMap<object, Set<string>>();

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
 * Whether `value` is a plain object — not `null`, not an array, not some other JS object subtype.
 *
 * This is the only structural fact the reporter below can honestly assert about `rawOptions` (the
 * end user's own `.textlintrc.json` rule config) and its nested `shared` field before
 * `getAnalysis`'s own config resolution (`resolveConfig`/`steAiConfigSchema`, `src/core/config.ts`)
 * does the real, deep validation downstream. That validation is deliberately not duplicated here:
 * `steAiConfigSchema`'s fields carry defaults (`.default()`/`.prefault()`), so parsing `shared`
 * through it this early — before the merge with `sharedFile.config` inside `getAnalysis` — would
 * silently invent a default for every field the user's inline `shared` option left unmentioned,
 * overriding whatever `sharedFile.config` (the `.ste-ai.json` shared-config file) actually set for
 * that field (verified directly: a minimal repro of the same `.prefault({})`-wrapped-sub-schema
 * shape shows a field the shared-config file sets non-default gets silently reset to the schema's
 * own default the moment `shared` omits it and is parsed before the merge). Deferring full
 * validation to the merged result, as this code already did before this fix, is what keeps a
 * malformed `shared` failing once, in one place, with one error shape — the same one a malformed
 * `.ste-ai.json` file produces — rather than earlier and differently here.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `raw` (typically `shared['rules']`), kept as a per-rule-id map of per-rule option bags — the
 * shallow shape `sharedFile.config.rules`/`shared.rules`/`perRuleOptions` all share — with any
 * entry whose *value* is not itself a plain object dropped, entry by entry, rather than the whole
 * map being replaced with `{}` because one entry is malformed.
 *
 * PROVENANCE (`chatgpt-codex-connector`, P2, `discussion_r3707793537`): an earlier version of this
 * function validated the whole map at once (`isPlainObject(value) &&
 * Object.values(value).every(isPlainObject)`, returning `{}` on any failure) — so
 * `{ 'no-contractions': { enabled: false }, 'misspelled-rule': false }` discarded the valid
 * `no-contractions` entry along with the malformed one, silently re-enabling a rule the user had
 * explicitly disabled, while also hiding which entry was actually malformed. Filtering per entry
 * instead keeps every valid sibling; a malformed individual entry contributes nothing further down
 * (spreading a non-object into `mergedRules[id]` is already a no-op, not a crash — see the merge
 * loop below), the same silent-drop behaviour this function's very first version (before either
 * fix, an unchecked cast) already had for a malformed entry, just without also destroying the
 * entries around it. What each rule's own options actually mean is still validated later, per
 * rule, by that rule's own `optionsSchema` in `src/core/runner.ts` — this only rules out shapes
 * that could not possibly merge sensibly.
 */
function validRulesOf(raw: unknown): Record<string, Record<string, unknown>> {
  if (!isPlainObject(raw)) return {};
  const result: Record<string, Record<string, unknown>> = {};
  for (const [id, options] of Object.entries(raw)) {
    if (isPlainObject(options)) result[id] = options;
  }
  return result;
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
  /**
   * PROVENANCE (`chatgpt-codex-connector`, P2, `discussion_r3707847136`): typed `Record<string,
   * unknown>` for one revision, to make the runtime-unvalidated status below honest at the type
   * level too — but `getAnalysis` is re-exported through the public `./textlint` entry point, and
   * `Record<string, unknown>` requires an index signature that an ordinary external caller's own
   * config interface (e.g. `interface Shared { approvedTerms: string[] }`, structurally compatible
   * with `SteAiConfigInput` since every one of its fields is optional) does not have, rejecting
   * valid callers. Restored to `SteAiConfigInput | undefined`, the public contract — the *value* is
   * still just as unvalidated as before this note: this function's own merge below
   * (`{ ...sharedFile.config, ...shared, rules: mergedRules }`) is what has to run before
   * `resolveConfig`/`steAiConfigSchema` can validate the result, so `shared` cannot honestly be
   * *parsed* through that schema this early — see `isPlainObject`'s doc comment in this file for why
   * doing so would be actively wrong, not just redundant. The type says "shaped like a config"; nothing
   * here proves that shape is real, which is exactly why {@link validRulesOf} still validates
   * `shared.rules` at runtime rather than trusting this static type.
   */
  shared: SteAiConfigInput | undefined,
  perRuleOptions: ReadonlyMap<string, Record<string, unknown>>,
): Promise<AnalysisResult> {
  const resolvedBaseDir = baseDir ?? process.cwd();
  const sharedFile = loadSharedConfig(baseDir);

  // Precedence for a rule's options, lowest first: shared config file, then a `shared` override in
  // textlint options, then the rule's own textlint options. Each layer is merged key by key —
  // replacing the object wholesale would silently drop an `enabled: false` set by a lower layer.
  const fileRules = sharedFile.config.rules as Record<string, Record<string, unknown>>;
  const sharedRules = validRulesOf(shared?.rules);
  const mergedRules: Record<string, Record<string, unknown>> = {};
  for (const id of new Set([
    ...Object.keys(fileRules),
    ...Object.keys(sharedRules),
    ...perRuleOptions.keys(),
  ])) {
    mergedRules[id] = {
      ...fileRules[id],
      ...sharedRules[id],
      ...perRuleOptions.get(id),
    };
  }

  const config: SteAiConfigInput = {
    // `sharedFile.config` is already a validated `SteAiConfig` (every field present, via
    // `resolveConfig` in `shared-config.ts`) — a strict subtype of the more-optional
    // `SteAiConfigInput`, so no assertion is needed to spread it here.
    ...sharedFile.config,
    ...shared,
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
    // `rawOptions` is the end user's own `.textlintrc.json` rule config, typed by textlint itself
    // only as a bare `object` — genuinely unknown until read, and `isPlainObject` (this file) is
    // exactly as much as either `rawOptions` or its nested `shared` field can be honestly narrowed
    // before `getAnalysis`'s own config resolution does the real, deep validation downstream.
    const { shared, ...ownOptions } = isPlainObject(rawOptions) ? rawOptions : {};
    // `shared` is confirmed a plain object above, never blindly trusted from `rawOptions` — but
    // nothing short of `resolveConfig`/`steAiConfigSchema` downstream (see `getAnalysis`'s own doc
    // comment) can confirm it actually has `SteAiConfigInput`'s shape, which is unprovable for
    // arbitrary end-user `.textlintrc.json` content. `getAnalysis`'s parameter is `SteAiConfigInput`
    // to preserve its public contract for external callers (see its own doc comment), so this one
    // narrow assertion — of an already-real-object value, not the untouched `rawOptions` blob — is
    // what bridges the two, same as the pre-existing gap `getAnalysis`'s own body already accounts
    // for by never parsing `shared` through the schema this early.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const sharedConfig = isPlainObject(shared) ? (shared as SteAiConfigInput) : undefined;

    return {
      [Syntax.Document]: async (node) => {
        const text = getSource(node);
        const nodeStart = node.range[0];
        const analysis = await getAnalysis(
          text,
          context.getFilePath(),
          context.getConfigBaseDir(),
          sharedConfig,
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

        // Run-level notices are surfaced once per run, by whichever enabled rule's Document
        // handler reaches this line first, anchored at the start of the document. Without this a
        // service outage — or an invalid `extraProtectedPatterns` entry, or an unrecognised rule
        // id — would leave no trace in the report.
        //
        // This used to be gated on `ruleId === FIRST_RULE_ID`, a single hardcoded rule id. That
        // silently dropped every run notice whenever the user's own `.textlintrc.json` did not
        // enable that specific rule — precisely the silent-drop this mechanism exists to prevent,
        // just one level up. A later fix replaced it with "whichever rule's handler arrives first
        // reports, every other rule this run stays silent" — also wrong, per the class comment on
        // `reportedRunNoticesFor` above: different rules can compute genuinely different notices
        // for the same document, so "first one wins" silently dropped every notice specific to a
        // rule that was not first. Dedupe by content instead: `node` is confirmed the same object
        // across every rule's `Document` handler within one `lintText()` call (textlint parses the
        // AST once and shares it), and a fresh object every subsequent call, so this reports each
        // distinct notice exactly once per run regardless of which rule computed it, with no
        // explicit reset between runs to forget.
        let reportedForNode = reportedRunNoticesFor.get(node);
        for (const notice of analysis.notices) {
          if (notice.level === 'info') continue;
          const identity = `${notice.code} ${notice.message}`;
          if (reportedForNode?.has(identity) === true) continue;
          if (reportedForNode === undefined) {
            reportedForNode = new Set();
            reportedRunNoticesFor.set(node, reportedForNode);
          }
          reportedForNode.add(identity);
          report(node, {
            message: `[infrastructure-failure][${notice.code}] ${notice.message}`,
            padding: locator.range([0, Math.min(1, Math.max(0, text.length))]),
            severity: toTextlintSeverity(notice.level),
          });
        }
      },
    };
  };

  return { linter: reporter, fixer: reporter };
}
