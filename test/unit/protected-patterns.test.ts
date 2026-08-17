import { describe, expect, it } from 'vite-plus/test';
import { analyseText, analyseTextDeterministic } from '../../src/analysis/analyse.js';
import {
  MAX_PROTECTED_PATTERN_LENGTH,
  screenExtraPatterns,
} from '../../src/core/protected-regions.js';
import type { RunNotice } from '../../src/core/types.js';

const SAMPLE = 'Part PN1234 is ready.\n';

function patternNotices(notices: readonly RunNotice[]): RunNotice[] {
  return notices.filter((n) => n.code === 'invalid-protected-pattern');
}

function analyse(patterns: readonly string[]) {
  return analyseTextDeterministic(SAMPLE, {
    config: { extraProtectedPatterns: [...patterns] },
  });
}

function pnIsProtected(result: ReturnType<typeof analyseTextDeterministic>): boolean {
  const at = SAMPLE.indexOf('PN1234');
  return result.document.isProtected({ start: at, end: at + 'PN1234'.length });
}

describe('refused extraProtectedPatterns entries are reported, never dropped silently', () => {
  it('reports an invalid pattern while the valid one beside it still protects its literal', () => {
    // The reproduction from issue #7: the invalid entry was discarded with `notices === []`.
    const result = analyse(['PN\\d+', '([unclosed']);

    const notices = patternNotices(result.notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.level).toBe('error');
    expect(notices[0]?.detail?.['pattern']).toBe('([unclosed');
    expect(notices[0]?.detail?.['reason']).toBe('invalid-syntax');
    expect(notices[0]?.message).toContain('([unclosed');

    // One bad entry must not disable the rest of the list.
    expect(pnIsProtected(result)).toBe(true);
    expect(result.document.protectedRegions.some((r) => r.kind === 'identifier')).toBe(true);
  });

  it('reports a nested-quantifier pattern under its own reason (issue #21)', () => {
    const result = analyse(['PN\\d+', '(\\d+)+$']);

    const notices = patternNotices(result.notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.level).toBe('error');
    expect(notices[0]?.detail?.['reason']).toBe('nested-quantifier');
    expect(notices[0]?.detail?.['pattern']).toBe('(\\d+)+$');
    expect(pnIsProtected(result)).toBe(true);
  });

  it('reports a quantified alternation, whose branches the screen cannot prove unambiguous', () => {
    const notices = patternNotices(analyse(['(a|ab)*']).notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('quantified-alternation');
  });

  it('reports an over-long source, so a pathological pattern never reaches the engine', () => {
    const tooLong = `${'a'.repeat(MAX_PROTECTED_PATTERN_LENGTH)}b`;
    const notices = patternNotices(analyse([tooLong]).notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('source-too-long');
    expect(notices[0]?.detail?.['pattern']).toBe(tooLong);
  });

  it('reports every refused entry, one notice each, and none for the accepted ones', () => {
    const notices = patternNotices(
      analyse(['PN\\d+', '([unclosed', '(a*)*', 'DOC-[A-Z]{2}-\\d+']).notices,
    );
    expect(notices.map((n) => n.detail?.['reason'])).toEqual([
      'invalid-syntax',
      'nested-quantifier',
    ]);
  });

  it('emits nothing for a configuration whose patterns are all usable', () => {
    const result = analyse(['PN\\d+', 'DOC-[A-Z]{2}-\\d+']);
    expect(patternNotices(result.notices)).toEqual([]);
    expect(pnIsProtected(result)).toBe(true);
  });

  it('surfaces the same notice on the full analysis path', async () => {
    // `semantic.enabled` is false by default, so this performs no I/O.
    const result = await analyseText(SAMPLE, {
      config: { extraProtectedPatterns: ['([unclosed'] },
    });
    expect(patternNotices(result.notices).map((n) => n.detail?.['reason'])).toEqual([
      'invalid-syntax',
    ]);
  });
});

describe('screenExtraPatterns', () => {
  it.each([
    ['a plain identifier shape', 'PN\\d+'],
    ['a bounded repetition', 'DOC-[A-Z]{2}-\\d+'],
    ['an open-ended repetition', '\\bPN\\d{4,}\\b'],
    ['an optional group around a repetition', '(\\d+)?'],
    ['a repeated group whose body neither repeats nor alternates', '(?:[A-Z][A-Z]-)+\\d+'],
    ['a quantifier inside a character class, which is a literal', '[a+]+'],
    ['escaped parentheses, which are not a group', '\\(a+\\)+'],
    ['an alternation that is not repeated', '(?:PN|SN)\\d+'],
  ])('accepts %s', (_label, source) => {
    expect(screenExtraPatterns([source])).toEqual({ accepted: [source], rejected: [] });
  });

  it.each([
    ['nested repetition', '(\\d+)+', 'nested-quantifier'],
    ['a repeated star group', '(a*)*', 'nested-quantifier'],
    ['repetition nested two groups deep', '((\\d+))+', 'nested-quantifier'],
    ['a repeated alternation of repetitions', '(?:x+|y)+', 'nested-quantifier'],
    ['a repeated ambiguous alternation', '(a|ab)*', 'quantified-alternation'],
    ['an unterminated character class', '([unclosed', 'invalid-syntax'],
    ['an unmatched group', '(?:', 'invalid-syntax'],
  ])('rejects %s', (_label, source, reason) => {
    const screened = screenExtraPatterns([source]);
    expect(screened.accepted).toEqual([]);
    expect(screened.rejected).toHaveLength(1);
    expect(screened.rejected[0]?.reason).toBe(reason);
    expect(screened.rejected[0]?.source).toBe(source);
    expect(screened.rejected[0]?.explanation.length).toBeGreaterThan(0);
  });

  it('keeps accepted patterns in configured order', () => {
    expect(screenExtraPatterns(['A\\d+', '(a+)+', 'B\\d+']).accepted).toEqual(['A\\d+', 'B\\d+']);
  });

  it('accepts a source at the length limit and rejects the next character', () => {
    const atLimit = 'a'.repeat(MAX_PROTECTED_PATTERN_LENGTH);
    expect(screenExtraPatterns([atLimit]).accepted).toEqual([atLimit]);
    expect(screenExtraPatterns([`${atLimit}a`]).rejected[0]?.reason).toBe('source-too-long');
  });

  it('screens an over-long source before compiling it, so length wins over syntax', () => {
    const overLongAndInvalid = `(${'a'.repeat(MAX_PROTECTED_PATTERN_LENGTH)}`;
    expect(screenExtraPatterns([overLongAndInvalid]).rejected[0]?.reason).toBe('source-too-long');
  });
});
