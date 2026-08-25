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

  it('reports a quantified optional, whose iterations can split the same span two ways', () => {
    // Reported in external review of PR #73: an earlier version of the screen checked only for a
    // nested repetition or alternation inside the repeated group, so `(aa?)+` — an optional atom,
    // not an explicit `+`/`*` — compiled and passed straight through to `matchAll`. Proving the
    // shape it exploits is really dangerous, not just differently classified: run the pattern
    // `screenExtraPatterns` refuses directly against Node's own engine, on the input from that
    // review comment, and confirm it would have taken over a second, not that it merely "looks
    // slow" by inspection.
    const attack = new RegExp('^(aa?)+$', 'u');
    const input = `${'a'.repeat(35)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(analyse(['^(aa?)+$']).notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('quantified-optional');
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
    // A non-capturing group's `?:` starts with a literal `?` that is not a quantifier — nothing
    // precedes it to quantify. These must not be misread as an optional element and rejected.
    ['a repeated non-capturing group with a safe body', '(?:abc)+'],
    ['a repeated named group with a safe body', '(?<part>abc)+'],
    ['a lookahead containing an optional element, not itself repeated', '(?=a?)'],
    ['a lookbehind containing an optional element, not itself repeated', '(?<=a?)'],
  ])('accepts %s', (_label, source) => {
    expect(screenExtraPatterns([source])).toEqual({ accepted: [source], rejected: [] });
  });

  it.each([
    ['nested repetition', '(\\d+)+', 'nested-quantifier'],
    ['a repeated star group', '(a*)*', 'nested-quantifier'],
    ['repetition nested two groups deep', '((\\d+))+', 'nested-quantifier'],
    ['a repeated alternation of repetitions', '(?:x+|y)+', 'nested-quantifier'],
    ['a repeated ambiguous alternation', '(a|ab)*', 'quantified-alternation'],
    // Each iteration of the outer `+` can consume the optional atom or skip it, so the same input
    // has more than one way to split across iterations — the same mechanism as a nested repetition,
    // reached through `?` instead of `+`/`*`. Node's own engine takes >1s matching `^(aa?)+$`
    // against 35 `a`s followed by a non-matching character; this is the shape that bypassed an
    // earlier version of this screen, reported in external review of PR #73.
    ['a repeated group with a trailing optional atom', '(aa?)+', 'quantified-optional'],
    ['the minimal repeated-optional shape', '(a?)+', 'quantified-optional'],
    ['a repeated optional shape inside a named group', '(?<part>a?)+', 'quantified-optional'],
    ['a repeated optional shape nested two groups deep', '((a?))+', 'quantified-optional'],
    ['a bounded optional repetition, min zero', '(a{0,3})+', 'nested-quantifier'],
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
