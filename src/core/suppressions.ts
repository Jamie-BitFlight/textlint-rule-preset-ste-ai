import { computeLineStarts, positionAt } from './text.js';
import type {
  AdmonitionKind,
  AnalysedDocument,
  Diagnostic,
  RunNotice,
  SourceRange,
  SuppressionDirective,
  SuppressionRecord,
} from './types.js';

/**
 * Inline suppression: an author's claim that a finding is intentional.
 *
 * The claim is honoured by withholding the diagnostic and **recorded** as a
 * {@link SuppressionRecord}, never simply dropped. `docs/diagnostic-policy.md` forbids silence
 * from meaning compliance, and an invisible suppression is exactly that.
 *
 * Everything here reads `doc.text` directly rather than the protected regions. In `format: 'text'`
 * documents an HTML comment is ordinary prose — there is no comment pass in `PLAIN_TEXT_PASSES` —
 * so a directive would be invisible to a region-based scan.
 */

/** Every directive keyword begins with this, which is also what makes a typo reportable. */
const KEYWORD_PREFIX = 'ste-ai-ignore';
const NEXT_LINE_KEYWORD = 'ste-ai-ignore-next-line';
const START_KEYWORD = 'ste-ai-ignore-start';
const END_KEYWORD = 'ste-ai-ignore-end';

/** The reason separator. Spaced so that a hyphenated rule id can never be mistaken for it. */
const REASON_SEPARATOR = ' -- ';

const COMMENT_RE = /<!--([\s\S]*?)-->/g;

/**
 * Blockquote markers, stripped before a line is tested for being nothing but a directive.
 *
 * `> <!-- ... -->` is a directive line in every sense that matters: the marker is structural markup,
 * not content. Without this, stacked directives inside a blockquote each claimed the next one's
 * line instead of the prose beneath them.
 */
const BLOCKQUOTE_PREFIX = /^[ \t]*(?:>[ \t]*)+/;

/** Safety registers where a suppression is refused unless the operator has opted in. */
const GUARDED_ADMONITIONS: ReadonlySet<AdmonitionKind> = new Set<AdmonitionKind>([
  'danger',
  'warning',
  'caution',
]);

/** Recorded against anything found inside a directive comment, valid directive or not. */
export const DIRECTIVE_TEXT_REASON = 'directive text is not prose';

export interface SuppressionScanResult {
  readonly directives: readonly SuppressionDirective[];
  readonly notices: readonly RunNotice[];
  /**
   * Spans of every live directive comment, well formed or not.
   *
   * Exposed because the analysis layer has to withhold candidates anchored in one *before* they are
   * adjudicated. In `format: 'text'` a comment is ordinary prose, so the reason an author wrote to
   * justify a suppression is itself lintable text — and left alone it is transmitted to the model,
   * which is exactly what a suppression is supposed to prevent.
   */
  readonly commentRanges: readonly SourceRange[];
}

/** A comment that looks like a directive, before it is known to be well formed. */
interface DirectiveComment {
  readonly directiveRange: SourceRange;
  readonly keyword: string;
  readonly rest: string;
  readonly line: number;
}

/** An `ignore-start` waiting for its `ignore-end`. */
interface OpenRange {
  readonly directiveRange: SourceRange;
  readonly ruleIds: readonly string[];
  readonly reason: string;
  readonly line: number;
}

/** Parse every inline directive in the document. Pure; reads `doc.text` only. */
export function scanSuppressions(doc: AnalysedDocument): SuppressionScanResult {
  const text = doc.text;
  const lineStarts = computeLineStarts(text);
  const directiveLines = directiveOnlyLines(text, lineStarts);
  const directives: SuppressionDirective[] = [];
  const notices: RunNotice[] = [];
  let open: OpenRange | undefined;

  const closeOpen = (endOffset: number): void => {
    if (open === undefined) return;
    directives.push({
      kind: 'range',
      directiveRange: open.directiveRange,
      range: { start: open.directiveRange.end, end: Math.max(open.directiveRange.end, endOffset) },
      ruleIds: open.ruleIds,
      reason: open.reason,
    });
    open = undefined;
  };

  for (const comment of directiveComments(doc, lineStarts)) {
    if (comment.keyword === END_KEYWORD) {
      if (open === undefined) {
        notices.push(
          notice('suppression-end-without-start', 'warning', 'A suppression range was ended', {
            line: comment.line,
          }),
        );
        continue;
      }
      closeOpen(comment.directiveRange.start);
      continue;
    }

    if (comment.keyword !== NEXT_LINE_KEYWORD && comment.keyword !== START_KEYWORD) {
      notices.push(
        notice(
          'suppression-malformed',
          'warning',
          `"${comment.keyword}" is not a suppression directive`,
          { line: comment.line },
        ),
      );
      continue;
    }

    const parsed = parseRuleIdsAndReason(comment.rest);
    if (parsed === undefined) {
      notices.push(
        notice(
          'suppression-reason-missing',
          'warning',
          'A suppression directive carries no reason and was ignored',
          { line: comment.line },
        ),
      );
      continue;
    }

    if (comment.keyword === NEXT_LINE_KEYWORD) {
      directives.push({
        kind: 'next-line',
        directiveRange: comment.directiveRange,
        range: nextEligibleLineRange(text, lineStarts, directiveLines, comment.directiveRange.end),
        ruleIds: parsed.ruleIds,
        reason: parsed.reason,
      });
      continue;
    }

    // Nesting is not supported: an inner start would make the reason recorded against a finding
    // ambiguous, so the outer range is closed here and reported as unterminated.
    if (open !== undefined) {
      notices.push(unclosedRange(open.line));
      closeOpen(comment.directiveRange.start);
    }
    open = {
      directiveRange: comment.directiveRange,
      ruleIds: parsed.ruleIds,
      reason: parsed.reason,
      line: comment.line,
    };
  }

  if (open !== undefined) {
    notices.push(unclosedRange(open.line));
    closeOpen(text.length);
  }

  // A range directive is only complete once its end is seen, so the list is put back into source
  // order — `directiveFor` resolves ties by taking the first match.
  directives.sort(
    (a, b) => a.directiveRange.start - b.directiveRange.start || a.range.start - b.range.start,
  );
  return { directives, notices, commentRanges: directiveCommentRanges(doc) };
}

/**
 * The directive that claims a finding for `ruleId` anchored at `offset`, if any.
 * First matching directive in source order wins.
 */
export function directiveFor(
  directives: readonly SuppressionDirective[],
  ruleId: string,
  offset: number,
): SuppressionDirective | undefined {
  return directives.find(
    (directive) =>
      offset >= directive.range.start &&
      offset < directive.range.end &&
      (directive.ruleIds.length === 0 || directive.ruleIds.includes(ruleId)),
  );
}

export interface ApplySuppressionsInput {
  readonly doc: AnalysedDocument;
  readonly diagnostics: readonly Diagnostic[];
  readonly directives: readonly SuppressionDirective[];
  readonly allowInAdmonitions: boolean;
  /** Every rule id the run knows about, for the unknown-id notice. */
  readonly knownRuleIds: readonly string[];
  /**
   * Directives an earlier stage already matched against something it withheld.
   *
   * Candidates are filtered out before the diagnostics exist, so a directive whose only target was
   * a candidate has claimed nothing by the time this runs. Without this the caller's own successful
   * suppression would come back as `suppression-unused`, telling an author to delete a directive
   * that is doing exactly what it was written to do.
   */
  readonly alreadyClaimed?: readonly SuppressionDirective[];
}

export interface ApplySuppressionsResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly suppressions: readonly SuppressionRecord[];
  readonly notices: readonly RunNotice[];
}

export function applySuppressions(input: ApplySuppressionsInput): ApplySuppressionsResult {
  const { doc, diagnostics, directives, allowInAdmonitions, knownRuleIds } = input;
  const lineStarts = computeLineStarts(doc.text);
  const known = new Set(knownRuleIds);
  const commentRanges = directiveCommentRanges(doc);
  const kept: Diagnostic[] = [];
  const suppressions: SuppressionRecord[] = [];
  const notices: RunNotice[] = [];
  const claimed = new Set<SuppressionDirective>(input.alreadyClaimed ?? []);

  const reported = new Set<string>();
  for (const directive of directives) {
    for (const ruleId of directive.ruleIds) {
      if (known.has(ruleId) || reported.has(ruleId)) continue;
      reported.add(ruleId);
      notices.push(
        notice(
          'suppression-unknown-rule',
          'warning',
          `A suppression directive names "${ruleId}", which is not a known rule, so it suppresses nothing`,
          { ruleId },
        ),
      );
    }
  }

  for (const diagnostic of diagnostics) {
    const anchor = diagnostic.range.start;

    // Every directive comment is withheld, valid or not. In `format: 'text'` the comment is not
    // masked, so without this a directive would be reported as prose by the rules it disables.
    const commentRange = commentRanges.find((range) => anchor >= range.start && anchor < range.end);
    if (commentRange !== undefined) {
      suppressions.push(record(diagnostic, DIRECTIVE_TEXT_REASON, commentRange));
      continue;
    }

    const directive = directiveFor(directives, diagnostic.ruleId, anchor);
    if (directive === undefined) {
      kept.push(diagnostic);
      continue;
    }
    // Counted as used even when the claim is refused below: the directive did point at a real
    // finding, so `suppression-unused` would be a second, misleading complaint about it.
    claimed.add(directive);

    const refusal = refuseInAdmonition(
      diagnostic.ruleId,
      admonitionAt(doc, anchor),
      allowInAdmonitions,
    );
    if (refusal !== undefined) {
      notices.push(refusal);
      kept.push(diagnostic);
      continue;
    }
    suppressions.push(record(diagnostic, directive.reason, directive.directiveRange));
  }

  for (const directive of directives) {
    if (claimed.has(directive)) continue;
    notices.push(
      notice('suppression-unused', 'info', 'A suppression directive claimed no finding', {
        line: positionAt(lineStarts, directive.directiveRange.start).line,
      }),
    );
  }

  if (suppressions.length > 0) {
    notices.push(
      notice(
        'suppressions-applied',
        'info',
        `${suppressions.length} finding(s) were withheld by an inline suppression directive`,
        { count: suppressions.length },
      ),
    );
  }

  return { diagnostics: kept, suppressions, notices };
}

/**
 * The notice for a claim refused inside a safety admonition, or `undefined` when the claim stands.
 *
 * Exported because candidates are filtered out before adjudication, in the analysis layer, and that
 * path is the *stronger* silencing of the two: the passage is not merely left unreported, it is
 * never judged at all. It has to refuse on exactly these terms and say so in exactly these words,
 * or the refusal becomes bypassable by aiming a directive at a candidate instead of a diagnostic.
 */
export function refuseInAdmonition(
  ruleId: string,
  admonition: AdmonitionKind,
  allowInAdmonitions: boolean,
): RunNotice | undefined {
  if (allowInAdmonitions || !GUARDED_ADMONITIONS.has(admonition)) return undefined;
  return notice(
    'suppression-refused-in-admonition',
    'warning',
    `A suppression of "${ruleId}" was refused inside a ${admonition} admonition and the finding was kept`,
    { ruleId, admonition },
  );
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function* directiveComments(
  doc: AnalysedDocument,
  lineStarts: readonly number[],
): Generator<DirectiveComment> {
  for (const match of doc.text.matchAll(COMMENT_RE)) {
    const body = (match[1] ?? '').trim();
    if (!body.startsWith(KEYWORD_PREFIX)) continue;
    const range = { start: match.index, end: match.index + match[0].length };
    if (!isLiveDirectiveComment(doc, range)) continue;
    const keyword = /^\S+/.exec(body)?.[0] ?? '';
    yield {
      directiveRange: range,
      keyword,
      rest: body.slice(keyword.length),
      line: positionAt(lineStarts, match.index).line,
    };
  }
}

/** Spans of every live comment that opens with the keyword prefix, well formed or not. */
function directiveCommentRanges(doc: AnalysedDocument): SourceRange[] {
  const out: SourceRange[] = [];
  for (const match of doc.text.matchAll(COMMENT_RE)) {
    if (!(match[1] ?? '').trim().startsWith(KEYWORD_PREFIX)) continue;
    const range = { start: match.index, end: match.index + match[0].length };
    if (isLiveDirectiveComment(doc, range)) out.push(range);
  }
  return out;
}

/**
 * Whether a comment is a directive the document is *giving* rather than one it is *showing*.
 *
 * Documentation for this feature has to be able to quote its own syntax, and before this every such
 * sample was parsed as live — `docs/suppression.md` suppressed findings in any document that
 * included it. Two shapes have to be excluded, and the pass order in `protected-regions.ts` means
 * they present differently: `fencedCodePass` runs *before* `htmlCommentPass`, so a fenced sample is
 * masked and never becomes a `comment` region at all; `inlineCodePass` and `indentedCodePass` run
 * *after* it, so those samples do become `comment` regions but sit inside a wider opaque region that
 * claimed the span. Hence both tests: a comment region of exactly this span must exist, and nothing
 * opaque may enclose it.
 *
 * `format: 'text'` has no comment pass at all — a comment there is ordinary prose — so the raw scan
 * stands and every match is live.
 */
function isLiveDirectiveComment(doc: AnalysedDocument, range: SourceRange): boolean {
  if (doc.format !== 'markdown') return true;
  let recognised = false;
  for (const region of doc.protectedRegions) {
    if (
      region.kind === 'comment' &&
      region.range.start === range.start &&
      region.range.end === range.end
    ) {
      recognised = true;
      continue;
    }
    if (region.opaque && region.range.start <= range.start && region.range.end >= range.end) {
      return false;
    }
  }
  return recognised;
}

/** `undefined` when the directive carries no reason, which makes it inert. */
function parseRuleIdsAndReason(
  rest: string,
): { ruleIds: readonly string[]; reason: string } | undefined {
  const separator = rest.indexOf(REASON_SEPARATOR);
  if (separator < 0) return undefined;
  const reason = rest.slice(separator + REASON_SEPARATOR.length).trim();
  if (reason.length === 0) return undefined;
  const ruleIds = rest
    .slice(0, separator)
    // Brackets are tolerated so that a reader who copies the documented shape literally is not
    // silently left with a directive that names a rule id of "[unapproved-vocabulary".
    .replace(/[[\]]/g, ' ')
    .split(/[,\s]+/)
    .filter((id) => id.length > 0);
  return { ruleIds, reason };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The whole of the next eligible line after the line holding `offset`, terminator included.
 *
 * Blank lines are skipped because a blank line between an HTML comment and the paragraph it
 * annotates is ordinary Markdown formatting, and directive-only lines are skipped so that
 * directives stack — one line of prose, one directive per rule id and reason.
 */
function nextEligibleLineRange(
  text: string,
  lineStarts: readonly number[],
  directiveLines: ReadonlySet<number>,
  offset: number,
): SourceRange {
  const line = positionAt(lineStarts, offset).line;
  for (let index = line; index < lineStarts.length; index += 1) {
    const start = lineStarts[index];
    if (start === undefined) break;
    if (directiveLines.has(index + 1)) continue;
    const end = lineStarts[index + 1] ?? text.length;
    if (text.slice(start, end).trim().length === 0) continue;
    return { start, end };
  }
  // Nothing left to claim. An empty span claims nothing and surfaces as `suppression-unused`.
  return { start: text.length, end: text.length };
}

/** 1-based numbers of the lines whose entire content is one directive comment. */
function directiveOnlyLines(text: string, lineStarts: readonly number[]): Set<number> {
  const out = new Set<number>();
  for (let index = 0; index < lineStarts.length; index += 1) {
    const start = lineStarts[index];
    if (start === undefined) continue;
    const end = lineStarts[index + 1] ?? text.length;
    const trimmed = text.slice(start, end).replace(BLOCKQUOTE_PREFIX, '').trim();
    const inner = /^<!--([\s\S]*?)-->$/.exec(trimmed)?.[1];
    if (inner !== undefined && inner.trim().startsWith(KEYWORD_PREFIX)) out.add(index + 1);
  }
  return out;
}

/** The safety register of the block holding `offset`; `'none'` when no block does. */
function admonitionAt(doc: AnalysedDocument, offset: number): AdmonitionKind {
  for (const block of doc.blocks) {
    if (offset >= block.range.start && offset < block.range.end) return block.admonition;
  }
  return 'none';
}

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

function record(
  diagnostic: Diagnostic,
  reason: string,
  directiveRange: SourceRange,
): SuppressionRecord {
  return {
    ruleId: diagnostic.ruleId,
    category: diagnostic.category,
    range: diagnostic.range,
    message: diagnostic.message,
    reason,
    directiveRange,
  };
}

function notice(
  code: string,
  level: RunNotice['level'],
  message: string,
  detail: Readonly<Record<string, string | number | boolean>>,
): RunNotice {
  const line = detail['line'];
  return {
    code,
    level,
    message: typeof line === 'number' ? `${message} (line ${line}).` : `${message}.`,
    detail,
  };
}

function unclosedRange(line: number): RunNotice {
  return notice(
    'suppression-unclosed-range',
    'warning',
    'A suppression range was never ended and runs to the next range or the end of the document',
    { line },
  );
}
