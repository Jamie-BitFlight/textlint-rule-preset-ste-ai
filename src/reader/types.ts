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
  /** Raw source slice for `range`. */
  readonly text: string;
  readonly mode: TextMode;
  readonly admonition: AdmonitionKind;
  /** Nesting depth — heading level, list depth, blockquote depth. Same meaning as `TextBlock.depth`. */
  readonly depth: number;
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
