import type { SteAiConfig } from './config.js';
import { gateFix, type DeterministicRule, type RuleInput } from './rule.js';
import { rangesOverlap } from './text.js';
import type {
  AnalysedDocument,
  CandidatePassage,
  Diagnostic,
  RulePack,
  RunNotice,
  Severity,
  TextBlock,
} from './types.js';

export interface DeterministicRunResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly candidates: readonly CandidatePassage[];
  readonly notices: readonly RunNotice[];
}

export interface RunOptions {
  readonly doc: AnalysedDocument;
  readonly rules: readonly DeterministicRule[];
  readonly config: SteAiConfig;
  readonly pack: RulePack;
  /**
   * True when `pack` is the literal bundled-default singleton `provisionalRulePack`, not merely a
   * pack whose content happens to match it. `core` cannot import `rule-pack` to check this itself
   * (`test/architecture/module-boundaries.test.ts` forbids it), so the caller — which already holds
   * the reference `resolveRulePack` returned — passes the answer in. String-comparing a pack
   * entry's `sourceRef` against `rule.meta.sourceRef` was tried and found insufficient (Codex review
   * on PR #116): an untrusted pack can copy that citation string verbatim while supplying entirely
   * different rule-governing data (a fabricated dictionary entry, a loosened limit), so the
   * diagnostic still carries a citation that names a section describing different data than the one
   * that actually fired. Only genuine identity with the bundled singleton — which no supplied pack
   * can ever produce, since `resolveRulePack` always returns a freshly parsed object for anything
   * other than "no `rulePack` configured" — proves the cited data is what the citation claims it is.
   */
  readonly packIsBundledDefault: boolean;
  /** Restrict the run to a single rule id. Used by the per-rule textlint adapters. */
  readonly onlyRuleId?: string;
  /**
   * Resolve overlapping fixes before returning. Default true.
   *
   * The analysis layer sets it false and resolves after inline suppression has run instead. A
   * withheld diagnostic must not count as a party to a fix conflict: resolving first left the
   * survivor of a suppressed pair permanently unfixable, and emitted an `overlapping-fixes-refused`
   * notice describing a disagreement with a diagnostic that is not in the output.
   */
  readonly resolveFixes?: boolean;
}

/**
 * Run the deterministic rule set over one document.
 *
 * Ordering is deterministic: rules run in registry order and diagnostics are finally sorted by
 * (start, end, ruleId). Two runs over the same input therefore produce byte-identical output.
 */
export function runDeterministicRules(options: RunOptions): DeterministicRunResult {
  const { doc, rules, config, pack } = options;
  const diagnostics: Diagnostic[] = [];
  const candidates: CandidatePassage[] = [];
  const notices: RunNotice[] = [];

  const blockById = new Map<string, TextBlock>(doc.blocks.map((b) => [b.id, b]));
  const packSpecs = new Map(pack.rules.map((r) => [r.ruleId, r]));

  notices.push(...unknownRuleIdNotices(config, rules));

  for (const rule of rules) {
    const id = rule.meta.id;
    if (options.onlyRuleId !== undefined && options.onlyRuleId !== id) continue;

    const packSpec = packSpecs.get(id);
    const userConfig = config.rules[id] ?? {};
    const enabled = userConfig.enabled ?? packSpec?.enabled ?? true;
    if (!enabled) continue;

    const rawOptions = {
      ...packSpec?.options,
      ...stripControlKeys(userConfig),
    };
    const parsed = rule.optionsSchema.safeParse(rawOptions);
    if (!parsed.success) {
      notices.push({
        code: 'rule-options-invalid',
        level: 'error',
        message: `Options for rule "${id}" are invalid and the rule was skipped: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
        detail: { ruleId: id },
      });
      continue;
    }

    const severityOverride: Severity | undefined = userConfig.severity ?? packSpec?.severity;

    const input: RuleInput = {
      doc,
      options: parsed.data,
      pack,
      policy: config.diagnostics,
      autofix: config.autofix,
      blockById,
      extraImperativeVerbs: config.extraImperativeVerbs,
    };

    const output = rule.run(input);

    // A pack may raise a rule's authority and supply its own citation. Without this the pack's
    // `status`/`sourceRef` were parsed, validated and then ignored, so an authorised pack changed
    // nothing a reader could see. `verifiedAuthority` still caps an untrusted pack.
    const packStatus =
      packSpec === undefined
        ? undefined
        : verifiedRuleStatus(packSpec.status, pack, config.trustedRulePackIds);

    // Whether the *pack itself* is trusted, independent of what any one rule entry declares.
    // `sourceRef` trust cannot be inferred from whether `packStatus` was downgraded (#66's original
    // gap): an untrusted pack that declares `status: "supplementary"` directly, rather than
    // `"normative"`, is never downgraded — `verifiedRuleStatus` only ever touches a `"normative"`
    // declaration — so gating on the downgrade let that pack's citation straight through.
    const packTrusted = config.trustedRulePackIds.includes(pack.metadata.id);

    for (const diagnostic of output.diagnostics) {
      const processed = postProcess(diagnostic, rule, doc, config, blockById, severityOverride);
      if (processed === null) continue;
      diagnostics.push(
        packSpec === undefined || packStatus === undefined
          ? processed
          : {
              ...processed,
              ruleStatus: packStatus,
              meta: {
                ...processed.meta,
                // String-comparing `sourceRef` against `rule.meta.sourceRef` was tried and found
                // insufficient (Codex review on PR #116): an untrusted pack can copy that citation
                // string verbatim while supplying entirely different rule-governing data — a
                // fabricated dictionary entry, a loosened limit — so the diagnostic still carried a
                // citation naming a section that describes different data than what actually fired.
                // Matching a string proves the string matches; it proves nothing about the data
                // behind it. Only `options.packIsBundledDefault` — genuine identity with the bundled
                // singleton, which no supplied pack can ever produce — proves the cited data is what
                // the citation claims it is.
                sourceRef:
                  options.packIsBundledDefault || packTrusted
                    ? packSpec.sourceRef
                    : `unverified citation from untrusted rule pack "${displaySafePackId(pack.metadata.id)}"`,
              },
            },
      );
    }
    candidates.push(...output.candidates);
  }

  const { diagnostics: resolved, notices: fixNotices } =
    (options.resolveFixes ?? true)
      ? resolveOverlappingFixes(diagnostics)
      : { diagnostics, notices: [] };
  notices.push(...fixNotices);

  resolved.sort(
    (a, b) =>
      a.range.start - b.range.start ||
      a.range.end - b.range.end ||
      a.ruleId.localeCompare(b.ruleId),
  );

  return { diagnostics: resolved, candidates: sortCandidates(candidates), notices };
}

/**
 * Report `rules` keys that name no registered rule.
 *
 * `ruleUserConfigSchema` carries a deliberate catch-all so a rule can receive options only its own
 * `optionsSchema` can validate (see `src/core/config.ts`), which means the config schema cannot
 * reject a mistyped rule id — the whole entry is well-formed, it just configures nothing. The id is
 * checkable here, where the rule list is known.
 *
 * A notice rather than a thrown error, deliberately: a config naming a rule from a newer version of
 * this package degrades — the run completes, every other rule applies — instead of failing outright.
 */
function unknownRuleIdNotices(
  config: SteAiConfig,
  rules: readonly DeterministicRule[],
): RunNotice[] {
  const known = new Set(rules.map((rule) => rule.meta.id));
  // Sorted so two runs over the same configuration emit byte-identical notices.
  const unknown = Object.keys(config.rules)
    .filter((id) => !known.has(id))
    .toSorted((a, b) => a.localeCompare(b));

  return unknown.map((ruleId) => ({
    code: 'unknown-rule-id',
    level: 'warning',
    message: `Configuration names rule "${ruleId}", which is not a known rule, so those options were not applied`,
    detail: { ruleId },
  }));
}

/**
 * The status a diagnostic may report for a pack-supplied rule.
 *
 * A pack cannot promote its own rules to `normative` unless the operator has named it in
 * `trustedRulePackIds`; otherwise the strongest it can reach is `supplementary`.
 */
function verifiedRuleStatus(
  declared: RulePack['metadata']['authority'],
  pack: RulePack,
  trustedRulePackIds: readonly string[],
): RulePack['metadata']['authority'] {
  if (declared !== 'normative') return declared;
  return trustedRulePackIds.includes(pack.metadata.id) ? 'normative' : 'supplementary';
}

/**
 * Longest `metadata.id` fragment embedded in the "unverified citation" marker. `rulePackSchema`
 * places no length limit on `id` (`z.string().min(1)`), so an untrusted pack could otherwise use
 * its own id to inflate every diagnostic it triggers.
 */
const UNTRUSTED_PACK_ID_DISPLAY_LIMIT = 80;

/**
 * `pack.metadata.id` is free text the supplier controls, with no format constraint (Codex review
 * on PR #116): a newline or control character embedded in it reaches the "unverified citation"
 * marker verbatim, letting an untrusted pack push that marker's own warning text off-screen and
 * leave only its fabricated citation visible — the same attack #66 closed for `sourceRef` itself,
 * reopened through the id used to explain why `sourceRef` was withheld. Strips every C0/C1 control
 * character (not only newlines: any character in that range can be gathered into an ANSI escape
 * sequence acting on terminal state) and caps the length, rather than assuming a newline is the
 * only dangerous byte an unconstrained string can carry.
 */
function displaySafePackId(id: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately stripping control chars from untrusted supplier input
  const stripped = id.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return stripped.length > UNTRUSTED_PACK_ID_DISPLAY_LIMIT
    ? `${stripped.slice(0, UNTRUSTED_PACK_ID_DISPLAY_LIMIT)}…`
    : stripped;
}

function stripControlKeys(userConfig: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...userConfig };
  delete rest['enabled'];
  delete rest['severity'];
  return rest;
}

/**
 * Enforce the invariants a rule is not trusted to enforce itself:
 * protected-region containment, the autofix gate, and severity overrides.
 */
function postProcess(
  diagnostic: Diagnostic,
  rule: DeterministicRule,
  doc: AnalysedDocument,
  config: SteAiConfig,
  blockById: ReadonlyMap<string, TextBlock>,
  severityOverride: Severity | undefined,
): Diagnostic | null {
  if (!rule.meta.inspectsProtectedRegions && pointsOnlyAtProtectedContent(doc, diagnostic.range)) {
    return null;
  }
  if (diagnostic.category === 'review-required' && !config.diagnostics.reportReviewRequired) {
    return null;
  }

  let result: Diagnostic =
    severityOverride === undefined ? diagnostic : { ...diagnostic, severity: severityOverride };

  if (result.fix !== undefined) {
    const admonition = admonitionAt(doc, result.range, blockById);
    const refusal = gateFix({
      doc,
      fix: result.fix,
      admonition,
      ruleFixable: rule.meta.fixable,
      autofix: config.autofix,
    });
    if (refusal !== null) {
      const withoutFix = { ...result, fix: undefined };
      delete withoutFix.fix;
      result = {
        ...withoutFix,
        message: `${result.message} (No automatic fix: ${refusal.reason}.)`,
      };
    }
  }
  return result;
}

/**
 * True when a diagnostic points at nothing but protected content.
 *
 * Overlap is the wrong test here. A sentence-length diagnostic legitimately spans a whole sentence
 * that may *contain* a quantity, an inline code span or a heading marker; rejecting on overlap
 * silently discarded those findings. What must be rejected is a diagnostic whose span contains no
 * prose at all — that one is pointing at a literal.
 */
export function pointsOnlyAtProtectedContent(
  doc: AnalysedDocument,
  range: { start: number; end: number },
): boolean {
  const slice = doc.maskedText.slice(range.start, range.end);
  return !/[^\s\u{FFFD}]/u.test(slice);
}

function admonitionAt(
  doc: AnalysedDocument,
  range: { start: number; end: number },
  blockById: ReadonlyMap<string, TextBlock>,
): TextBlock['admonition'] {
  for (const sentence of doc.sentences) {
    if (rangesOverlap(sentence.range, range)) {
      return blockById.get(sentence.blockId)?.admonition ?? sentence.admonition;
    }
  }
  for (const block of doc.blocks) {
    if (rangesOverlap(block.range, range)) return block.admonition;
  }
  return 'none';
}

/**
 * Refuse fixes that overlap another fix.
 *
 * Both fixes are dropped rather than one being preferred. Two rules that disagree about the same
 * characters is exactly the situation where an automated edit is least trustworthy, so the tool
 * declines and says so instead of picking a winner.
 */
export function resolveOverlappingFixes(diagnostics: readonly Diagnostic[]): {
  diagnostics: Diagnostic[];
  notices: RunNotice[];
} {
  const withFixes = diagnostics
    .map((d, index) => ({ d, index }))
    .filter((entry) => entry.d.fix !== undefined);
  const conflicting = new Set<number>();

  for (let i = 0; i < withFixes.length; i += 1) {
    for (let j = i + 1; j < withFixes.length; j += 1) {
      const a = withFixes[i];
      const b = withFixes[j];
      if (a === undefined || b === undefined) continue;
      const fixA = a.d.fix;
      const fixB = b.d.fix;
      if (fixA === undefined || fixB === undefined) continue;
      if (!rangesOverlap(fixA.range, fixB.range)) continue;
      // Identical replacement of the identical range is not a conflict.
      if (
        fixA.range.start === fixB.range.start &&
        fixA.range.end === fixB.range.end &&
        fixA.text === fixB.text
      ) {
        conflicting.add(b.index);
        continue;
      }
      conflicting.add(a.index);
      conflicting.add(b.index);
    }
  }

  const notices: RunNotice[] = [];
  const out = diagnostics.map((diagnostic, index) => {
    if (!conflicting.has(index) || diagnostic.fix === undefined) return diagnostic;
    const withoutFix = { ...diagnostic, fix: undefined };
    delete withoutFix.fix;
    return {
      ...withoutFix,
      // Severity is deliberately untouched. Withholding a fix says nothing about how serious the
      // finding is, and overwriting it here discarded both the pack severity and the user override
      // that postProcess had already applied.
      message: `${diagnostic.message} (No automatic fix: another rule proposes an overlapping edit.)`,
    };
  });

  if (conflicting.size > 0) {
    notices.push({
      code: 'overlapping-fixes-refused',
      level: 'info',
      message: `${conflicting.size} automatic fix(es) were refused because they overlap another proposed edit.`,
      detail: { count: conflicting.size },
    });
  }
  return { diagnostics: out, notices };
}

function sortCandidates(candidates: readonly CandidatePassage[]): CandidatePassage[] {
  return candidates.toSorted(
    (a, b) =>
      a.range.start - b.range.start ||
      a.range.end - b.range.end ||
      a.evaluatorId.localeCompare(b.evaluatorId) ||
      a.id.localeCompare(b.id),
  );
}
