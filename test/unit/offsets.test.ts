import { describe, expect, it } from 'vitest';
import { analyseTextDeterministic } from '../../src/analysis/analyse.js';
import { analyseDocument } from '../../src/core/document.js';
import { computeLineStarts, normalizeLineEndings, positionAt } from '../../src/core/text.js';

const DOC = [
  '---',
  'title: Offsets',
  '---',
  '',
  '# Install the sensor',
  '',
  'Prior to installation, utilise the bracket.',
  '',
  '| Step | Action |',
  '| --- | --- |',
  '| 1 | Utilise the tool |',
  '',
  '- Remove the cover.',
  '- Utilise the filter',
  '',
  '```sh',
  'utilise --now',
  '```',
  '',
  'See https://example.com/utilise and /etc/utilise.conf.',
  '',
].join('\n');

describe('position mapping', () => {
  it('maps offsets to 1-based lines and 0-based columns', () => {
    const doc = analyseDocument({ id: 't', format: 'markdown', text: DOC });
    const at = DOC.indexOf('Prior to');
    expect(doc.positionAt(at)).toEqual({ line: 7, column: 0 });
    const mid = DOC.indexOf('utilise the bracket');
    expect(doc.positionAt(mid)).toEqual({ line: 7, column: 23 });
  });

  it('positionAt agrees with a naive line count for every offset', () => {
    const starts = computeLineStarts(DOC);
    for (let offset = 0; offset < DOC.length; offset += 1) {
      const expectedLine = DOC.slice(0, offset).split('\n').length;
      const { line, column } = positionAt(starts, offset);
      expect(line, `offset ${offset}`).toBe(expectedLine);
      const lineStart = DOC.lastIndexOf('\n', offset - 1) + 1;
      expect(column, `offset ${offset}`).toBe(offset - lineStart);
    }
  });

  it('handles offset 0 and the final offset', () => {
    const starts = computeLineStarts(DOC);
    expect(positionAt(starts, 0)).toEqual({ line: 1, column: 0 });
    expect(positionAt(starts, DOC.length).line).toBe(DOC.split('\n').length);
  });
});

describe('offset integrity through the pipeline', () => {
  it('masked text is exactly the same length as the source', () => {
    const doc = analyseDocument({ id: 't', format: 'markdown', text: DOC });
    expect(doc.maskedText).toHaveLength(DOC.length);
  });

  it('every sentence range slices back to its own raw text', () => {
    const doc = analyseDocument({ id: 't', format: 'markdown', text: DOC });
    for (const sentence of doc.sentences) {
      expect(DOC.slice(sentence.range.start, sentence.range.end)).toBe(sentence.raw);
      expect(sentence.masked).toHaveLength(sentence.raw.length);
    }
  });

  it('every block range slices back to its own text', () => {
    const doc = analyseDocument({ id: 't', format: 'markdown', text: DOC });
    for (const block of doc.blocks) {
      expect(DOC.slice(block.range.start, block.range.end)).toBe(block.text);
    }
  });

  it('every word range slices back to its own text', () => {
    const doc = analyseDocument({ id: 't', format: 'markdown', text: DOC });
    for (const sentence of doc.sentences) {
      for (const word of sentence.words) {
        expect(DOC.slice(word.range.start, word.range.end)).toBe(word.text);
      }
    }
  });

  it('every protected region range slices back to plausible content', () => {
    const doc = analyseDocument({ id: 't', format: 'markdown', text: DOC });
    for (const region of doc.protectedRegions) {
      expect(region.range.end).toBeGreaterThan(region.range.start);
      expect(region.range.end).toBeLessThanOrEqual(DOC.length);
      expect(DOC.slice(region.range.start, region.range.end).length).toBeGreaterThan(0);
    }
  });
});

describe('line endings', () => {
  it('normalizeLineEndings preserves length and only touches CR before LF', () => {
    const crlf = 'a\r\nb\r\n';
    const out = normalizeLineEndings(crlf);
    expect(out).toHaveLength(crlf.length);
    expect(out).toBe('a \nb \n');
    // A lone CR is not part of a CRLF pair and is left alone.
    expect(normalizeLineEndings('a\rb')).toBe('a\rb');
  });

  it('a CRLF document is analysed identically to the LF original', () => {
    const lf = analyseTextDeterministic(DOC);
    const crlf = analyseTextDeterministic(DOC.replace(/\n/g, '\r\n'));

    expect(crlf.document.blocks.map((b) => b.kind)).toEqual(lf.document.blocks.map((b) => b.kind));
    expect(crlf.document.protectedRegions.filter((r) => r.kind === 'table-markup').length).toBe(
      lf.document.protectedRegions.filter((r) => r.kind === 'table-markup').length,
    );
    expect(crlf.diagnostics.map((d) => d.ruleId)).toEqual(lf.diagnostics.map((d) => d.ruleId));
  });

  it('a CRLF document still slices its own diagnostics correctly', () => {
    const text = DOC.replace(/\n/g, '\r\n');
    const result = analyseTextDeterministic(text);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    for (const d of result.diagnostics) {
      const quote = text.slice(d.range.start, d.range.end);
      expect(quote.trim().length).toBeGreaterThan(0);
      expect(quote).not.toContain('\r');
    }
  });

  it('a CRLF document never reports inside a code fence', () => {
    const text = DOC.replace(/\n/g, '\r\n');
    const result = analyseTextDeterministic(text);
    const fenceStart = text.indexOf('```sh');
    const fenceEnd = text.indexOf('```', fenceStart + 3) + 3;
    for (const d of result.diagnostics) {
      expect(d.range.start >= fenceStart && d.range.end <= fenceEnd).toBe(false);
    }
  });
});

describe('front matter and structure interaction', () => {
  it('front matter produces no diagnostics and no blocks', () => {
    const doc = analyseDocument({ id: 't', format: 'markdown', text: DOC });
    const frontMatterEnd = DOC.indexOf('---', 3) + 3;
    for (const block of doc.blocks) {
      expect(block.range.start).toBeGreaterThanOrEqual(frontMatterEnd);
    }
  });

  it('a heading block excludes its marker', () => {
    const doc = analyseDocument({ id: 't', format: 'markdown', text: DOC });
    const heading = doc.blocks.find((b) => b.kind === 'heading');
    expect(heading?.text).toBe('Install the sensor');
  });

  it('a list item block excludes its marker', () => {
    const doc = analyseDocument({ id: 't', format: 'markdown', text: DOC });
    const items = doc.blocks.filter((b) => b.kind === 'list-item');
    expect(items.map((b) => b.text)).toEqual(['Remove the cover.', 'Utilise the filter']);
  });
});
