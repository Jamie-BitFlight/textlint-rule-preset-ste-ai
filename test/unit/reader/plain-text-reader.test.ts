import { describe, expect, it } from 'vite-plus/test';
import { readPlainTextUnitsSync } from '../../../src/reader/plain-text-reader.js';
import type { TextUnit } from '../../../src/reader/types.js';

/**
 * `readPlainTextUnitsSync` — the simplest reader for `format: 'text'`. No parser: `format: 'text'`
 * has no structure beyond blank-line-separated paragraphs, which is exactly what
 * `src/core/structure.ts`'s `format === 'text'` branch already does.
 */

function read(text: string): TextUnit[] {
  return readPlainTextUnitsSync({ id: 't', format: 'text', text });
}

function assertRoundTrips(text: string, units: readonly TextUnit[]): void {
  for (const unit of units) {
    expect(text.slice(unit.range.start, unit.range.end), unit.id).toBe(unit.text);
  }
}

describe('readPlainTextUnitsSync', () => {
  it('yields one unit for a single paragraph', () => {
    const text = 'Prior to installation, remove the bracket.\n';
    const units = read(text);
    assertRoundTrips(text, units);
    expect(units).toHaveLength(1);
    expect(units[0]?.kind).toBe('paragraph');
    expect(units[0]?.text).toBe('Prior to installation, remove the bracket.');
    expect(units[0]?.depth).toBe(0);
    expect(units[0]?.admonition).toBe('none');
  });

  it('splits on a blank line into two units with real offsets', () => {
    const text = ['First paragraph.', '', 'Second paragraph.', ''].join('\n');
    const units = read(text);
    assertRoundTrips(text, units);
    expect(units.map((u) => u.text)).toEqual(['First paragraph.', 'Second paragraph.']);
    expect(units[1]?.range.start).toBe(text.indexOf('Second paragraph.'));
  });

  it('skips multiple consecutive blank lines without producing an empty unit', () => {
    const text = ['First paragraph.', '', '', '', 'Second paragraph.', ''].join('\n');
    const units = read(text);
    assertRoundTrips(text, units);
    expect(units.map((u) => u.text)).toEqual(['First paragraph.', 'Second paragraph.']);
  });

  it('classifies mode the same way the markdown reader does', () => {
    const text = ['Remove the bracket.', '', 'The bracket is removed by the technician.', ''].join(
      '\n',
    );
    const units = read(text);
    expect(units[0]?.mode).toBe('procedural');
    expect(units[1]?.mode).toBe('descriptive');
  });

  it('gives every unit a distinct id', () => {
    const text = ['One.', '', 'Two.', '', 'Three.', ''].join('\n');
    const units = read(text);
    expect(new Set(units.map((u) => u.id)).size).toBe(units.length);
  });

  it('produces nothing for a blank document', () => {
    const units = read('\n\n\n');
    expect(units).toEqual([]);
  });

  it('has `masked` equal to `text`: plain text has no per-line markup to mask', () => {
    const text = 'Prose.\n';
    const units = read(text);
    expect(units[0]?.masked).toBe(units[0]?.text);
  });
});
