import { describe, expect, it } from 'vitest';
import { PlainTextReader } from '../../../src/reader/plain-text-reader.js';
import type { TextUnit } from '../../../src/reader/types.js';

/**
 * `PlainTextReader` — the "simplest reader that satisfies the interface", per the design note.
 * No parser: `format: 'text'` has no structure beyond blank-line-separated paragraphs, which is
 * exactly what `src/core/structure.ts`'s `format === 'text'` branch already does.
 */

const reader = new PlainTextReader();

async function read(text: string): Promise<TextUnit[]> {
  const units: TextUnit[] = [];
  for await (const unit of reader.read({ id: 't', format: 'text', text })) {
    units.push(unit);
  }
  return units;
}

function assertRoundTrips(text: string, units: readonly TextUnit[]): void {
  for (const unit of units) {
    expect(text.slice(unit.range.start, unit.range.end), unit.id).toBe(unit.text);
  }
}

describe('PlainTextReader', () => {
  it('reports the mediaType it reads', () => {
    expect(reader.mediaType).toBe('text');
  });

  it('yields one unit for a single paragraph', async () => {
    const text = 'Prior to installation, remove the bracket.\n';
    const units = await read(text);
    assertRoundTrips(text, units);
    expect(units).toHaveLength(1);
    expect(units[0]?.kind).toBe('paragraph');
    expect(units[0]?.text).toBe('Prior to installation, remove the bracket.');
    expect(units[0]?.depth).toBe(0);
    expect(units[0]?.admonition).toBe('none');
  });

  it('splits on a blank line into two units with real offsets', async () => {
    const text = ['First paragraph.', '', 'Second paragraph.', ''].join('\n');
    const units = await read(text);
    assertRoundTrips(text, units);
    expect(units.map((u) => u.text)).toEqual(['First paragraph.', 'Second paragraph.']);
    expect(units[1]?.range.start).toBe(text.indexOf('Second paragraph.'));
  });

  it('skips multiple consecutive blank lines without producing an empty unit', async () => {
    const text = ['First paragraph.', '', '', '', 'Second paragraph.', ''].join('\n');
    const units = await read(text);
    assertRoundTrips(text, units);
    expect(units.map((u) => u.text)).toEqual(['First paragraph.', 'Second paragraph.']);
  });

  it('classifies mode the same way the markdown reader does', async () => {
    const text = ['Remove the bracket.', '', 'The bracket is removed by the technician.', ''].join(
      '\n',
    );
    const units = await read(text);
    expect(units[0]?.mode).toBe('procedural');
    expect(units[1]?.mode).toBe('descriptive');
  });

  it('gives every unit a distinct id', async () => {
    const text = ['One.', '', 'Two.', '', 'Three.', ''].join('\n');
    const units = await read(text);
    expect(new Set(units.map((u) => u.id)).size).toBe(units.length);
  });

  it('is async-iterable', () => {
    const iterable = reader.read({ id: 't', format: 'text', text: 'Prose.\n' });
    expect(typeof iterable[Symbol.asyncIterator]).toBe('function');
  });

  it('produces nothing for a blank document', async () => {
    const units = await read('\n\n\n');
    expect(units).toEqual([]);
  });
});
