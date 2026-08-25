import { describe, expect, it } from 'vite-plus/test';
import { analyseTextDeterministic } from '../../src/analysis/analyse.js';
import {
  MAX_PROTECTED_PATTERN_LENGTH,
  screenExtraPatterns,
} from '../../src/core/protected-regions.js';

const SAMPLE = 'Part PN1234 is ready.\n';

function analyse(patterns: readonly string[]) {
  return analyseTextDeterministic(SAMPLE, {
    config: { extraProtectedPatterns: [...patterns] },
  });
}

describe('extraProtectedPatterns screening', () => {
  it('reports invalid syntax without disabling valid neighbours', () => {
    const result = analyse(['PN\\d+', '([unclosed']);
    const notices = result.notices.filter((notice) => notice.code === 'invalid-protected-pattern');

    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('invalid-syntax');
    expect(notices[0]?.detail?.['pattern']).toBe('([unclosed');

    const start = SAMPLE.indexOf('PN1234');
    expect(result.document.isProtected({ start, end: start + 'PN1234'.length })).toBe(true);
  });

  it('rejects sources beyond the configuration limit before analysis', () => {
    const source = 'a'.repeat(MAX_PROTECTED_PATTERN_LENGTH + 1);
    expect(screenExtraPatterns([source]).rejected[0]?.reason).toBe('source-too-long');
  });

  it('screens an over-long source before compiling it, so length wins over syntax', () => {
    // A source that is simultaneously too long and unparsable: only the length check must fire.
    // This distinguishes the length screen actually short-circuiting from a coincidence where a
    // reordered length/syntax check would still land on the same reason for a merely-long source.
    const overLongAndInvalid = `(${'a'.repeat(MAX_PROTECTED_PATTERN_LENGTH)}`;
    expect(screenExtraPatterns([overLongAndInvalid]).rejected[0]?.reason).toBe('source-too-long');
  });

  it('keeps accepted patterns in configured order', () => {
    expect(screenExtraPatterns(['A\\d+', '(\\d+)+$', 'B\\d+']).accepted).toEqual([
      'A\\d+',
      'B\\d+',
    ]);
  });

  it.each([
    '(\\d+)+$',
    '^(aa?)+$',
    '^a*a*a*a*a*a*a*a*b$',
    '\\p{L}*\\p{L}*X',
    '\\u{61}*\\x61*X',
    '[a-z]*[b-z]*X',
    '[a-z]+-[0-9]+',
  ])('rejects a ReDoS vulnerability: %s', (source) => {
    const result = screenExtraPatterns([source]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reason).toBe('unsafe-complexity');
  });

  it.each(['PN\\d+', '[A-Z]{2}-\\d{4}', '(?:foo|bar)+', '(?=PN)PN', '(a)\\1'])(
    'accepts a useful identifier pattern: %s',
    (source) => {
      expect(screenExtraPatterns([source])).toEqual({ accepted: [source], rejected: [] });
    },
  );

  it.each(['^', '$', '^$', '(?=PN)', '(?:)', 'a{0}'])(
    'rejects a pattern that can only match an empty span: %s',
    (source) => {
      expect(screenExtraPatterns([source]).rejected[0]?.reason).toBe('matches-only-empty');
    },
  );
});
