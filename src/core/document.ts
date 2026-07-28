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

export interface AnalyseOptions {
  readonly protectedRegions?: Partial<ProtectedRegionOptions>;
  readonly structure?: Partial<StructureOptions>;
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
  const protectedOptions: ProtectedRegionOptions = {
    ...defaultProtectedRegionOptions,
    format: doc.format,
    ...options.protectedRegions,
  };
  const structureOptions: StructureOptions = {
    ...defaultStructureOptions,
    format: doc.format,
    ...options.structure,
  };

  // Detection runs against a copy whose CRLF carriage returns are spaces. Length is preserved, so
  // every range is equally valid against `doc.text`, which is what all `raw` slices come from.
  const detectionText = normalizeLineEndings(doc.text);

  const regions = extractProtectedRegions(detectionText, protectedOptions);
  const opaqueRanges = opaqueRangesOf(regions);
  const structuralMask = buildStructuralMask(detectionText, regions);
  const fullMask = maskRanges(detectionText, opaqueRanges);
  const blocks = scanBlocks(doc.text, structuralMask, structureOptions);

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
