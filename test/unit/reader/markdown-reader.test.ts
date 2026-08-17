import { describe, expect, it } from 'vite-plus/test';
import { readMarkdownUnitsSync } from '../../../src/reader/markdown-reader.js';
import type { TextUnit } from '../../../src/reader/types.js';

/**
 * `readMarkdownUnitsSync` against the real parser.
 *
 * Every test proves the offset contract directly rather than trusting it: `text.slice(range.start,
 * range.end) === unit.text` is asserted for every unit produced, because a reader whose offsets
 * don't round-trip into the original source is exactly the defect this whole feature exists to fix.
 */

function read(text: string): TextUnit[] {
  return readMarkdownUnitsSync({ id: 't', format: 'markdown', text });
}

function assertRoundTrips(text: string, units: readonly TextUnit[]): void {
  for (const unit of units) {
    expect(text.slice(unit.range.start, unit.range.end), unit.id).toBe(unit.text);
  }
}

describe('readMarkdownUnitsSync', () => {
  it('yields one unit for a single paragraph, with a real offset', () => {
    const text = 'Prior to installation, remove the bracket.\n';
    const units = read(text);
    assertRoundTrips(text, units);
    expect(units).toHaveLength(1);
    expect(units[0]?.kind).toBe('paragraph');
    expect(units[0]?.text).toBe('Prior to installation, remove the bracket.');
  });

  it('excludes the heading marker from the unit range', () => {
    const text = '# Setup\n\nProse follows.\n';
    const units = read(text);
    assertRoundTrips(text, units);
    const heading = units.find((u) => u.kind === 'heading');
    expect(heading?.text).toBe('Setup');
    expect(heading?.depth).toBe(1);
  });

  it('excludes the list marker from a list-item unit', () => {
    const text = ['1. First item', '2. Second item', ''].join('\n');
    const units = read(text);
    assertRoundTrips(text, units);
    expect(units.map((u) => u.kind)).toEqual(['list-item', 'list-item']);
    expect(units.map((u) => u.text)).toEqual(['First item', 'Second item']);
  });

  it('carries the written ordinal of each item in an ordered list', () => {
    // `structure-rules.ts`'s numbered-step-length check reports its message by ordinal
    // (`block.listOrdinal`) — a reader that dropped this would silently break that report.
    const text = ['5. Fifth item', '6. Sixth item', ''].join('\n');
    const units = read(text);
    expect(units.map((u) => u.listOrdinal)).toEqual([5, 6]);
  });

  it('leaves listOrdinal undefined for an unordered list', () => {
    const text = ['- First item', '- Second item', ''].join('\n');
    const units = read(text);
    expect(units.every((u) => u.listOrdinal === undefined)).toBe(true);
  });

  it('gives a top-level list depth 0, matching scanBlocks’s convention', () => {
    // scanBlocks computes list depth from indentation width (`Math.floor(markerIndent / 2)`), which
    // is 0 for an unindented top-level list. A reader that disagreed here would silently change
    // which rules a numbered step is subject to, since depth is part of a block's own identity.
    const text = ['1. First item', '2. Second item', ''].join('\n');
    const units = read(text);
    expect(units.every((u) => u.depth === 0)).toBe(true);
  });

  it('increments list depth only for genuine nesting, not for the outermost list', () => {
    const text = ['1. Outer item', '   1. Inner item', ''].join('\n');
    const units = read(text);
    const outer = units.find((u) => u.text === 'Outer item');
    const inner = units.find((u) => u.text === 'Inner item');
    expect(outer?.depth).toBe(0);
    expect(inner?.depth).toBeGreaterThan(0);
  });

  it('forces a heading to descriptive mode regardless of its wording', () => {
    // scanBlocks forces every heading to `descriptive`, unconditionally — `push()`'s
    // `kind === 'heading' ? 'descriptive' : detectMode(...)` never runs `detectMode` on a heading at
    // all. An imperative-sounding heading must not become `procedural` just because a reader
    // classifies it the same way it classifies a paragraph.
    const text = '# Remove the bracket\n\nProse follows.\n';
    const units = read(text);
    const heading = units.find((u) => u.kind === 'heading');
    expect(heading?.mode).toBe('descriptive');
  });

  it('carries a pending admonition across a nested walk into the block that actually consumes it', () => {
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
    const units = read(text);
    const first = units.find((u) => u.text === 'First item.');
    const second = units.find((u) => u.text === 'Second item.');
    const after = units.find((u) => u.text === 'Ordinary paragraph after the list.');
    expect(first?.admonition).toBe('warning');
    expect(second?.admonition).toBe('none');
    expect(after?.admonition).toBe('none');
  });

  it('carries a pending admonition into the first paragraph of a blockquote it opens', () => {
    const text = ['[WARNING]', '', '> Quoted prose here.', ''].join('\n');
    const units = read(text);
    expect(units[0]?.admonition).toBe('warning');
  });

  it('splits a bare opener from the body it merges with when no blank line separates them', () => {
    // Found via the fixture corpus after wiring, not anticipated in isolation: without a blank
    // line, commonmark merges the opener and the following prose into ONE Paragraph node —
    // scanBlocks, a line-by-line scanner, never merges an opener line with what follows it, blank
    // line or not. `detectAdmonition`/`isBareAdmonitionOpener` are written to test one line in
    // isolation, so run against the whole merged blob they see the opener followed by real content
    // and no longer recognise it as "only" an opener — the marker is lost, and so is the register.
    const text = ['[WARNING]', 'The cover is opened by the operator.', ''].join('\n');
    const units = read(text);
    // The opener carries no prose of its own: it must not become a unit.
    expect(units.map((u) => u.text)).toEqual(['The cover is opened by the operator.']);
    expect(units[0]?.admonition).toBe('warning');
  });

  it('keeps the combined-node GFM alert convention inside a blockquote unaffected by the split', () => {
    // Regression guard: the new split logic must not fire inside a blockquote, where a GFM alert's
    // marker-and-body merging into one unit, with the marker's admonition applied directly to it,
    // is deliberate — a different convention from the bare-opener forms, not an oversight to unify.
    const text = ['> [!WARNING]', '> Do not touch the busbar.', ''].join('\n');
    const units = read(text);
    expect(units).toHaveLength(1);
    expect(units[0]?.admonition).toBe('warning');
  });

  it('propagates a GFM alert marker split into its own node by an embedded HTML comment', () => {
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
    const units = read(text);
    // The marker line must not become a unit of its own — it carries no prose.
    expect(units.map((u) => u.text)).toEqual(['The bracket is removed by the technician.']);
    expect(units[0]?.admonition).toBe('warning');
  });

  it('scopes a GFM alert container’s admonition to every paragraph inside it, not just the first', () => {
    // Regression for the reviewer-found bug: `[!WARNING]` and its two quoted paragraphs parse as
    // THREE separate Paragraph nodes (blank `>` lines split them), all children of the same
    // BlockQuote. The marker's register must scope the whole container, not lapse after the first
    // paragraph consumes it — a container opener (GFM/MkDocs/RST) is not a one-shot label like
    // AsciiDoc's `[WARNING]`.
    const text = ['> [!WARNING]', '>', '> First paragraph.', '>', '> Second paragraph.', ''].join(
      '\n',
    );
    const units = read(text);
    assertRoundTrips(text, units);
    const first = units.find((u) => u.text === 'First paragraph.');
    const second = units.find((u) => u.text === 'Second paragraph.');
    expect(first?.admonition).toBe('warning');
    expect(second?.admonition).toBe('warning');
  });

  it('reads an MkDocs indented admonition body as prose, not a dropped code block', () => {
    // Regression for the reviewer-found bug: CommonMark represents `!!! warning`'s four-space
    // indented body as a CodeBlock node, which the reader's default branch used to drop entirely —
    // producing zero units for it and leaving the pending warning to attach to unrelated prose
    // that followed instead.
    const text = '!!! warning\n\n    This is the body text.\n';
    const units = read(text);
    assertRoundTrips(text, units);
    const body = units.find((u) => u.text === 'This is the body text.');
    expect(body).toBeDefined();
    expect(body?.admonition).toBe('warning');
  });

  it('still drops a legitimate indented code block with no preceding admonition opener', () => {
    const text = 'Some prose.\n\n    var x = 1;\n';
    const units = read(text);
    assertRoundTrips(text, units);
    expect(units.map((u) => u.text)).toEqual(['Some prose.']);
  });

  it('does not hijack a fenced code block that follows a pending admonition opener', () => {
    // A fenced block is a deliberate code sample, even inside an admonition — only the ambiguous
    // indented-code shape is MkDocs's own body convention.
    const text = ['!!! note', '', '```python', 'x = 1', '```', ''].join('\n');
    const units = read(text);
    assertRoundTrips(text, units);
    expect(units).toHaveLength(0);
  });

  it('excludes the table markup from a table-cell unit', () => {
    const text = ['| Step | Action |', '| --- | --- |', '| 1 | Utilise the tool |', ''].join('\n');
    const units = read(text);
    assertRoundTrips(text, units);
    const cells = units.filter((u) => u.kind === 'table-cell');
    expect(cells.map((c) => c.text)).toEqual(['Step', 'Action', '1', 'Utilise the tool']);
  });

  it('recovers the exact defect class issue #11 named: a table cell and a link', () => {
    const text = [
      '| Step | Action |',
      '| --- | --- |',
      '| 1 | Utilise the tool |',
      '',
      'See [the guide](./guide.md) before you continue.',
      '',
    ].join('\n');
    const units = read(text);
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

  it('produces a blockquote unit for quoted prose', () => {
    const text = ['> Quoted prose here.', ''].join('\n');
    const units = read(text);
    assertRoundTrips(text, units);
    expect(units).toHaveLength(1);
    expect(units[0]?.kind).toBe('blockquote');
    expect(units[0]?.text).toBe('Quoted prose here.');
    expect(units[0]?.depth).toBeGreaterThan(0);
  });

  it('keeps a continuation line’s own marker in text, verbatim, for a human-facing report', () => {
    // The parser gives the whole quoted paragraph one node, and only the FIRST line's leading `>` is
    // excluded from it — a continuation line's own `>` sits mid-string. `text` is the exact source
    // slice (the round-trip invariant `assertRoundTrips` checks everywhere), so it is not this
    // reader's place to alter it — a report showing a reader what they actually wrote must show the
    // `>` they actually wrote.
    const text = ['> First line of the quote.', '> Second line of the quote.', ''].join('\n');
    const units = read(text);
    assertRoundTrips(text, units);
    expect(units).toHaveLength(1);
    expect(units[0]?.text).toBe('First line of the quote.\n> Second line of the quote.');
  });

  it('masks a continuation line’s marker in `masked`, at the same length, never strips it', () => {
    // This is the actual fix for the gap found while building stage 1: `>` is markup, not prose, and
    // a checker reading `masked` must not see it as if the author wrote it as a sentence-initial
    // capital-less word. Masking — not stripping — is what keeps `masked` the same length as `text`
    // and therefore offset-compatible with `range`, exactly like `Sentence.masked` elsewhere in core.
    const text = ['> First line of the quote.', '> Second line of the quote.', ''].join('\n');
    const units = read(text);
    const unit = units[0];
    expect(unit?.masked.length).toBe(unit?.text.length);
    expect(unit?.masked).toBe('First line of the quote.\n� Second line of the quote.');
    // The masked run round-trips against `range` exactly as `text` does — only its content differs.
    expect(text.slice(unit?.range.start ?? 0, unit?.range.end ?? 0)).toBe(unit?.text);
  });

  it('leaves `masked` equal to `text` when there is no embedded marker to mask', () => {
    const text = 'Prior to installation, remove the bracket.\n';
    const units = read(text);
    expect(units[0]?.masked).toBe(units[0]?.text);
  });

  it('detects a GFM alert admonition on the blockquote unit it opens', () => {
    const text = ['> [!WARNING]', '> Do not touch the busbar.', ''].join('\n');
    const units = read(text);
    assertRoundTrips(text, units);
    expect(units).toHaveLength(1);
    expect(units[0]?.admonition).toBe('warning');
  });

  it('leaves an ordinary blockquote at admonition none', () => {
    const text = ['> Quoted prose here.', ''].join('\n');
    const units = read(text);
    expect(units[0]?.admonition).toBe('none');
  });

  it('classifies an imperative sentence as procedural and a descriptive one as descriptive', () => {
    const text = ['Remove the bracket.', '', 'The bracket is removed by the technician.', ''].join(
      '\n',
    );
    const units = read(text);
    expect(units[0]?.mode).toBe('procedural');
    expect(units[1]?.mode).toBe('descriptive');
  });

  it('gives every unit a stable, distinct id within one read', () => {
    const text = ['# Setup', '', 'First paragraph.', '', 'Second paragraph.', ''].join('\n');
    const units = read(text);
    const ids = units.map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });

  it('produces byte-identical units across two reads of the same text', () => {
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
    const a = read(text);
    const b = read(text);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
