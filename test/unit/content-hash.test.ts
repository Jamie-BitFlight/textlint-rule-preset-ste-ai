import { describe, expect, it } from 'vite-plus/test';
import { contentHash, contentHashParts } from '../../src/core/text.js';

describe('contentHash', () => {
  it('frames parts whose values contain the former delimiter', () => {
    expect(contentHash('a', 'b\x1fc')).not.toBe(contentHash('a\x1fb', 'c'));
  });

  it('preserves lone UTF-16 surrogates', () => {
    expect(contentHash('\ud800')).not.toBe(contentHash('\ufffd'));
  });

  it('streams the same framed parts without a variadic argument list', () => {
    expect(contentHashParts(['a', 'b\x1fc'])).toBe(contentHash('a', 'b\x1fc'));
  });
});
