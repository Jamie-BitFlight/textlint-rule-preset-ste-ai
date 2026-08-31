import type { SteAiConfig } from './config.js';
import { provisionalRulePack } from './default-pack.js';
import { buildSentencePosIndex, type SentencePosIndex } from './pos-tags.js';
import { gateFix, type DeterministicRule, type RuleInput } from './rule.js';
import { isSafeRulePackId } from './rule-pack-id.js';
import { rangesOverlap } from './text.js';
import { buildWinkPosIndex, type WinkPosIndex } from './wink-tags.js';
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
  const posIndexes = new WeakMap<object, SentencePosIndex>();
  const winkIndexes = new WeakMap<object, WinkPosIndex>();
  const posIndexFor: RuleInput['posIndexFor'] = (sentence) => {
    let index = posIndexes.get(sentence);
    if (index === undefined) {
      index = buildSentencePosIndex(sentence, config.extraImperativeVerbs);
      posIndexes.set(sentence, index);
    }
    return index;
  };
  const winkIndexFor: RuleInput['winkIndexFor'] = (sentence) => {
    let index = winkIndexes.get(sentence);
    if (index === undefined) {
      index = buildWinkPosIndex(sentence.masked);
      winkIndexes.set(sentence, index);
    }
    return index;
  };

  notices.push(...unknownRuleIdNotices(config, rules));

  // Whether the *pack itself* is trusted, independent of what any one rule entry declares. Hoisted
  // above the loop: `pack` and `config.trustedRulePackIds` are the same for every rule this run, so
  // this is a single membership check per document, not one per enabled rule.
  const packTrusted = config.trustedRulePackIds.includes(pack.metadata.id);

  // `pack.metadata.id` is invariant for the whole run, so its safety check (see the citation-safety
  // comment at this value's one use site below) and the resulting display string are computed once
  // here rather than once per diagnostic an untrusted pack's rules produce.
  const safePackId = isSafeRulePackId(pack.metadata.id)
    ? pack.metadata.id
    : '<id omitted: does not match the expected pack-id format>';

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
      posIndexFor,
      winkIndexFor,
    };

    const output = rule.run(input);

    // A pack may raise a rule's authority and supply its own citation. Without this the pack's
    // `status`/`sourceRef` were parsed, validated and then ignored, so an authorised pack changed
    // nothing a reader could see. `verifiedAuthority` still caps an untrusted pack.
    //
    // Bundled as one value, rather than a separate `packStatus` alongside `packSpec`: the two used
    // to be checked independently below (`packSpec === undefined || packStatus === undefined`)
    // even though `verifiedRuleStatus` never returns `undefined`, so the second half of that check
    // could only ever agree with the first — one derived value with one `undefined` check keeps
    // that redundancy from silently reappearing if a future edit to `verifiedRuleStatus` legitimately
    // introduces its own `undefined` case, which the old pair of checks would have then conflated
    // with "no pack entry for this rule."
    const packInfo =
      packSpec === undefined
        ? undefined
        : {
            spec: packSpec,
            status: verifiedRuleStatus(packSpec.status, pack, config.trustedRulePackIds),
          };

    // `sourceRef` trust (via `packTrusted`, hoisted above the loop) cannot be inferred from whether
    // `packInfo.status` was downgraded (#66's original gap): an untrusted pack that declares
    // `status: "supplementary"` directly, rather than `"normative"`, is never downgraded —
    // `verifiedRuleStatus` only ever touches a `"normative"` declaration — so gating on the downgrade
    // let that pack's citation straight through.
    for (const diagnostic of output.diagnostics) {
      const processed = postProcess(diagnostic, rule, doc, config, blockById, severityOverride);
      if (processed === null) continue;
      diagnostics.push(
        packInfo === undefined
          ? processed
          : {
              ...processed,
              ruleStatus: packInfo.status,
              meta: {
                ...processed.meta,
                // String-comparing `sourceRef` against `rule.meta.sourceRef` was tried and found
                // insufficient (Codex review on PR #116): an untrusted pack can copy that citation
                // string verbatim while supplying entirely different rule-governing data — a
                // fabricated dictionary entry, a loosened limit — so the diagnostic still carried a
                // citation naming a section that describes different data than what actually fired.
                // Matching a string proves the string matches; it proves nothing about the data
                // behind it. A copyable field on the pack object was tried next (`isBundledDefault`)
                // and also found insufficient: `{ ...provisionalRulePack, rules: attackerRules }`
                // carries that field through object spread along with every other own property, so
                // it proved nothing about where `rules` (or `dictionary`) actually came from either.
                // Only `pack === provisionalRulePack` — genuine reference identity with the one
                // singleton object, which spread cannot preserve because spread always allocates a
                // new object — proves the cited data is what the citation claims it is.
                //
                // `pack.metadata.id` is interpolated below only after passing `isSafeRulePackId`
                // (`RULE_PACK_ID_PATTERN`: `[A-Za-z0-9@][A-Za-z0-9._:@/+-]*`, max 128 characters —
                // no space, no quote, no control character, no Unicode line/paragraph separator,
                // nothing that could make an id read as prose or break out of the quoted
                // template). `rulePackMetadataSchema` (`src/rule-pack/schema.ts`) enforces the same
                // pattern for every pack that reaches this point through `parseRulePack`, but a
                // caller of the public `runDeterministicRules` API can hand it a `RulePack`-shaped
                // object that never went through that schema (round 11) — this check makes the
                // interpolation safe regardless of how `pack` got here, not just for the schema-
                // validated path. A denylist strip (`displaySafePackId`, since removed) was tried
                // here across three review rounds (PR #116, rounds 5, 7, 10) and lost each time to
                // a fresh character class; an allowlist, checked at both the schema and this sink,
                // closes the class instead of extending the list.
                sourceRef:
                  pack === provisionalRulePack || packTrusted
                    ? packInfo.spec.sourceRef
                    : `unverified citation from untrusted rule pack "${safePackId}"`,
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
