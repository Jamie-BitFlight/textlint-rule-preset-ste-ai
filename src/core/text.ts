import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type { SourcePosition, SourceRange, Word } from './types.js';

/** The character opaque protected regions are masked with. Never appears in real prose. */
export const MASK_CHAR = '�';

export function rangesOverlap(a: SourceRange, b: SourceRange): boolean {
  return a.start < b.end && b.start < a.end;
}

export function rangeContains(outer: SourceRange, inner: SourceRange): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

export function rangeLength(range: SourceRange): number {
  return range.end - range.start;
}

/** Merge overlapping/adjacent ranges into a minimal sorted set. */
export function mergeRanges(ranges: readonly SourceRange[]): SourceRange[] {
  const sorted = ranges.toSorted((a, b) => a.start - b.start || a.end - b.end);
  const out: SourceRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && r.start <= last.end) {
      if (r.end > last.end) out[out.length - 1] = { start: last.start, end: r.end };
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
}

/**
 * Replace every character inside `ranges` with {@link MASK_CHAR}, preserving newlines so that
 * line/column arithmetic is unaffected. Length is preserved exactly, so any index into the
 * result is a valid index into the input.
 */
export function maskRanges(text: string, ranges: readonly SourceRange[]): string {
  if (ranges.length === 0) return text;
  // Operate on UTF-16 code units so offsets stay aligned with String.prototype.slice, which is
  // what every consumer — including textlint's locator — uses.
  const buf = text.split('');
  for (const { start, end } of ranges) {
    const from = Math.max(0, start);
    const to = Math.min(buf.length, end);
    for (let i = from; i < to; i += 1) {
      if (buf[i] !== '\n' && buf[i] !== '\r') buf[i] = MASK_CHAR;
    }
  }
  return buf.join('');
}

/**
 * Replace the CR of every CRLF pair with a space.
 *
 * Length is preserved exactly, so every offset derived from the result is a valid offset into the
 * original text. This exists because the line-anchored detection patterns end in `[ \t]*$`, and in
 * a CRLF document the stray `\r` sits between the content and the `$` — which silently defeated
 * table, shell-command, reference-definition and HTML-block detection on Windows-authored files.
 * Treating the CR as trailing whitespace fixes all of them at once without an offset map.
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r(?=\n)/g, ' ');
}

/** Line start offsets, index 0 = line 1. */
export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** 1-based line, 0-based column — the textlint AST convention. */
export function positionAt(lineStarts: readonly number[], offset: number): SourcePosition {
  // A negative or past-the-end offset means an upstream range is corrupt. Returning a plausible
  // -looking position would hide that, so clamp to the document and let the caller see the edge.
  if (offset < 0) offset = 0;
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const start = lineStarts[mid];
    if (start !== undefined && start <= offset) lo = mid;
    else hi = mid - 1;
  }
  const lineStart = lineStarts[lo] ?? 0;
  return { line: lo + 1, column: offset - lineStart };
}

/**
 * Word pattern. A word starts with a letter or digit and may contain internal apostrophes,
 * hyphens, and dots that are followed by another letter or digit (so `3.5` and `e.g.` hold
 * together while a sentence-final period is excluded).
 */
const WORD_RE = /[\p{L}\p{N}](?:[\p{L}\p{N}'’]|-(?=[\p{L}\p{N}])|\.(?=[\p{L}\p{N}]))*\.?/gu;

/**
 * Tokenise words from `masked`, offsetting each range by `offset`.
 *
 * `masked` must be masked text: {@link MASK_CHAR} does not match the word pattern, so protected
 * content can never become a word. A trailing dot is kept only when the token is a known
 * abbreviation-shaped token (letters + dots), which keeps `e.g.` intact without swallowing the
 * full stop of `unit.`.
 */
export function tokenizeWords(masked: string, offset = 0): Word[] {
  const out: Word[] = [];
  for (const match of masked.matchAll(WORD_RE)) {
    let text = match[0];
    const start = match.index;
    if (text.endsWith('.') && !/^(?:[\p{L}]\.)+$/u.test(text)) {
      text = text.slice(0, -1);
    }
    if (text.length === 0) continue;
    out.push({
      range: { start: offset + start, end: offset + start + text.length },
      text,
      lower: text.toLowerCase(),
    });
  }
  return out;
}

/** Trim a range so it excludes leading/trailing whitespace in `text`. */
export function trimRange(text: string, range: SourceRange): SourceRange {
  let { start, end } = range;
  while (start < end && /\s/.test(text[start] ?? '')) start += 1;
  while (end > start && /\s/.test(text[end - 1] ?? '')) end -= 1;
  return { start, end };
}

/**
 * Stable content hash (SHA-256, hex). Deterministic across processes and platforms.
 *
 * Used only as a cache/dedup key (`SemanticTrace.contentHash`, `SemanticBroker`'s request cache,
 * `textlint/adapter.ts`'s shared-config fingerprint). Consumers treat the digest as an opaque,
 * collision-resistant string. Each part is encoded as its UTF-16 code-unit length followed by its
 * exact UTF-16LE code units. The framing preserves boundaries and lone surrogates.
 */
export function contentHashParts(parts: readonly string[]): string {
  const hash = createHash('sha256');
  const length = Buffer.allocUnsafe(8);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) throw new Error('Content-hash part disappeared during hashing.');
    length.writeBigUInt64BE(BigInt(part.length));
    hash.update(length);
    hash.update(part, 'utf16le');
  }
  return hash.digest('hex');
}

/** Variadic convenience wrapper for {@link contentHashParts}. */
export function contentHash(...parts: readonly string[]): string {
  return contentHashParts(parts);
}
