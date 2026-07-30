import { STRUCTURAL_MARKER_KINDS } from './document.js';
import { detectAdmonition, isAdmonitionLabelLine, isBareAdmonitionOpener } from './structure.js';
import { computeLineStarts, positionAt } from './text.js';
import type {
  AdmonitionKind,
  AnalysedDocument,
  Diagnostic,
  RunNotice,
  SourceRange,
  SuppressionDirective,
  SuppressionRecord,
  TextBlock,
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
  const commentRanges = directiveCommentRanges(doc);
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
      // `ste-ai-ignore-end` takes no rule ids and no reason. A typo that appends one — most
      // plausibly a rule id, expecting it to scope the close — must not silently close the range:
      // leaving it open is the safer failure, since it surfaces as `suppression-unclosed-range`
      // rather than ending the region one comment early with nothing to say why.
      if (comment.rest.trim().length > 0) {
        notices.push(
          notice(
            'suppression-malformed',
            'warning',
            `"${comment.keyword}" takes no rule ids or reason and was not treated as a terminator`,
            { line: comment.line },
          ),
        );
        continue;
      }
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
        range: nextBlockRange(doc, commentRanges, comment.directiveRange),
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
  return { directives, notices, commentRanges };
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
  /**
   * Candidates an earlier stage already refused to suppress inside a safety admonition, and
   * already reported.
   *
   * A refused candidate is kept and proceeds to adjudication, so the diagnostic it produces
   * reaches this function and is matched again by the same directive — without this, the same
   * refusal is reported a second time for what is, to a reader, one decision about one passage.
   * Identity is `(ruleId, range)`, which is what `directiveFor` itself matches on.
   */
  readonly alreadyRefused?: readonly { readonly ruleId: string; readonly range: SourceRange }[];
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
  const alreadyRefused = input.alreadyRefused ?? [];

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
      // An earlier stage may have refused this exact candidate already and reported it there —
      // the diagnostic it produced is not a second decision, so it must not become a second notice.
      const alreadyReported = alreadyRefused.some(
        (entry) =>
          entry.ruleId === diagnostic.ruleId &&
          entry.range.start === diagnostic.range.start &&
          entry.range.end === diagnostic.range.end,
      );
      if (!alreadyReported) notices.push(refusal);
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
 * The span a `next-line` directive claims: the remainder of the first block that ends after it.
 *
 * A **block**, not a line. This linter judges wording, and rewrapping a paragraph is not an edit to
 * its wording — but under line-claiming, reflowing a paragraph so that the offending word moved to
 * the second line silently revoked the suppression and reported the finding. Block boundaries come
 * from blank lines and structure, so they survive a rewrap.
 *
 * The chosen block is the first one *ending* after the directive rather than the first one starting
 * after it. A directive written immediately above its paragraph, with no blank line — the idiom
 * every user brings from eslint — is absorbed into that paragraph's own block, which therefore
 * starts at the comment rather than after it. Clamping the span to begin at the end of the comment
 * is what stops such a directive from also claiming prose written above it.
 *
 * Blocks lying wholly inside a directive comment are skipped: in `format: 'text'` a comment is not
 * masked, so a directive followed by a blank line is a paragraph in its own right.
 *
 * The keyword is still `ste-ai-ignore-next-line`; the idiom is what users expect to type, and the
 * precision belongs in the documentation rather than in a name nobody would guess.
 */
function nextBlockRange(
  doc: AnalysedDocument,
  commentRanges: readonly SourceRange[],
  directiveRange: SourceRange,
): SourceRange {
  let chosen: TextBlock | undefined;
  for (const block of doc.blocks) {
    if (block.range.end <= directiveRange.end) continue;
    const inComment = commentRanges.some(
      (comment) => block.range.start >= comment.start && block.range.end <= comment.end,
    );
    if (inComment) continue;
    // Earliest block wins; where two share a start the narrower one does, so a nested block is
    // never widened into its container.
    if (
      chosen === undefined ||
      block.range.start < chosen.range.start ||
      (block.range.start === chosen.range.start && block.range.end < chosen.range.end)
    ) {
      chosen = block;
    }
  }
  // Nothing left to claim. An empty span claims nothing and surfaces as `suppression-unused`.
  const nothing = { start: doc.text.length, end: doc.text.length };
  if (chosen === undefined) return nothing;
  const start = Math.max(chosen.range.start, directiveRange.end);
  if (!gapIsClear(doc, commentRanges, directiveRange.end, start, chosen.admonition)) return nothing;
  return { start, end: chosen.range.end };
}

/**
 * Whether nothing but skippable material lies between a directive and the block it would claim.
 *
 * A claim must not travel. Content that yields no block of its own — a fenced or indented sample,
 * an HTML block, a paragraph made entirely of protected content — was stepped over in silence, and
 * the directive then withheld a finding in a paragraph the author had never pointed at.
 *
 * Four things are skippable. Whitespace, so that the reflow invariance of block claiming survives.
 * Live directive comments, so that stacked directives keep claiming the same block. Structural
 * markers — a list bullet, a heading's hashes, a blockquote's arrow — because a block's range
 * begins after its own marker, so the marker is the introduction to the claimed block rather than
 * content standing between the author and it. And, when the chosen block carries an admonition, the
 * marker line that opened that register: a GFM alert (`> [!WARNING]`), an RST/MyST directive
 * (`.. warning::`), an mkdocs container (`!!! warning`) or an AsciiDoc label (`[WARNING]`) is
 * exactly like a list bullet or a blockquote arrow — structure that introduces the claimed block,
 * not prose the directive stepped over. Without this, a directive written above an admonition never
 * claims it: the marker line is neither whitespace nor a structural-region kind, so the claim was
 * silently voided and the safety-admonition refusal (which depends on the claim reaching the
 * diagnostic in the first place) never had anything to refuse.
 */
function gapIsClear(
  doc: AnalysedDocument,
  commentRanges: readonly SourceRange[],
  from: number,
  to: number,
  blockAdmonition: AdmonitionKind,
): boolean {
  if (to <= from) return true;

  const skippable = [
    ...commentRanges,
    ...doc.protectedRegions
      .filter((region) => STRUCTURAL_MARKER_KINDS.has(region.kind))
      .map((region) => region.range),
    ...admonitionOpenerRanges(doc.text, from, to, blockAdmonition),
  ].sort((a, b) => a.start - b.start || a.end - b.end);

  let cursor = from;
  for (const span of skippable) {
    if (span.end <= cursor || span.start >= to) continue;
    if (doc.text.slice(cursor, Math.min(span.start, to)).trim().length > 0) return false;
    cursor = Math.max(cursor, span.end);
    if (cursor >= to) return true;
  }
  return doc.text.slice(cursor, to).trim().length === 0;
}

/**
 * Spans, within `[from, to)`, of lines that only open `blockAdmonition` — the register the claimed
 * block itself carries. Matched by kind, not merely by "some admonition", so a directive is never
 * read as stepping past a *different* register's marker on its way to an unrelated block.
 */
function admonitionOpenerRanges(
  text: string,
  from: number,
  to: number,
  blockAdmonition: AdmonitionKind,
): SourceRange[] {
  if (blockAdmonition === 'none') return [];
  const out: SourceRange[] = [];
  let cursor = from;
  while (cursor < to) {
    const newline = text.indexOf('\n', cursor);
    const lineEnd = newline === -1 || newline >= to ? to : newline + 1;
    const raw = text.slice(cursor, lineEnd).replace(/\n$/, '');
    if (
      detectAdmonition(raw) === blockAdmonition &&
      (isBareAdmonitionOpener(raw) || isAdmonitionLabelLine(raw))
    ) {
      out.push({ start: cursor, end: lineEnd });
    }
    cursor = lineEnd;
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
