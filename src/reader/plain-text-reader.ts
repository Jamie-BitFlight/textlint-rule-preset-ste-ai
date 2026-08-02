import { defaultStructureOptions, detectMode } from '../core/structure.js';
import { computeLineStarts, trimRange } from '../core/text.js';
import type { SourceDocument } from '../core/types.js';
import type { TextUnit } from './types.js';

/**
 * The simplest reader for `format: 'text'`, which has no structure beyond blank-line-separated
 * paragraphs — exactly what `src/core/structure.ts`'s `format === 'text'` branch already does. No
 * parser dependency, because plain text has nothing for a parser to recover that a blank-line scan
 * does not already give exactly.
 *
 * Synchronous — see `readMarkdownUnitsSync`'s doc comment (`src/reader/markdown-reader.ts`) for why
 * this reader has no async wrapper.
 */
export function readPlainTextUnitsSync(doc: SourceDocument): TextUnit[] {
  return splitParagraphs(doc.text);
}

function splitParagraphs(text: string): TextUnit[] {
  const lineStarts = computeLineStarts(text);
  const units: TextUnit[] = [];
  let start: number | null = null;
  let end = 0;
  let counter = 0;

  const flush = (): void => {
    if (start === null) return;
    const trimmed = trimRange(text, { start, end });
    start = null;
    // A run of lines that is entirely whitespace once trimmed carries no prose.
    if (trimmed.end <= trimmed.start) return;
    const slice = text.slice(trimmed.start, trimmed.end);
    counter += 1;
    units.push({
      id: `paragraph:${counter}:${trimmed.start}`,
      kind: 'paragraph',
      range: trimmed,
      text: slice,
      // Plain text has no per-line markup for a downstream checker to mistake for prose — no `>`,
      // no list marker, nothing this reader introduces that needs masking.
      masked: slice,
      mode: detectMode(slice, defaultStructureOptions),
      admonition: 'none',
      depth: 0,
    });
  };

  for (let i = 0; i < lineStarts.length; i += 1) {
    const lineStart = lineStarts[i];
    if (lineStart === undefined) continue;
    const lineEnd = lineStarts[i + 1] ?? text.length;
    const blank = text.slice(lineStart, lineEnd).trim().length === 0;
    if (blank) {
      flush();
    } else {
      if (start === null) start = lineStart;
      end = lineEnd;
    }
  }
  flush();
  return units;
}
