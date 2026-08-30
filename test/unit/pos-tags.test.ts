import { describe, expect, it } from 'vite-plus/test';
import {
  buildSentencePosIndex,
  isFunctionWord,
  isImperativeOpenerWord,
  sentenceOpensImperative,
  sentencesOpenImperative,
} from '../../src/core/pos-tags.js';
import { MASK_CHAR } from '../../src/core/text.js';
import type { Sentence, Word } from '../../src/core/types.js';

function word(text: string, start: number): Word {
  return { text, lower: text.toLowerCase(), range: { start, end: start + text.length } };
}

describe('fast imperative classification', () => {
  it.each([
    ['Install the driver.', true],
    ['Torque the bolt.', true],
    ['Wipe the lens.', true],
    ['Trim the cable.', true],
    ['Do not remove the cover.', true],
    ['Never touch the terminal.', true],
    ['The driver is installed.', false],
    ['Note: remove the cover.', false],
    ['Stop: this state is terminal.', false],
    ['VACUUM reclaims storage.', false],
    [`${MASK_CHAR.repeat(9)} run the service.`, false],
  ])('%s -> %s', (text, expected) => {
    expect(sentenceOpensImperative(text)).toBe(expected);
  });

  it('honours isolated per-run extra verbs and multi-word phrases', () => {
    expect(sentenceOpensImperative('Cache the response.', ['cache'])).toBe(true);
    expect(sentenceOpensImperative('Cache the response.')).toBe(false);
    expect(sentenceOpensImperative('Power cycle the device.', ['power cycle'])).toBe(true);
    expect(sentenceOpensImperative('Power the device.', ['power cycle'])).toBe(false);
  });

  it('classifies a batch with the same lightweight grammar', () => {
    expect(sentencesOpenImperative(['Install it.', 'The unit starts.'])).toEqual([true, false]);
  });
});

describe('fast lexical word classes', () => {
  const sentence: Sentence = {
    id: 's1',
    blockId: 'b1',
    range: { start: 10, end: 31 },
    raw: 'Install the new unit.',
    masked: 'Install the new unit.',
    mode: 'procedural',
    admonition: 'none',
    words: [],
  };
  const index = buildSentencePosIndex(sentence);
  it('uses the bounded function-word dictionary', () => {
    expect(isFunctionWord(word('the', 18), index)).toBe(true);
    expect(isFunctionWord(word('unit', 26), index)).toBe(false);
  });

  it('uses the reviewed verb dictionary for second actions', () => {
    expect(isImperativeOpenerWord(word('Install', 10), index)).toBe(true);
    expect(isImperativeOpenerWord(word('unit', 26), index)).toBe(false);
  });
});
