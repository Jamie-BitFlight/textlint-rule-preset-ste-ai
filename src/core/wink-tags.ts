import winkNLP, { type ItemToken, type PartOfSpeech } from 'wink-nlp';
import model from 'wink-eng-lite-web-model';

/**
 * POS-tagging substrate for `passive-voice-candidate`'s prototype tag-conditioned check.
 *
 * PROVENANCE: backed by `wink-nlp` plus the `wink-eng-lite-web-model` pretrained model — a real,
 * statistically trained POS tagger (universal-tagset: `VERB`, `ADJ`, `AUX`, `ADP`, …), not a
 * hand-rolled participle list. `compromise` (used elsewhere in this codebase, see
 * `src/core/pos-tags.ts`) has no passive-voice feature at all — confirmed directly, this is not
 * an oversight — so this is a separate, smaller substrate rather than a reuse of that module.
 *
 * This is explicitly a **prototype**: see the "Measured effect" note in
 * `docs/provisional-rules.md`'s `passive-voice-candidate` section for whether it is actually
 * better than the regex-plus-participle-list it can replace, not merely different.
 */

const nlp = winkNLP(model);

/** A per-text cache of `wink-nlp` POS tags, keyed by character start offset within that text. */
export interface WinkPosIndex {
  tagAt(sourceStart: number): PartOfSpeech | undefined;
}

/**
 * Tag every token of `text` and index the tag by character start offset.
 *
 * `wink-nlp`'s typed API does not expose token character offsets directly. They are reconstructed
 * by accumulating each token's `precedingSpaces` (the exact whitespace `wink-nlp` skipped before
 * the token) and its own text length in document order — verified directly against known-offset
 * test strings to land on the same positions as a straightforward index scan would.
 */
export function buildWinkPosIndex(text: string): WinkPosIndex {
  const map = new Map<number, PartOfSpeech>();
  const doc = nlp.readDoc(text);
  let offset = 0;
  doc.tokens().each((token: ItemToken) => {
    // `wink-nlp` dispatches on the exact function reference passed to `out()`, so `nlp.its.pos`/
    // `nlp.its.precedingSpaces` must be forwarded unwrapped — a wrapper (even a transparent
    // pass-through arrow) was found, by direct testing, to make `out()` silently fall back to the
    // token's raw text instead of running the tagger. That is also why these are referenced
    // in-line rather than hoisted to a module-level constant, which would trip
    // `@typescript-eslint/unbound-method` for the same reason a hoisted reference to any other
    // interface method would.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- see comment above
    const pre = token.out(nlp.its.precedingSpaces);
    if (typeof pre === 'string') offset += pre.length;
    const value = token.out();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- see comment above
    const pos = token.out(nlp.its.pos);
    if (typeof pos === 'string') map.set(offset, pos as PartOfSpeech);
    offset += value.length;
  });
  return {
    tagAt(sourceStart: number): PartOfSpeech | undefined {
      return map.get(sourceStart);
    },
  };
}
