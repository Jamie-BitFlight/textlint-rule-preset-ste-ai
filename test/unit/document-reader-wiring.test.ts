import { describe, expect, it } from 'vite-plus/test';
import { analyseDocument } from '../../src/core/document.js';
import type { TextBlock } from '../../src/core/types.js';

/**
 * `analyseDocument`'s new `blocks` override.
 *
 * `core` must never import `reader` (module boundary — `src/reader/` exists specifically because
 * `core`'s own "no textlint package" rule would otherwise reject the parser dependency). So the
 * reader cannot be wired in from inside `core`; instead `core` accepts blocks from anywhere, and
 * `src/analysis/analyse.ts` is the one place that knows a reader exists and supplies them. Every
 * existing direct caller of `analyseDocument` (there are eight outside `analysis`) does not pass
 * `blocks` and is therefore unaffected: `scanBlocks()` still runs as the default.
 */

describe('analyseDocument blocks override', () => {
  it('uses scanBlocks by default, unchanged, when no override is supplied', () => {
    const text = 'Utilise the bracket.\n';
    const doc = analyseDocument({ id: 't', format: 'markdown', text });
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]?.text).toBe('Utilise the bracket.');
  });

  it('uses the supplied blocks instead of scanning them, verbatim', () => {
    const text = 'Utilise the bracket. Utilise the filter.\n';
    const override: TextBlock[] = [
      {
        id: 'x1',
        kind: 'paragraph',
        range: { start: 0, end: 21 },
        text: 'Utilise the bracket.',
        mode: 'procedural',
        admonition: 'none',
        depth: 0,
        inList: false,
      },
    ];
    const doc = analyseDocument({ id: 't', format: 'markdown', text }, { blocks: override });
    expect(doc.blocks).toBe(override);
    // Sentence segmentation runs over whatever blocks it is given — the second sentence, outside
    // the supplied block, is simply never seen. This is the point: the caller controls the
    // document's structure entirely once it supplies blocks.
    expect(doc.sentences).toHaveLength(1);
    expect(doc.sentences[0]?.raw).toBe('Utilise the bracket.');
  });

  it('still computes protected regions, masking, and offsets identically when blocks are overridden', () => {
    const text = 'Set `DB_PASSWORD=secret123` before starting.\n';
    const override: TextBlock[] = [
      {
        id: 'x1',
        kind: 'paragraph',
        range: { start: 0, end: text.length - 1 },
        text: text.slice(0, text.length - 1),
        mode: 'procedural',
        admonition: 'none',
        depth: 0,
        inList: false,
      },
    ];
    const withOverride = analyseDocument(
      { id: 't', format: 'markdown', text },
      { blocks: override },
    );
    const withDefault = analyseDocument({ id: 't', format: 'markdown', text });
    // Protected-region extraction and masking do not depend on which blocks were scanned — they run
    // over the whole document text independently, exactly as today.
    expect(withOverride.protectedRegions).toEqual(withDefault.protectedRegions);
    expect(withOverride.maskedText).toBe(withDefault.maskedText);
  });
});
