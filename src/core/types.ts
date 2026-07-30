/**
 * Framework-neutral domain types.
 *
 * Nothing in this file may reference textlint, HTTP, or any transport concern.
 * The textlint adapter (`src/textlint`) and the model client (`src/model-client`)
 * translate to and from these types.
 */

// ---------------------------------------------------------------------------
// Authority and status
// ---------------------------------------------------------------------------

/**
 * Where a rule's normative force comes from.
 *
 * - `normative`      — supplied by an authorised rule pack that carries the standard's rule data.
 * - `supplementary`  — authoritative guidance that is not the standard itself.
 * - `provisional`    — a defensible controlled-language heuristic authored for this project.
 *                      Provisional rules must never be presented as standard conformance.
 */
export type RuleStatus = 'normative' | 'supplementary' | 'provisional';

/** How a finding was produced and how much weight a reader should give it. */
export type DiagnosticCategory =
  /** A rule with an exact, reproducible trigger fired. No inference involved. */
  | 'deterministic-violation'
  /** A semantic evaluator returned `violation` at or above the configured threshold. */
  | 'probable-semantic-violation'
  /** A candidate the tool cannot decide: heuristic hit with no adjudication, or `uncertain`. */
  | 'review-required'
  /** A semantic verdict was discarded because reported confidence was below threshold. */
  | 'suppressed-low-confidence'
  /** The semantic service failed. This is a tooling fault, never a compliance statement. */
  | 'infrastructure-failure';

export type Severity = 'info' | 'warning' | 'error';

/** A semantic evaluator's decision about a passage. */
export type AdjudicationStatus = 'compliant' | 'violation' | 'uncertain';

// ---------------------------------------------------------------------------
// Source geometry
// ---------------------------------------------------------------------------

/** Half-open absolute character offsets into `SourceDocument.text`. */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

/** 1-based line, 0-based column — matches the textlint AST convention. */
export interface SourcePosition {
  readonly line: number;
  readonly column: number;
}

// ---------------------------------------------------------------------------
// Protected regions
// ---------------------------------------------------------------------------

export type ProtectedRegionKind =
  | 'front-matter'
  | 'fenced-code'
  | 'indented-code'
  | 'inline-code'
  | 'html-block'
  | 'html-inline'
  | 'comment'
  | 'link-destination'
  | 'autolink'
  | 'url'
  | 'email'
  | 'file-path'
  | 'shell-command'
  | 'config-fragment'
  | 'math'
  | 'table-markup'
  | 'list-marker'
  | 'heading-marker'
  | 'blockquote-marker'
  | 'emphasis-marker'
  | 'reference-definition'
  | 'footnote-marker'
  | 'numeric-expression'
  | 'placeholder'
  | 'quoted-literal'
  | 'identifier'
  | 'api-name'
  | 'field-name'
  | 'constant'
  | 'product-identifier'
  | 'credential'
  | 'approved-term';

/**
 * A span that ordinary prose rules must not read as prose.
 *
 * `opaque: true` means: no diagnostic may be anchored inside the span, no fix may overlap it,
 * and the span's characters are masked out before segmentation and lexical matching. Rules that
 * declare `inspectsProtectedRegions` may still read the region (for example, a rule that checks
 * that a fenced block has a language tag).
 */
export interface ProtectedRegion {
  readonly kind: ProtectedRegionKind;
  readonly range: SourceRange;
  readonly opaque: boolean;
  /** Why this span is protected. Surfaced in trace output. */
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// Document structure
// ---------------------------------------------------------------------------

/**
 * Whether a passage tells the reader to do something (procedural) or tells the reader
 * what something is (descriptive). The two carry different sentence-length limits in every
 * controlled-English scheme the author is aware of, so the distinction is a first-class field.
 */
export type TextMode = 'procedural' | 'descriptive';

/** Safety register of a block. Autofix is refused inside anything other than `none`. */
export type AdmonitionKind = 'danger' | 'warning' | 'caution' | 'note' | 'none';

export type BlockKind =
  'paragraph' | 'heading' | 'list-item' | 'table-cell' | 'block-quote' | 'caption';

/** A run of prose with exact source offsets. */
export interface TextBlock {
  readonly id: string;
  readonly kind: BlockKind;
  readonly range: SourceRange;
  /** Raw source slice for `range`. */
  readonly text: string;
  readonly mode: TextMode;
  readonly admonition: AdmonitionKind;
  /** Nesting depth: heading level, list depth, or blockquote depth. */
  readonly depth: number;
  readonly inList: boolean;
  /** 1-based ordinal when the block is an item of an ordered list. */
  readonly listOrdinal?: number;
}

export interface Word {
  readonly range: SourceRange;
  readonly text: string;
  readonly lower: string;
  /**
   * Set when this "word" is a content-bearing protected region (a quantity, identifier, inline
   * code span, URL, placeholder, quoted literal). Such tokens **count** towards sentence-length
   * limits — a reader still has to read `10 mm` — but must never be matched against a
   * vocabulary list or rewritten. Vocabulary rules filter on `protectedKind === undefined`.
   * Structural markup (list markers, table pipes, fences) produces no word at all.
   */
  readonly protectedKind?: ProtectedRegionKind;
}

export interface Sentence {
  readonly id: string;
  readonly blockId: string;
  readonly range: SourceRange;
  /** Raw source slice for `range`, protected regions included verbatim. */
  readonly raw: string;
  /**
   * `raw` with every opaque protected region replaced by an equal-length run of U+FFFD.
   * Equal length is load-bearing: an index into `masked` is always a valid index into `raw`,
   * so offsets survive masking without a translation table.
   */
  readonly masked: string;
  readonly mode: TextMode;
  readonly admonition: AdmonitionKind;
  /** Words drawn from `masked`, so protected content never becomes a word. */
  readonly words: readonly Word[];
}

export type DocumentFormat = 'markdown' | 'text';

export interface SourceDocument {
  readonly id: string;
  readonly path?: string;
  readonly format: DocumentFormat;
  readonly text: string;
}

/** A `SourceDocument` after protected-region extraction, block scanning and segmentation. */
export interface AnalysedDocument extends SourceDocument {
  readonly protectedRegions: readonly ProtectedRegion[];
  readonly blocks: readonly TextBlock[];
  readonly sentences: readonly Sentence[];
  /** `text` with all opaque protected regions masked to U+FFFD. Same length as `text`. */
  readonly maskedText: string;
  /** True when the span overlaps an opaque protected region. */
  isProtected(range: SourceRange): boolean;
  positionAt(offset: number): SourcePosition;
}

// ---------------------------------------------------------------------------
// Fixes
// ---------------------------------------------------------------------------

/**
 * Why a fix is allowed to exist at all.
 *
 * - `deterministic-meaning-preserving` — the substitution is a closed, enumerated rewrite that
 *   cannot alter technical meaning (for example `do not` for `don't`).
 * - `semantic-gated` — a model-proposed rewrite that passed an independent meaning-preservation
 *   evaluation and left every declared invariant unchanged.
 */
export type FixSafety = 'deterministic-meaning-preserving' | 'semantic-gated';

export interface TextFix {
  readonly range: SourceRange;
  readonly text: string;
  readonly rationale: string;
  readonly safety: FixSafety;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface Diagnostic {
  readonly ruleId: string;
  readonly ruleStatus: RuleStatus;
  readonly category: DiagnosticCategory;
  readonly severity: Severity;
  readonly message: string;
  readonly range: SourceRange;
  readonly producedBy: 'deterministic' | 'semantic';
  /**
   * Model-reported confidence, verbatim. This is **not** a calibrated probability; it is the
   * number the model emitted. Decision thresholds live in configuration, never here.
   */
  readonly modelReportedConfidence?: number;
  /** The threshold this diagnostic was compared against, for auditability. */
  readonly decisionThreshold?: number;
  readonly evidence?: string;
  readonly suggestions?: readonly string[];
  readonly fix?: TextFix;
  /**
   * The originating {@link CandidatePassage.id}, when this diagnostic was built from one.
   *
   * Adjudication is free to remap `range` to the model's evidence span, which can legitimately
   * differ from the candidate's own span — so anything that must recognise "this is the same
   * candidate decision" (for example, a refusal already reported before adjudication ran) has to
   * match on this stable id rather than on the diagnostic's final range.
   */
  readonly candidateId?: string;
  readonly meta?: Readonly<Record<string, string | number | boolean>>;
}

/** A run-level event that is not anchored to a span (service outage, cache stats, versions). */
export interface RunNotice {
  readonly code: string;
  readonly level: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

// ---------------------------------------------------------------------------
// Inline suppression
// ---------------------------------------------------------------------------

/** A parsed inline suppression directive. */
export interface SuppressionDirective {
  readonly kind: 'next-line' | 'range';
  /** Span of the directive comment itself. */
  readonly directiveRange: SourceRange;
  /** Span of source this directive suppresses. */
  readonly range: SourceRange;
  /** Rule ids named by the directive. Empty means every rule. */
  readonly ruleIds: readonly string[];
  readonly reason: string;
}

/**
 * A finding that was withheld because an inline directive claimed it as intentional.
 *
 * Recorded rather than discarded: a suppression is a claim by the author, and the diagnostic
 * policy does not allow a claim to become invisible.
 */
export interface SuppressionRecord {
  readonly ruleId: string;
  readonly category: DiagnosticCategory;
  readonly range: SourceRange;
  /** The message the withheld diagnostic would have carried. */
  readonly message: string;
  readonly reason: string;
  readonly directiveRange: SourceRange;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface RuleMetadata {
  /** Stable identifier. Never renamed; deprecate and add instead. */
  readonly id: string;
  readonly title: string;
  readonly status: RuleStatus;
  /**
   * Where the rule's normative force comes from. For provisional rules this is a
   * `provisional:` reference into `docs/provisional-rules.md`, never a citation of the standard.
   */
  readonly sourceRef: string;
  readonly kind: 'deterministic' | 'semantic';
  readonly appliesTo: readonly TextMode[];
  readonly defaultSeverity: Severity;
  readonly fixable: boolean;
  /** When false, the runner masks protected content before the rule sees it. */
  readonly inspectsProtectedRegions: boolean;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// Semantic candidates and verdicts
// ---------------------------------------------------------------------------

export type SemanticEvaluatorId =
  | 'approved-word-sense'
  | 'permitted-part-of-speech'
  | 'one-instruction-per-sentence'
  | 'passive-voice-adjudication'
  | 'pronoun-antecedent-ambiguity'
  | 'noun-cluster-comprehension'
  | 'technical-term-legitimacy'
  | 'rewrite-equivalence';

/**
 * A passage a deterministic rule could not decide, handed to a named evaluator.
 *
 * `passage` is what the model receives. It is derived from masked text, so opaque protected
 * content is never transmitted unless the evaluator explicitly needs it and declares so.
 */
export interface CandidatePassage {
  readonly id: string;
  readonly ruleId: string;
  readonly evaluatorId: SemanticEvaluatorId;
  /** Exact span in the source document that the verdict will be anchored to. */
  readonly range: SourceRange;
  readonly passage: string;
  /** Offset of `passage[0]` within the source document; used to map evidence spans back. */
  readonly passageOffset: number;
  /** Evaluator-specific fields. Kept minimal: only what that one classification needs. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Semantic invariants the model is forbidden to change in any suggestion. */
  readonly invariants: readonly string[];
  readonly reason: string;
  readonly mode: TextMode;
  readonly admonition: AdmonitionKind;
}

/** The validated shape of a model response. Rejected if it does not parse exactly. */
export interface SemanticVerdict {
  readonly ruleId: string;
  readonly status: AdjudicationStatus;
  /** Model-reported, range [0,1]. Not a calibrated probability. */
  readonly confidence: number;
  /** Offsets into the submitted passage, not into the document. */
  readonly evidenceStart: number;
  readonly evidenceEnd: number;
  readonly explanation: string;
  readonly suggestedReplacements: readonly string[];
  readonly meaningPreserved: boolean;
}

export type SemanticOutcome =
  | {
      readonly kind: 'verdict';
      readonly candidateId: string;
      readonly verdict: SemanticVerdict;
      readonly trace: SemanticTrace;
    }
  | {
      readonly kind: 'failure';
      readonly candidateId: string;
      readonly failure: SemanticFailure;
      readonly trace: SemanticTrace;
    };

export type SemanticFailureKind =
  | 'disabled'
  | 'transport'
  | 'timeout'
  | 'cancelled'
  | 'invalid-response'
  | 'contradictory-response'
  | 'out-of-range';

export interface SemanticFailure {
  readonly kind: SemanticFailureKind;
  readonly message: string;
  readonly attempts: number;
}

export interface SemanticTrace {
  readonly candidateId: string;
  readonly evaluatorId: SemanticEvaluatorId;
  readonly promptVersion: string;
  readonly modelId: string;
  readonly contentHash: string;
  readonly cacheHit: boolean;
  readonly attempts: number;
  readonly durationMs: number;
  readonly repaired: boolean;
}

// ---------------------------------------------------------------------------
// Rule pack (import boundary)
// ---------------------------------------------------------------------------

export interface RulePackMetadata {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly authority: RuleStatus;
  readonly licence: string;
  readonly source: string;
  readonly retrievedAt?: string;
  /**
   * What the pack's supplier claims. The linter never upgrades this on its own, and a value
   * of `none` forbids every conformance statement in output.
   */
  readonly conformanceClaim: 'none' | 'partial' | 'declared-by-supplier';
  readonly notice?: string;
}

export interface UnapprovedTermEntry {
  readonly term: string;
  /** Approved alternatives. Empty means "no approved alternative is supplied by this pack". */
  readonly alternatives: readonly string[];
  readonly note?: string;
  /**
   * True only when substituting the first alternative cannot change technical meaning in any
   * context. Packs default this to false; the linter never infers it.
   */
  readonly safeSubstitution: boolean;
  /** Part of speech the restriction applies to, when the pack scopes it. */
  readonly partOfSpeech?: string;
}

export interface PreferredTermEntry {
  readonly from: string;
  readonly to: string;
  readonly safeSubstitution: boolean;
  readonly note?: string;
}

export interface ApprovedTermEntry {
  readonly term: string;
  /** Permitted parts of speech for this term, when the pack scopes them. */
  readonly partsOfSpeech?: readonly string[];
  /** Permitted senses, used by the `approved-word-sense` evaluator when present. */
  readonly senses?: readonly string[];
}

export interface RulePackLimits {
  readonly proceduralMaxGradeLevel: number;
  readonly descriptiveMaxGradeLevel: number;
  readonly sentenceReadabilityFloorWords: number;
  readonly maxNounClusterLength: number;
  readonly maxSentencesPerProceduralStep: number;
  readonly maxParagraphSentences: number;
}

export interface RulePackRuleSpec {
  readonly ruleId: string;
  readonly status: RuleStatus;
  readonly sourceRef: string;
  readonly enabled: boolean;
  readonly severity?: Severity;
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface RulePack {
  readonly metadata: RulePackMetadata;
  readonly limits: RulePackLimits;
  readonly dictionary: {
    readonly approved: readonly ApprovedTermEntry[];
    readonly unapproved: readonly UnapprovedTermEntry[];
    readonly preferred: readonly PreferredTermEntry[];
  };
  readonly contractions: readonly PreferredTermEntry[];
  /** Terms this pack designates as project-approved technical names (protected as literals). */
  readonly approvedTechnicalTerms: readonly string[];
  readonly rules: readonly RulePackRuleSpec[];
}

// ---------------------------------------------------------------------------
// Fixture annotations
// ---------------------------------------------------------------------------

export type AdjudicationRecordStatus = 'accepted' | 'disputed' | 'deferred';

export interface FixtureAnnotationChange {
  readonly passageId: string;
  readonly originalText: string;
  readonly rewrittenText: string;
  readonly ruleIds: readonly string[];
  readonly originalSpans: readonly SourceRange[];
  readonly expectedDiagnostics: readonly {
    readonly ruleId: string;
    readonly category: DiagnosticCategory;
    readonly quote: string;
  }[];
  readonly reason: string;
  readonly semanticInvariants: readonly string[];
  readonly unresolved: readonly string[];
  readonly status: AdjudicationRecordStatus;
  /** Reviewer confidence in the rewrite, 0..1, human-assigned. */
  readonly reviewerConfidence: number;
}

export interface FixtureAnnotation {
  readonly fixtureId: string;
  readonly original: string;
  readonly compliant: string;
  readonly split: 'dev' | 'heldout';
  readonly changes: readonly FixtureAnnotationChange[];
  /** Literal strings that must be byte-identical in both files. */
  readonly protectedLiterals: readonly string[];
  readonly reviewers: readonly string[];
  readonly notes?: string;
}
