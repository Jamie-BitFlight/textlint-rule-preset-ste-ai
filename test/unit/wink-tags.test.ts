import { describe, expect, it } from 'vite-plus/test';
import { buildWinkPosIndex } from '../../src/core/wink-tags.js';

function tagOf(text: string, word: string): string | undefined {
  const index = buildWinkPosIndex(text);
  const start = text.indexOf(word);
  return index.tagAt(start);
}

describe('buildWinkPosIndex', () => {
  it('tags a genuine passive participle as VERB', () => {
    expect(tagOf('The filter must be replaced every 500 hours.', 'replaced')).toBe('VERB');
    expect(tagOf('The bolts are tightened by the technician.', 'tightened')).toBe('VERB');
  });

  it('tags an irregular participle the closed PARTICIPLES list never enumerated as VERB', () => {
    // Neither "hewn" nor "forsaken" is in the old 70-entry `PARTICIPLES` list in
    // candidate-rules.ts — this demonstrates the substrate's real capability. The
    // passive-voice-candidate rule does not currently exploit this (see the "Known gap found, not
    // fixed here" note on `isPassiveParticiple` there): it deliberately keeps the old list as an
    // unchanged prerequisite shape gate, so this module's own tag-conditioning is a precision
    // filter on top of that gate, not a recall expansion beyond it.
    expect(tagOf('The gasket was hewn from raw stock.', 'hewn')).toBe('VERB');
    expect(tagOf('The report has been forsaken by the team.', 'forsaken')).toBe('VERB');
  });

  it('tags an adjectival reading as ADJ, not VERB', () => {
    // "is disabled" in this shape is the exact case the corpus's own reviewer called adjectival
    // ("states a configuration state ... describes the shipped default", httpd-mod-ssl-directive-
    // config.json) — wink-nlp resolves it the same way.
    expect(tagOf('By default the SSL Engine is disabled.', 'disabled')).not.toBe('VERB');
    expect(tagOf('The surface is clean.', 'clean')).toBe('ADJ');
    expect(tagOf('This setting is optional.', 'optional')).toBe('ADJ');
  });

  it('offsets align with plain character indices (multi-word, multi-sentence text)', () => {
    const text = 'The valve was opened by the technician. It is optional now.';
    const index = buildWinkPosIndex(text);
    expect(index.tagAt(text.indexOf('opened'))).toBe('VERB');
    expect(index.tagAt(text.indexOf('optional'))).not.toBe('VERB');
  });

  it('returns undefined for an offset that is not a token start', () => {
    const index = buildWinkPosIndex('The valve was opened.');
    expect(index.tagAt(1)).toBeUndefined();
  });
});
