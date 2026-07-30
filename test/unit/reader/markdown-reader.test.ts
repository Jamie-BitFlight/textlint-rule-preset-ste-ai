import { describe, expect, it } from 'vitest';
import { MarkdownReader, readMarkdownUnitsSync } from '../../../src/reader/markdown-reader.js';
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

  it('carries the written ordinal of each item in an ordered list', async () => {
    // `structure-rules.ts`'s numbered-step-length check reports its message by ordinal
    // (`block.listOrdinal`) — a reader that dropped this would silently break that report.
    const text = ['5. Fifth item', '6. Sixth item', ''].join('\n');
    const units = await read(text);
    expect(units.map((u) => u.listOrdinal)).toEqual([5, 6]);
  });

  it('leaves listOrdinal undefined for an unordered list', async () => {
    const text = ['- First item', '- Second item', ''].join('\n');
    const units = await read(text);
    expect(units.every((u) => u.listOrdinal === undefined)).toBe(true);
  });

  it('gives a top-level list depth 0, matching scanBlocks’s convention', async () => {
    // scanBlocks computes list depth from indentation width (`Math.floor(markerIndent / 2)`), which
    // is 0 for an unindented top-level list. A reader that disagreed here would silently change
    // which rules a numbered step is subject to, since depth is part of a block's own identity.
    const text = ['1. First item', '2. Second item', ''].join('\n');
    const units = await read(text);
    expect(units.every((u) => u.depth === 0)).toBe(true);
  });

  it('increments list depth only for genuine nesting, not for the outermost list', async () => {
    const text = ['1. Outer item', '   1. Inner item', ''].join('\n');
    const units = await read(text);
    const outer = units.find((u) => u.text === 'Outer item');
    const inner = units.find((u) => u.text === 'Inner item');
    expect(outer?.depth).toBe(0);
    expect(inner?.depth).toBeGreaterThan(0);
  });

  it('forces a heading to descriptive mode regardless of its wording', async () => {
    // scanBlocks forces every heading to `descriptive`, unconditionally — `push()`'s
    // `kind === 'heading' ? 'descriptive' : detectMode(...)` never runs `detectMode` on a heading at
    // all. An imperative-sounding heading must not become `procedural` just because a reader
    // classifies it the same way it classifies a paragraph.
    const text = '# Remove the bracket\n\nProse follows.\n';
    const units = await read(text);
    const heading = units.find((u) => u.kind === 'heading');
    expect(heading?.mode).toBe('descriptive');
  });

  it('carries a pending admonition across a nested walk into the block that actually consumes it', async () => {
    // `pendingAdmonition` must survive a recursive call, not merely a sibling loop: an opener
    // immediately followed by a LIST has to reach the list's own first item, not be lost at the
    // recursion boundary — and, once consumed, must not still be sitting unconsumed in the outer
    // scope where it would wrongly attach to whatever paragraph comes next at the top level.
    const text = [
      '[WARNING]',
      '',
      '- First item.',
      '- Second item.',
      '',
      'Ordinary paragraph after the list.',
      '',
    ].join('\n');
    const units = await read(text);
    const first = units.find((u) => u.text === 'First item.');
    const second = units.find((u) => u.text === 'Second item.');
    const after = units.find((u) => u.text === 'Ordinary paragraph after the list.');
    expect(first?.admonition).toBe('warning');
    expect(second?.admonition).toBe('none');
    expect(after?.admonition).toBe('none');
  });

  it('carries a pending admonition into the first paragraph of a blockquote it opens', async () => {
    const text = ['[WARNING]', '', '> Quoted prose here.', ''].join('\n');
    const units = await read(text);
    expect(units[0]?.admonition).toBe('warning');
  });

  it('propagates a GFM alert marker split into its own node by an embedded HTML comment', async () => {
    // Found through the full suite, not anticipated in isolation: an HTML comment on its own line
    // inside a blockquote (the shape a suppression directive takes) makes the parser split the
    // blockquote into separate Paragraph nodes around the comment, instead of merging marker and
    // body into one node the way it does with no comment present. Once split, the marker paragraph's
    // own `.raw` no longer carries the blockquote's leading `>` (the AST already attributes that to
    // the container), so a bare-opener check written against a raw *line* (which always has the `>`)
    // needs it reconstructed, or a real GFM alert silently stops propagating past an embedded
    // comment — exactly the shape `docs/suppression.md`'s own directive syntax produces.
    const text = [
      '> [!WARNING]',
      '> <!-- ste-ai-ignore-next-line passive-voice-candidate -- reason -->',
      '> The bracket is removed by the technician.',
      '',
    ].join('\n');
    const units = await read(text);
    // The marker line must not become a unit of its own — it carries no prose.
    expect(units.map((u) => u.text)).toEqual(['The bracket is removed by the technician.']);
    expect(units[0]?.admonition).toBe('warning');
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

  it('keeps a continuation line’s own marker in text, verbatim, for a human-facing report', async () => {
    // The parser gives the whole quoted paragraph one node, and only the FIRST line's leading `>` is
    // excluded from it — a continuation line's own `>` sits mid-string. `text` is the exact source
    // slice (the round-trip invariant `assertRoundTrips` checks everywhere), so it is not this
    // reader's place to alter it — a report showing a reader what they actually wrote must show the
    // `>` they actually wrote.
    const text = ['> First line of the quote.', '> Second line of the quote.', ''].join('\n');
    const units = await read(text);
    assertRoundTrips(text, units);
    expect(units).toHaveLength(1);
    expect(units[0]?.text).toBe('First line of the quote.\n> Second line of the quote.');
  });

  it('masks a continuation line’s marker in `masked`, at the same length, never strips it', async () => {
    // This is the actual fix for the gap found while building stage 1: `>` is markup, not prose, and
    // a checker reading `masked` must not see it as if the author wrote it as a sentence-initial
    // capital-less word. Masking — not stripping — is what keeps `masked` the same length as `text`
    // and therefore offset-compatible with `range`, exactly like `Sentence.masked` elsewhere in core.
    const text = ['> First line of the quote.', '> Second line of the quote.', ''].join('\n');
    const units = await read(text);
    const unit = units[0];
    expect(unit?.masked.length).toBe(unit?.text.length);
    expect(unit?.masked).toBe('First line of the quote.\n� Second line of the quote.');
    // The masked run round-trips against `range` exactly as `text` does — only its content differs.
    expect(text.slice(unit?.range.start ?? 0, unit?.range.end ?? 0)).toBe(unit?.text);
  });

  it('leaves `masked` equal to `text` when there is no embedded marker to mask', async () => {
    const text = 'Prior to installation, remove the bracket.\n';
    const units = await read(text);
    expect(units[0]?.masked).toBe(units[0]?.text);
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

  it('exposes a synchronous core the async `read()` is a thin wrapper over', async () => {
    // `analyseDocument` (`src/core/document.ts`) is called synchronously by every existing caller,
    // and `analyseTextDeterministic` documents itself as performing no I/O — a contract dozens of
    // call sites rely on. `core` also may never import `reader` (module boundary). Wiring the reader
    // into `analysis` without breaking either of those requires a genuinely synchronous entry point
    // this reader can offer, since nothing here actually needs to be async — `parse()` and the tree
    // walk are both synchronous underneath the `AsyncIterable` the interface promises.
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
    const sync = readMarkdownUnitsSync({ id: 't', format: 'markdown', text });
    const asynchronous = await read(text);
    expect(JSON.stringify(sync)).toBe(JSON.stringify(asynchronous));
  });
});
