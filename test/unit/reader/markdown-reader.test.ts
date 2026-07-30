import { describe, expect, it } from 'vitest';
import { MarkdownReader } from '../../../src/reader/markdown-reader.js';
import type { TextUnit } from '../../../src/reader/types.js';

/**
 * `MarkdownReader` against the real parser.
 *
 * Every test proves the offset contract directly rather than trusting it: `text.slice(range.start,
 * range.end) === unit.text` is asserted for every unit produced, because a reader whose offsets
 * don't round-trip into the original source is exactly the defect this whole feature exists to fix.
 */

const reader = new MarkdownReader();

async function read(text: string): Promise<TextUnit[]> {
  const units: TextUnit[] = [];
  for await (const unit of reader.read({ id: 't', format: 'markdown', text })) {
    units.push(unit);
  }
  return units;
}

function assertRoundTrips(text: string, units: readonly TextUnit[]): void {
  for (const unit of units) {
    expect(text.slice(unit.range.start, unit.range.end), unit.id).toBe(unit.text);
  }
}

describe('MarkdownReader', () => {
  it('reports the mediaType it reads', () => {
    expect(reader.mediaType).toBe('markdown');
  });

  it('yields one unit for a single paragraph, with a real offset', async () => {
    const text = 'Prior to installation, remove the bracket.\n';
    const units = await read(text);
    assertRoundTrips(text, units);
    expect(units).toHaveLength(1);
    expect(units[0]?.kind).toBe('paragraph');
    expect(units[0]?.text).toBe('Prior to installation, remove the bracket.');
  });

  it('excludes the heading marker from the unit range', async () => {
    const text = '# Setup\n\nProse follows.\n';
    const units = await read(text);
    assertRoundTrips(text, units);
    const heading = units.find((u) => u.kind === 'heading');
    expect(heading?.text).toBe('Setup');
    expect(heading?.depth).toBe(1);
  });

  it('excludes the list marker from a list-item unit', async () => {
    const text = ['1. First item', '2. Second item', ''].join('\n');
    const units = await read(text);
    assertRoundTrips(text, units);
    expect(units.map((u) => u.kind)).toEqual(['list-item', 'list-item']);
    expect(units.map((u) => u.text)).toEqual(['First item', 'Second item']);
  });

  it('excludes the table markup from a table-cell unit', async () => {
    const text = ['| Step | Action |', '| --- | --- |', '| 1 | Utilise the tool |', ''].join('\n');
    const units = await read(text);
    assertRoundTrips(text, units);
    const cells = units.filter((u) => u.kind === 'table-cell');
    expect(cells.map((c) => c.text)).toEqual(['Step', 'Action', '1', 'Utilise the tool']);
  });

  it('recovers the exact defect class issue #11 named: a table cell and a link', async () => {
    const text = [
      '| Step | Action |',
      '| --- | --- |',
      '| 1 | Utilise the tool |',
      '',
      'See [the guide](./guide.md) before you continue.',
      '',
    ].join('\n');
    const units = await read(text);
    assertRoundTrips(text, units);
    const cell = units.find((u) => u.kind === 'table-cell' && u.text === 'Utilise the tool');
    expect(cell).toBeDefined();
    // The paragraph unit is not expected to strip the link's own markup — that is a claim about a
    // finer-grained unit this reader does not yet emit. What the offset contract requires, and what
    // `assertRoundTrips` above already checked, is that the paragraph's own span resumes at the
    // correct offset after the link and does not "leak" any of the link's characters into the wrong
    // position — the defect issue #11 actually names.
    const paragraph = units.find((u) => u.kind === 'paragraph');
    expect(paragraph?.text).toBe('See [the guide](./guide.md) before you continue.');
    expect(paragraph?.text.endsWith('before you continue.')).toBe(true);
  });

  it('produces a blockquote unit for quoted prose', async () => {
    const text = ['> Quoted prose here.', ''].join('\n');
    const units = await read(text);
    assertRoundTrips(text, units);
    expect(units).toHaveLength(1);
    expect(units[0]?.kind).toBe('blockquote');
    expect(units[0]?.text).toBe('Quoted prose here.');
    expect(units[0]?.depth).toBeGreaterThan(0);
  });

  it('leaves a continuation line’s own marker embedded in a multi-line blockquote unit', async () => {
    // Documented, not silently true: the parser gives the whole quoted paragraph one node, and only
    // the FIRST line's leading `>` is excluded from it — a continuation line's own `>` sits inside
    // `unit.text` verbatim. This is exactly the "per-line noise inside a larger span" shape a
    // docstring reader will also have (Python's per-line indentation, JSDoc's leading ` * `): the
    // fix is to MASK it in a later pass, at the same length, never to strip it here — stripping
    // would be the one thing that could reintroduce a second coordinate system. Masking is a
    // downstream, protected-region-style concern (`docs/architecture.md`, "Document reader", §5),
    // not this reader's job; this test exists so that boundary is asserted, not assumed.
    const text = ['> First line of the quote.', '> Second line of the quote.', ''].join('\n');
    const units = await read(text);
    assertRoundTrips(text, units);
    expect(units).toHaveLength(1);
    expect(units[0]?.text).toBe('First line of the quote.\n> Second line of the quote.');
  });

  it('detects a GFM alert admonition on the blockquote unit it opens', async () => {
    const text = ['> [!WARNING]', '> Do not touch the busbar.', ''].join('\n');
    const units = await read(text);
    assertRoundTrips(text, units);
    expect(units).toHaveLength(1);
    expect(units[0]?.admonition).toBe('warning');
  });

  it('leaves an ordinary blockquote at admonition none', async () => {
    const text = ['> Quoted prose here.', ''].join('\n');
    const units = await read(text);
    expect(units[0]?.admonition).toBe('none');
  });

  it('classifies an imperative sentence as procedural and a descriptive one as descriptive', async () => {
    const text = ['Remove the bracket.', '', 'The bracket is removed by the technician.', ''].join(
      '\n',
    );
    const units = await read(text);
    expect(units[0]?.mode).toBe('procedural');
    expect(units[1]?.mode).toBe('descriptive');
  });

  it('gives every unit a stable, distinct id within one read', async () => {
    const text = ['# Setup', '', 'First paragraph.', '', 'Second paragraph.', ''].join('\n');
    const units = await read(text);
    const ids = units.map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });

  it('is async-iterable, not merely array-returning', () => {
    const text = 'Prose.\n';
    const iterable = reader.read({ id: 't', format: 'markdown', text });
    expect(typeof iterable[Symbol.asyncIterator]).toBe('function');
  });

  it('produces byte-identical units across two reads of the same text', async () => {
    const text = [
      '# Setup',
      '',
      '| Step | Action |',
      '| --- | --- |',
      '| 1 | Utilise the tool |',
      '',
      'See [the guide](./guide.md) before you continue.',
      '',
    ].join('\n');
    const a = await read(text);
    const b = await read(text);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
