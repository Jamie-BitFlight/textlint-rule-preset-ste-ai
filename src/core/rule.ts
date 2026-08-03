import type { ZodType } from 'zod';
import type { AutofixPolicy, DiagnosticPolicy } from './config.js';
import type {
  AnalysedDocument,
  CandidatePassage,
  Diagnostic,
  RuleMetadata,
  RulePack,
  Sentence,
  SourceRange,
  TextBlock,
  TextFix,
} from './types.js';

export interface RuleInput<TOptions extends object = object> {
  readonly doc: AnalysedDocument;
  readonly options: TOptions;
  readonly pack: RulePack;
  readonly policy: DiagnosticPolicy;
  readonly autofix: AutofixPolicy;
  /** Blocks keyed by id, for rules that need a sentence's container. */
  readonly blockById: ReadonlyMap<string, TextBlock>;
  /**
   * The run's configured `extraImperativeVerbs` (`SteAiConfig.extraImperativeVerbs`), passed
   * through so a rule that consults `src/core/pos-tags.ts` (`sentenceOpensImperative`,
   * `buildSentencePosIndex`) can pass the *current* run's vocabulary explicitly on every call,
   * rather than relying on it having been taught to `compromise`'s shared lexicon by an earlier
   * call for this document. `pos-tags.ts` keys its lexicon state off exactly this value, so a rule
   * that silently omits it gets whatever configuration happened to run last in this process, not
   * necessarily this run's own.
   */
  readonly extraImperativeVerbs: readonly string[];
}

export interface RuleOutput {
  readonly diagnostics: readonly Diagnostic[];
  /** Passages this rule could not decide, handed to a named semantic evaluator. */
  readonly candidates: readonly CandidatePassage[];
}

export interface DeterministicRule<TOptions extends object = object> {
  readonly meta: RuleMetadata;
  /** Validates and defaults user options. Must accept `{}`. */
  readonly optionsSchema: ZodType<TOptions>;
  run(input: RuleInput<TOptions>): RuleOutput;
}

export const emptyOutput: RuleOutput = { diagnostics: [], candidates: [] };

/** Helper for rules: sentences whose mode the rule applies to. */
export function applicableSentences(
  doc: AnalysedDocument,
  meta: RuleMetadata,
): readonly Sentence[] {
  return doc.sentences.filter((s) => meta.appliesTo.includes(s.mode));
}

// ---------------------------------------------------------------------------
// Autofix safety gate
// ---------------------------------------------------------------------------

/**
 * Numeric literals in order of appearance, normalised for comparison.
 *
 * Captures a sign, digits, decimal separators, and version-style dotted groups as one token each,
 * so a change of value, grouping or decimal position is visible.
 */
function numericTokens(text: string): string[] {
  return [...text.matchAll(/[+-]?\d+(?:[.,]\d+)*/g)].map((m) => m[0].replace(',', '.'));
}

/** Tokens whose presence or count must never change across a fix. */
const NEGATION =
  /\b(?:not|no|never|none|neither|nor|without|cannot|can't|don't|doesn't|didn't|won't|shouldn't|mustn't)\b/gi;
const MODALS = /\b(?:must|shall|should|can|could|may|might|will|would|need|ought)\b/gi;
const ORDERING = /\b(?:before|after|first|then|next|finally|while|until|during|when|once)\b/gi;

/**
 * Expand negative contractions before comparison.
 *
 * Without this, expanding `don't` to `do not` would itself be reported as "changes negation",
 * because the two spellings tokenise differently. Normalising both sides makes the comparison
 * about meaning rather than spelling.
 */
function normalizeForComparison(text: string): string {
  return (
    text
      // Register variants of the same temporal relation. Without these, expanding `prior to` to
      // `before` would be rejected as "changes an ordering word" even though the relation is
      // identical — the check must compare relations, not spellings.
      .replace(/\bwhilst\b/gi, 'while')
      .replace(/\bamongst\b/gi, 'among')
      .replace(/\b(?:prior|previous)\s+to\b/gi, 'before')
      .replace(/\bsubsequent\s+to\b/gi, 'after')
      .replace(/\bcannot\b/gi, 'can not')
      .replace(/\bwon['’]t\b/gi, 'will not')
      .replace(/\bcan['’]t\b/gi, 'can not')
      .replace(/\bshan['’]t\b/gi, 'shall not')
      .replace(
        /\b(do|does|did|is|are|was|were|has|have|had|would|should|could|must|need|might|ought)n['’]t\b/gi,
        '$1 not',
      )
  );
}

function multiset(text: string, re: RegExp): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of normalizeForComparison(text).matchAll(re)) {
    const key = m[0].toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function sameMultiset(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

export interface FixRefusal {
  readonly reason: string;
}

/**
 * Decide whether a proposed substitution may be applied automatically.
 *
 * Returns `null` when the fix is allowed, or a refusal with a reason. The checks are intentionally
 * blunt: a fix that changes any digit, any negation token, any modal verb, or any ordering word is
 * refused outright regardless of which rule proposed it.
 */
export function checkFixSafety(before: string, after: string): FixRefusal | null {
  // Compare the ordered sequence of numeric literals, not a concatenation of their digits.
  // Concatenating made `1.5 mm` → `15 mm`, `10.0 Nm` → `100 Nm` and `0.5 A` → `05 A` all look
  // identical, so a fix could move a decimal point or regroup a quantity unchallenged.
  const numbersBefore = numericTokens(before);
  const numbersAfter = numericTokens(after);
  if (
    numbersBefore.length !== numbersAfter.length ||
    numbersBefore.some((value, index) => value !== numbersAfter[index])
  ) {
    return { reason: 'the replacement changes a numeric value' };
  }
  if (!sameMultiset(multiset(before, NEGATION), multiset(after, NEGATION))) {
    return { reason: 'the replacement changes negation' };
  }
  if (!sameMultiset(multiset(before, MODALS), multiset(after, MODALS))) {
    return { reason: 'the replacement changes modal force' };
  }
  if (!sameMultiset(multiset(before, ORDERING), multiset(after, ORDERING))) {
    return { reason: 'the replacement changes an ordering word' };
  }
  return null;
}

export interface FixGateInput {
  readonly doc: AnalysedDocument;
  readonly fix: TextFix;
  readonly admonition: TextBlock['admonition'];
  readonly ruleFixable: boolean;
  readonly autofix: AutofixPolicy;
}

/**
 * Central autofix gate. Every fix, from every rule, passes through this function before it can
 * reach a caller. Rules do not get to opt out.
 */
export function gateFix(input: FixGateInput): FixRefusal | null {
  const { doc, fix, admonition, ruleFixable, autofix } = input;
  if (!autofix.enabled) return { reason: 'autofix is disabled by configuration' };
  if (!ruleFixable) return { reason: 'the rule does not declare a fix' };
  if (admonition !== 'none') {
    return { reason: `content in a ${admonition} admonition is never autofixed` };
  }
  if (doc.isProtected(fix.range)) {
    return { reason: 'the fix overlaps a protected region' };
  }
  if (fix.safety === 'semantic-gated' && !autofix.allowSemanticFixes) {
    return { reason: 'semantic-gated fixes are disabled by configuration' };
  }
  const before = doc.text.slice(fix.range.start, fix.range.end);
  return checkFixSafety(before, fix.text);
}

// ---------------------------------------------------------------------------
// Diagnostic construction
// ---------------------------------------------------------------------------

export interface DiagnosticDraft {
  readonly category: Diagnostic['category'];
  readonly message: string;
  readonly range: SourceRange;
  readonly evidence?: string;
  readonly suggestions?: readonly string[];
  readonly fix?: TextFix;
  readonly meta?: Diagnostic['meta'];
}

/**
 * Build a diagnostic from a rule draft, applying the severity policy and the rule's declared
 * status. Rules never set severity or status themselves.
 */
export function buildDiagnostic(
  meta: RuleMetadata,
  policy: DiagnosticPolicy,
  draft: DiagnosticDraft,
  severityOverride?: Diagnostic['severity'],
): Diagnostic {
  return {
    ruleId: meta.id,
    ruleStatus: meta.status,
    category: draft.category,
    severity: severityOverride ?? policy.severity[draft.category],
    message: draft.message,
    range: draft.range,
    producedBy: 'deterministic',
    ...(draft.evidence === undefined ? {} : { evidence: draft.evidence }),
    ...(draft.suggestions === undefined ? {} : { suggestions: draft.suggestions }),
    ...(draft.fix === undefined ? {} : { fix: draft.fix }),
    ...(draft.meta === undefined ? {} : { meta: draft.meta }),
  };
}
