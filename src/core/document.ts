import {
  defaultProtectedRegionOptions,
  extractProtectedRegions,
  opaqueRangesOf,
  type ProtectedRegionOptions,
} from './protected-regions.js';
import { segmentSentences } from './segmentation.js';
import { defaultStructureOptions, scanBlocks, type StructureOptions } from './structure.js';
import {
  computeLineStarts,
  maskRanges,
  mergeRanges,
  normalizeLineEndings,
  positionAt,
  rangesOverlap,
  tokenizeWords,
  trimRange,
} from './text.js';
import type {
  AnalysedDocument,
  ProtectedRegion,
  ProtectedRegionKind,
  Sentence,
  SourceDocument,
  SourceRange,
  TextBlock,
  Word,
} from './types.js';

/**
 * Protected kinds that are pure markup. They must stay visible while blocks are being scanned
 * (the scanner needs the markers to find blocks) and they contribute no words.
 */
export const STRUCTURAL_MARKER_KINDS: ReadonlySet<ProtectedRegionKind> = new Set([
  'list-marker',
  'heading-marker',
  'blockquote-marker',
  'table-markup',
  'emphasis-marker',
  'footnote-marker',
]);

/**
 * Protected kinds a reader still has to read. Each occurrence counts as exactly one word for
 * sentence-length limits but is never matched against a vocabulary list or rewritten.
 */
const CONTENT_BEARING_KINDS: ReadonlySet<ProtectedRegionKind> = new Set([
  'inline-code',
  'url',
  'autolink',
  'email',
  'file-path',
  'shell-command',
  'config-fragment',
  'math',
  'placeholder',
  'numeric-expression',
  'identifier',
  'api-name',
  'field-name',
  'constant',
  'product-identifier',
  'quoted-literal',
  'credential',
  'approved-term',
]);

function equalStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface AnalyseOptions {
  readonly protectedRegions?: Partial<ProtectedRegionOptions>;
  readonly structure?: Partial<StructureOptions>;
  /**
   * Blocks to use instead of `scanBlocks()`'s own regex-driven scan.
   *
   * `core` may not import `src/reader/` — the module boundary that exists specifically so a real
   * parser's dependency (`@textlint/markdown-to-ast`, which has "textlint" in its own package name)
   * never lands where `core`'s "imports no textlint package" rule would reject it. Nothing here
   * calls a reader; this option exists so `src/analysis/analyse.ts`, which is allowed to import
   * `reader`, can supply blocks derived from one. Every other caller of `analyseDocument` — there
   * are eight outside `analysis` today — omits this and gets exactly today's `scanBlocks()` output,
   * unaffected.
   */
  readonly blocks?: readonly TextBlock[];
  /** Source-bound protected-region work prepared once by the production analysis layer. */
  readonly preparation?: DocumentPreparation;
}

export interface DocumentPreparation {
  readonly sourceText: string;
  readonly format: SourceDocument['format'];
  readonly protectedOptions: ProtectedRegionOptions;
  readonly detectionText: string;
  readonly regions: readonly ProtectedRegion[];
}

/**
 * The one formula for merging a document's format with caller-supplied protected-region options.
 * Shared by {@link prepareDocument} (which uses the result) and {@link analyseDocument}'s
 * preparation-ownership check (which only needs it to compare against an already-prepared value) —
 * a hand-duplicated copy of this formula in the latter would drift from the former unnoticed if a
 * field were ever added here.
 */
function mergedProtectedRegionOptions(
  format: SourceDocument['format'],
  options: Partial<ProtectedRegionOptions> = {},
): ProtectedRegionOptions {
  return {
    ...defaultProtectedRegionOptions,
    format,
    ...options,
    approvedTerms: [...(options.approvedTerms ?? defaultProtectedRegionOptions.approvedTerms)],
    extraPatterns: [...(options.extraPatterns ?? defaultProtectedRegionOptions.extraPatterns)],
  };
}

export function prepareDocument(
  doc: SourceDocument,
  options: Partial<ProtectedRegionOptions> = {},
): DocumentPreparation {
  const protectedOptions = mergedProtectedRegionOptions(doc.format, options);
  const detectionText = normalizeLineEndings(doc.text);
  return {
    sourceText: doc.text,
    format: doc.format,
    protectedOptions,
    detectionText,
    regions: extractProtectedRegions(detectionText, protectedOptions),
  };
}

/**
 * Mask used for block scanning: content regions masked, structural markers left visible.
 */
export function buildStructuralMask(text: string, regions: readonly ProtectedRegion[]): string {
  const ranges = regions
    .filter((r) => r.opaque && !STRUCTURAL_MARKER_KINDS.has(r.kind))
    .map((r) => r.range);
  return maskRanges(text, mergeRanges(ranges));
}

class AnalysedDocumentImpl implements AnalysedDocument {
  readonly #lineStarts: readonly number[];
  readonly #opaqueRanges: readonly SourceRange[];

  constructor(
    readonly id: string,
    readonly format: SourceDocument['format'],
    readonly text: string,
    readonly protectedRegions: readonly ProtectedRegion[],
    readonly blocks: readonly TextBlock[],
    readonly sentences: readonly Sentence[],
    readonly maskedText: string,
    opaqueRanges: readonly SourceRange[],
    readonly path?: string,
  ) {
    this.#lineStarts = computeLineStarts(text);
    this.#opaqueRanges = opaqueRanges;
  }

  isProtected(range: SourceRange): boolean {
    return this.#opaqueRanges.some((r) => rangesOverlap(r, range));
  }

  positionAt(offset: number): { line: number; column: number } {
    return positionAt(this.#lineStarts, offset);
  }
}

/**
 * Turn raw text into an {@link AnalysedDocument}.
 *
 * Pipeline, in order:
 * 1. extract protected regions;
 * 2. build the structural mask and scan prose blocks;
 * 3. build the full mask and segment each block into sentences;
 * 4. tokenise words from masked text and splice in one synthetic word per content-bearing
 *    protected region.
 *
 * Every range produced is an absolute offset into `text`. No stage rewrites the text, so an
 * offset obtained at any stage remains valid for the original source.
 */
export function analyseDocument(
  doc: SourceDocument,
  options: AnalyseOptions = {},
): AnalysedDocument {
  const structureOptions: StructureOptions = {
    ...defaultStructureOptions,
    format: doc.format,
    ...options.structure,
  };

  // Detection runs against a copy whose CRLF carriage returns are spaces. Length is preserved, so
  // every range is equally valid against `doc.text`, which is what all `raw` slices come from.
  //
  // The ownership check below only applies when a caller supplied its own `preparation` (the
  // production analysis layer, reusing one `prepareDocument` call across every rule for a
  // document): only then can it possibly mismatch `doc`/`options.protectedRegions`. When this
  // function computes `preparation` itself, on the line right above, it is by construction built
  // from the very `doc`/`options.protectedRegions` being checked against — recomputing and
  // comparing on every call added the cost of the check to the common (no-reuse) path for a result
  // already guaranteed by construction.
  const preparation = options.preparation ?? prepareDocument(doc, options.protectedRegions);
  if (options.preparation !== undefined) {
    const expectedProtectedOptions = mergedProtectedRegionOptions(
      doc.format,
      options.protectedRegions,
    );
    const preparedOptions = preparation.protectedOptions;
    if (
      preparation.sourceText !== doc.text ||
      preparation.format !== doc.format ||
      preparedOptions.format !== expectedProtectedOptions.format ||
      !equalStringArrays(preparedOptions.approvedTerms, expectedProtectedOptions.approvedTerms) ||
      !equalStringArrays(preparedOptions.extraPatterns, expectedProtectedOptions.extraPatterns)
    ) {
      throw new Error('Document preparation does not belong to this source and configuration.');
    }
  }
  const { detectionText, regions } = preparation;
  const opaqueRanges = opaqueRangesOf(regions);
  const structuralMask = buildStructuralMask(detectionText, regions);
  const fullMask = maskRanges(detectionText, opaqueRanges);
  const blocks = options.blocks ?? scanBlocks(doc.text, structuralMask, structureOptions);

  const contentRegions = regions.filter((r) => r.opaque && CONTENT_BEARING_KINDS.has(r.kind));

  const sentences: Sentence[] = [];
  let counter = 0;
  for (const block of blocks) {
    const blockMasked = fullMask.slice(block.range.start, block.range.end);
    for (const rawRange of segmentSentences(blockMasked, block.range.start)) {
      const range = trimRange(fullMask, rawRange);
      if (range.end <= range.start) continue;
      const masked = fullMask.slice(range.start, range.end);
      if (masked.replace(/[\s�]/g, '').length === 0) continue;
      counter += 1;
      sentences.push({
        id: `s${counter}`,
        blockId: block.id,
        range,
        raw: doc.text.slice(range.start, range.end),
        masked,
        mode: block.mode,
        admonition: block.admonition,
        words: buildWords(doc.text, masked, range, contentRegions),
      });
    }
  }

  return new AnalysedDocumentImpl(
    doc.id,
    doc.format,
    doc.text,
    regions,
    blocks,
    sentences,
    fullMask,
    opaqueRanges,
    doc.path,
  );
}

function buildWords(
  text: string,
  masked: string,
  range: SourceRange,
  contentRegions: readonly ProtectedRegion[],
): Word[] {
  const words: Word[] = tokenizeWords(masked, range.start);
  for (const region of contentRegions) {
    if (region.range.start >= range.end || region.range.end <= range.start) continue;
    const start = Math.max(region.range.start, range.start);
    const end = Math.min(region.range.end, range.end);
    if (end <= start) continue;
    const slice = text.slice(start, end);
    words.push({
      range: { start, end },
      text: slice,
      lower: slice.toLowerCase(),
      protectedKind: region.kind,
    });
  }
  words.sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end);
  return words;
}

/** Words that carry prose meaning: protected tokens excluded. */
export function proseWords(words: readonly Word[]): Word[] {
  return words.filter((w) => w.protectedKind === undefined);
}
