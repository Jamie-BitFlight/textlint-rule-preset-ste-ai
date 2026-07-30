import type {
  AdmonitionKind,
  DocumentFormat,
  SourceDocument,
  SourceRange,
  TextMode,
} from '../core/types.js';

/**
 * One reader-recognised span of the document that the checker treats as a unit of judgement.
 *
 * Deliberately close to `TextBlock` (`src/core/types.ts`), not a rewrite of it: `range`, `mode`,
 * `admonition` and `depth` carry the same meaning. What `TextBlock` does not carry, and this must,
 * is `id` as a first-class value the *reader* is answerable for — a rule previously manufactured a
 * candidate's id from a sentence counter, and "which unit failed" has to name something the reader
 * itself produced, not something a rule assembled afterward.
 */
export interface TextUnit {
  /** Stable within one `read()` call. Not stable across edits to the source — it is not a diff key. */
  readonly id: string;
  /** Reader-defined: `'paragraph' | 'heading' | 'list-item' | 'table-cell' | 'blockquote' | …`. */
  readonly kind: string;
  /** Offset into the ORIGINAL source text handed to `read()`. */
  readonly range: SourceRange;
  /** Raw source slice for `range`. Exact: `text.slice(range.start, range.end) === text` always holds. */
  readonly text: string;
  /**
   * `text` with embedded structural noise replaced by an equal-length run of U+FFFD — never
   * shorter, so `masked.length === text.length` and an index into `masked` stays a valid index into
   * `text`. Distinct from `text` for the same reason `Sentence.raw`/`Sentence.masked` are distinct
   * fields rather than one field with two meanings: a report has to be able to show what was
   * actually written, and a checker has to be able to read prose without markup arriving as if it
   * were the author's words. The one case this exists for today: a multi-line blockquote's
   * continuation line keeps its own `>` marker embedded mid-string (only the first line's marker is
   * excluded from the node), and masking it here — never stripping it — is what keeps `text` and
   * `masked` the same length and both offset-compatible with `range`.
   */
  readonly masked: string;
  readonly mode: TextMode;
  readonly admonition: AdmonitionKind;
  /** Nesting depth — heading level, list depth, blockquote depth. Same meaning as `TextBlock.depth`. */
  readonly depth: number;
  /** 1-based, the number actually written for this item in an ordered list. Same meaning as
   * `TextBlock.listOrdinal`; `undefined` for anything that is not an ordered list's item. */
  readonly listOrdinal?: number;
}

export interface DocumentReader {
  readonly mediaType: DocumentFormat;
  /**
   * Async even though every reader today is synchronous underneath. A reader for docx, or one
   * backed by a remotely-fetched document, may need real I/O to produce its next unit, and there
   * must be no second interface for that later — every caller already awaits.
   */
  read(doc: SourceDocument): AsyncIterable<TextUnit>;
}
