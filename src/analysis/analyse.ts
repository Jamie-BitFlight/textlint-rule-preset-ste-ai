import { resolveConfig, type SteAiConfig, type SteAiConfigInput } from '../core/config.js';
import { analyseDocument, STRUCTURAL_MARKER_KINDS } from '../core/document.js';
import {
  defaultProtectedRegionOptions,
  extractProtectedRegions,
  type ProtectedPatternRejection,
  type ProtectedRegionOptions,
  screenExtraPatterns,
} from '../core/protected-regions.js';
import { runDeterministicRules } from '../core/runner.js';
import { defaultStructureOptions, detectMode, type StructureOptions } from '../core/structure.js';
import {
  applySuppressions,
  DIRECTIVE_TEXT_REASON,
  directiveFor,
  refuseInAdmonition,
  scanSuppressions,
} from '../core/suppressions.js';
import { maskRanges, mergeRanges, normalizeLineEndings } from '../core/text.js';
import type {
  AnalysedDocument,
  BlockKind,
  CandidatePassage,
  Diagnostic,
  DocumentFormat,
  RulePack,
  RunNotice,
  SemanticTrace,
  SourceDocument,
  SourceRange,
  SuppressionDirective,
  SuppressionRecord,
  TextBlock,
} from '../core/types.js';
import { deterministicRules } from '../deterministic/index.js';
import { LlamaCppClient } from '../model-client/llama-client.js';
import type { ModelTransport } from '../model-client/types.js';
import { readMarkdownUnitsSync } from '../reader/markdown-reader.js';
import { readPlainTextUnitsSync } from '../reader/plain-text-reader.js';
import type { TextUnit } from '../reader/types.js';
import { provisionalRulePack, resolveRulePack, verifiedAuthority } from '../rule-pack/loader.js';
import {
  analyseSemantically,
  semanticNotRunNoticeMessage,
  undecidedCandidateReasonMessage,
} from '../semantic/analyse.js';
import { SemanticBroker, type SemanticBrokerDeps } from '../semantic/broker.js';
import { resolveOverlappingFixes } from '../core/runner.js';

/**
 * The programmatic entry point.
 *
 * This module composes the pieces — rule pack, document analysis, deterministic rules, optional
 * semantic adjudication — and contains no rule logic of its own. It is what both the textlint
 * adapter and the CLI call.
 */

/**
 * Blocks derived from a real reader (`src/reader/`), for the two production entry points below.
 *
 * `core` may not import `reader` (module boundary — `docs/architecture.md`, "Document reader", §3),
 * so `analyseDocument()` cannot select a reader itself; it only accepts blocks from anywhere via its
 * `blocks` option. This is the one place that both knows a reader exists and is allowed to import
 * one. The eight other direct callers of `analyseDocument` outside this module (`fixture-tools`,
 * `evaluation`, six unit-test files) do not go through this function and are unaffected —
 * `scanBlocks()` still runs for them, exactly as before this stage.
 *
 * `structureOptions` is threaded through to {@link unitToBlock} so a configured
 * `extraImperativeVerbs` actually reaches mode classification. Every reader classifies its own
 * units with `defaultStructureOptions` (an empty extra-verb list) because a reader has no notion of
 * this package's config; supplying `blocks` here means `analyseDocument`'s own `scanBlocks()` —
 * the only other place that option was ever read — never runs either. Without this, a configured
 * extra imperative verb would be silently inert on both production entry points.
 */
function readerBlocksFor(
  sourceDoc: SourceDocument,
  structureOptions: StructureOptions,
  protectedRegionOptions: Partial<ProtectedRegionOptions>,
): readonly TextBlock[] {
  const units: readonly TextUnit[] =
    sourceDoc.format === 'markdown'
      ? readMarkdownUnitsSync(sourceDoc)
      : readPlainTextUnitsSync(sourceDoc);

  // Same extraction `analyseDocument` runs for its own `fullMask`, computed here too because a
  // unit's mode is decided before `analyseDocument` ever sees it (see `unitToBlock`). Only
  // opaque, non-structural-marker regions are kept — the structural markers (list/heading/
  // blockquote markers, table pipes, emphasis) stay visible, matching what `scanBlocks` does with
  // `buildStructuralMask` for the exact same purpose on the non-reader path.
  const detectionText = normalizeLineEndings(sourceDoc.text);
  const regions = extractProtectedRegions(detectionText, {
    ...defaultProtectedRegionOptions,
    format: sourceDoc.format,
    ...protectedRegionOptions,
  });
  const opaqueContentRanges = mergeRanges(
    regions.filter((r) => r.opaque && !STRUCTURAL_MARKER_KINDS.has(r.kind)).map((r) => r.range),
  );

  return units.map((unit) => unitToBlock(unit, structureOptions, opaqueContentRanges));
}

/**
 * The real {@link StructureOptions} for this run, built once and shared by the `analyseDocument`
 * call (for its own, now-unused-when-`blocks`-is-supplied `structure` option, kept for parity with
 * every other caller of `analyseDocument`) and by {@link readerBlocksFor}'s mode recomputation,
 * which is what actually consults it on the reader path.
 */
function structureOptionsFor(format: DocumentFormat, config: SteAiConfig): StructureOptions {
  return { ...defaultStructureOptions, format, extraImperativeVerbs: config.extraImperativeVerbs };
}

/**
 * `TextUnit.kind` the readers actually produce, mapped to `BlockKind`. The one naming mismatch is
 * `'blockquote'` versus `BlockKind`'s `'block-quote'`; everything else is identical. `TextUnit.kind`
 * is `string`, not a union — reader-owned, deliberately open for a future reader's own vocabulary —
 * so this is an explicit, checked mapping rather than a blind cast: an unrecognised kind is a real
 * mismatch between a reader and this bridge, and must fail loudly, not silently coerce.
 */
const UNIT_KIND_TO_BLOCK_KIND: Readonly<Record<string, BlockKind>> = {
  paragraph: 'paragraph',
  heading: 'heading',
  'list-item': 'list-item',
  'table-cell': 'table-cell',
  blockquote: 'block-quote',
};

/**
 * `TextUnit` was deliberately designed close to `TextBlock`, not as a rewrite of it — see
 * `src/reader/types.ts`. This is a direct field-for-field carry-over once `kind` is translated,
 * except `mode`, which is recomputed here rather than carried over from `unit.mode`.
 *
 * The reader classified `unit.mode` itself, against `defaultStructureOptions` — it has no access to
 * this package's config, extra imperative verbs included. Recomputing with the real
 * `structureOptions`, using the exact same `detectMode` that `scanBlocks()` calls, is what makes a
 * configured extra imperative verb take effect on the reader path, matching what `scanBlocks()`
 * would have decided for the same text. Headings are the one exception `scanBlocks()` carves out —
 * `detectMode` never runs on a heading's own text at all — and the reader already forces
 * `'descriptive'` for headings for the same reason, so `unit.mode` is left untouched there.
 *
 * `detectMode` runs on {@link maskUnitContent}'s output, not on `unit.masked` directly: `unit.masked`
 * only masks the reader's own blockquote continuation markers, so an opening code span, URL, or
 * other protected region was still visible verbatim at this point — `analyseDocument`'s real
 * protected-region mask does not exist yet here, it is built later and only feeds `sentence.masked`,
 * never fed back to reclassify the block mode it was copied from. A block whose only "imperative
 * opener" is a word sitting inside protected markup — `` `Install the driver` is the section
 * title.`` — was misclassified `procedural` as a result. Layering `opaqueContentRanges` on top of
 * `unit.masked` fixes this without disturbing the blockquote-marker masking.
 */
function unitToBlock(
  unit: TextUnit,
  structureOptions: StructureOptions,
  opaqueContentRanges: readonly SourceRange[],
): TextBlock {
  const kind = UNIT_KIND_TO_BLOCK_KIND[unit.kind];
  if (kind === undefined) {
    throw new Error(`No BlockKind mapping for reader unit kind "${unit.kind}" (unit ${unit.id}).`);
  }
  const mode =
    kind === 'heading'
      ? unit.mode
      : detectMode(maskUnitContent(unit, opaqueContentRanges), structureOptions);
  return {
    id: unit.id,
    kind,
    range: unit.range,
    text: unit.text,
    mode,
    admonition: unit.admonition,
    depth: unit.depth,
    inList: unit.kind === 'list-item',
    ...(unit.listOrdinal === undefined ? {} : { listOrdinal: unit.listOrdinal }),
  };
}

/**
 * Layer document-level protected-content ranges onto a unit's own `masked` text.
 *
 * `opaqueContentRanges` are absolute offsets into the source document; `unit.masked` is indexed
 * from 0 at `unit.range.start`. `maskRanges` is idempotent on characters `unit.masked` already
 * masked, so this only ever adds masking, never removes the reader's own blockquote-marker mask.
 */
function maskUnitContent(unit: TextUnit, opaqueContentRanges: readonly SourceRange[]): string {
  const local = opaqueContentRanges
    .map((r) => ({ start: r.start - unit.range.start, end: r.end - unit.range.start }))
    .filter((r) => r.end > 0 && r.start < unit.masked.length)
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(unit.masked.length, r.end) }));
  return maskRanges(unit.masked, local);
}

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

/**
 * Shared setup for both production entry points below: resolve config and rule pack, build the
 * source document, run structural analysis over the reader's blocks, run the deterministic rules,
 * and filter candidates through any inline suppression directives.
 *
 * {@link analyseTextDeterministic} and {@link analyseText} differ only in what they do with the
 * result — the deterministic path turns leftover candidates into `review-required` diagnostics
 * itself, while the full path hands them to semantic adjudication — so everything up to and
 * including `suppressCandidates` is identical between them and lives here once.
 */
function prepareRun(
  text: string,
  options: AnalyseTextOptions,
): {
  readonly config: SteAiConfig;
  readonly pack: RulePack;
  readonly document: AnalysedDocument;
  readonly run: ReturnType<typeof runDeterministicRules>;
  readonly pass: CandidateSuppressionPass;
  /** One per refused `extraProtectedPatterns` entry. Empty for a configuration with none. */
  readonly patternNotices: readonly RunNotice[];
} {
  const config = resolveConfig(options.config ?? {});
  const pack = resolveRulePack(config.rulePack, options.baseDir ?? process.cwd());
  const format = options.format ?? 'markdown';

  const sourceDoc: SourceDocument = {
    id: options.id ?? options.path ?? 'document',
    format,
    text,
    ...(options.path === undefined ? {} : { path: options.path }),
  };
  const structureOptions = structureOptionsFor(format, config);
  // Screened once, here, because this is the outermost place a refusal can still be *reported*:
  // `Pass.find` returns ranges only. Only the accepted sources are threaded onwards, so the two
  // extractions below (this call's document and `readerBlocksFor`'s mode recomputation) agree on
  // exactly which patterns ran.
  const screenedPatterns = screenExtraPatterns(config.extraProtectedPatterns);
  const protectedRegionOptions: Partial<ProtectedRegionOptions> = {
    approvedTerms: [...config.approvedTerms, ...pack.approvedTechnicalTerms],
    extraPatterns: screenedPatterns.accepted,
  };
  const document = analyseDocument(sourceDoc, {
    protectedRegions: protectedRegionOptions,
    structure: structureOptions,
    blocks: readerBlocksFor(sourceDoc, structureOptions, protectedRegionOptions),
  });

  // Fix conflicts are resolved by each caller instead, once the suppressed findings are out of the
  // list: a finding nobody will be shown must not be able to veto another finding's fix.
  const run = runDeterministicRules({
    doc: document,
    rules: deterministicRules,
    config,
    pack,
    packIsBundledDefault: pack === provisionalRulePack,
    resolveFixes: false,
  });

  const pass = suppressCandidates(document, run.candidates, config);

  return {
    config,
    pack,
    document,
    run,
    pass,
    patternNotices: screenedPatterns.rejected.map(protectedPatternNotice),
  };
}

/**
 * Report a refused `extraProtectedPatterns` entry.
 *
 * `error`, not `warning`: the field is how an operator declares that a project literal is not
 * prose, and a refused entry silently withdraws two guarantees at once — the literals it named are
 * matched as ordinary words by every vocabulary rule, and they are no longer masked out of the
 * passages sent to the semantic service (`test/integration/redaction.test.ts` asserts that
 * everything transmitted is built from masked text). One code covers both defects, with the
 * specific ground in `detail.reason`, so a consumer can distinguish a typo from a refused shape
 * without parsing the message.
 */
function protectedPatternNotice(rejection: ProtectedPatternRejection): RunNotice {
  return {
    code: 'invalid-protected-pattern',
    level: 'error',
    message:
      `extraProtectedPatterns entry ${JSON.stringify(rejection.source)} was rejected because ` +
      `${rejection.explanation}. It protected nothing: text it would have matched is analysed as ` +
      'ordinary prose and is not withheld from the semantic service.',
    detail: { pattern: rejection.source, reason: rejection.reason },
  };
}

/** Deterministic-only analysis. Never performs I/O beyond reading the rule pack. */
export function analyseTextDeterministic(
  text: string,
  options: AnalyseTextOptions = {},
): AnalysisResult {
  const { config, pack, document, run, pass, patternNotices } = prepareRun(text, options);

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
    diagnostics: resolved.diagnostics.toSorted(
      (a, b) =>
        a.range.start - b.range.start ||
        a.range.end - b.range.end ||
        a.ruleId.localeCompare(b.ruleId),
    ),
    notices: [
      ...patternNotices,
      ...run.notices,
      ...undecided.notices,
      ...suppressed.notices,
      ...resolved.notices,
    ],
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
   * Ids of candidates refused inside a safety admonition, already reported here.
   *
   * A refused candidate proceeds to adjudication and produces a diagnostic that `applySuppressions`
   * must recognise as the very same decision, so it does not report the refusal a second time.
   * Identity is the candidate's own id, not its range: `resolveEvidenceRange`
   * (`src/semantic/analyse.ts`) can legitimately remap a semantic diagnostic's range to the model's
   * evidence span, which is not necessarily identical to `candidate.range` — matching on the range
   * would then miss the very diagnostic this list exists to recognise.
   */
  readonly refused: readonly string[];
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
  const refused: string[] = [];

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
      refused.push(candidate.id);
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

  const suppressions = pass.records
    .concat(applied.suppressions)
    .toSorted((a, b) => a.range.start - b.range.start || a.ruleId.localeCompare(b.ruleId));

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
        message: undecidedCandidateReasonMessage(candidate.reason),
        range: candidate.range,
        producedBy: 'deterministic' as const,
        candidateId: candidate.id,
        meta: { evaluatorId: candidate.evaluatorId },
      }))
    : [];

  return {
    diagnostics,
    notices: [
      {
        code: 'semantic-disabled',
        level: 'info',
        message: semanticNotRunNoticeMessage(candidates.length),
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
  const { config, pack, document, run, pass, patternNotices } = prepareRun(text, options);

  // Overlap resolution is deferred to the merged, post-suppression list below. It has to see the
  // semantic fixes anyway, and a withheld finding must not veto a surviving finding's fix.
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
  const diagnostics = merged.diagnostics.toSorted(
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
    notices: [
      ...patternNotices,
      ...run.notices,
      ...semantic.notices,
      ...suppressed.notices,
      ...merged.notices,
    ],
    traces: semantic.traces,
    pack,
    config,
  };
}
