import { describe, expect, it } from 'vite-plus/test';
import { segmentSentences } from '../../src/core/segmentation.js';

function slices(text: string, offset = 0): string[] {
  return segmentSentences(text, offset).map((range) =>
    text.slice(range.start - offset, range.end - offset),
  );
}

describe('fast sentence segmentation', () => {
  it('splits terminators and preserves trimmed source ranges', () => {
    const text = 'First sentence.  Second!\nThird?';
    expect(slices(text)).toEqual(['First sentence.', 'Second!', 'Third?']);
    expect(segmentSentences(text, 100)).toEqual([
      { start: 100, end: 115 },
      { start: 117, end: 124 },
      { start: 125, end: 131 },
    ]);
  });

  it('keeps bounded technical abbreviations inside a sentence', () => {
    expect(slices('Use e.g. this option. Then continue.')).toEqual([
      'Use e.g. this option.',
      'Then continue.',
    ]);
  });

  it.each(['Stop. Restart.', 'Touch. Restart.', 'Start. Restart.', 'Piano. Restart.'])(
    'does not read an ordinary word suffix as an abbreviation: %s',
    (text) => {
      expect(slices(text)).toEqual([text.slice(0, text.indexOf(' Restart.')), 'Restart.']);
    },
  );

  it('distinguishes an internal acronym from a sentence-final acronym', () => {
    expect(slices('The U.S. Department issued it.')).toEqual(['The U.S. Department issued it.']);
    expect(slices('It applies in the U.S. Restart the server.')).toEqual([
      'It applies in the U.S.',
      'Restart the server.',
    ]);
  });

  it('ends a numbered technical reference at its final period', () => {
    expect(slices('See Fig. 2. Restart the server.')).toEqual([
      'See Fig. 2.',
      'Restart the server.',
    ]);
  });

  it('keeps closing punctuation with the sentence', () => {
    expect(slices('Select “Run.” Then wait... Next?')).toEqual([
      'Select “Run.”',
      'Then wait...',
      'Next?',
    ]);
  });

  it('preserves CRLF offsets', () => {
    const text = 'One.\r\nTwo.';
    expect(segmentSentences(text)).toEqual([
      { start: 0, end: 4 },
      { start: 6, end: 10 },
    ]);
  });

  it('returns unterminated prose as one sentence', () => {
    expect(slices('No final terminator')).toEqual(['No final terminator']);
  });
});
