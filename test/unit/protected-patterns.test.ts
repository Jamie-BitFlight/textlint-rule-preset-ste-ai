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

  it('reports an adjacent repetition, whose ambiguity is at the boundary, not inside either repeat', () => {
    // Reported in external review of PR #73: `^a*a*a*a*a*a*a*a*b$` has no nesting and no
    // alternation inside either `*` — the ambiguity is entirely in how many characters the first
    // `a*` consumes versus the second, third, etc. Same proof discipline as the quantified-optional
    // case above: measure the pattern the screen refuses against Node's own engine first.
    const attack = new RegExp('^a*a*a*a*a*a*a*a*b$', 'u');
    const input = `${'a'.repeat(40)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(analyse(['^a*a*a*a*a*a*a*a*b$']).notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('adjacent-repetition');
  });

  it('reports a pattern that can only ever match empty, not a silent no-op', () => {
    // Reported in external review of PR #73: `^` and a pure lookahead like `(?=PN)` compile and
    // pass every complexity check (there is nothing to be complex), but `extraPatternPass`
    // discards every zero-length match it produces — so the pattern protects nothing, with no
    // notice, the same silent-no-op class of bug issue #7 exists to eliminate.
    const result = analyse(['^']);
    const notices = patternNotices(result.notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('matches-only-empty');
    // Confirms the *consequence*, not just the classification: `extraPatternPass` itself
    // contributed no region — `PN1234` still ends up protected, but by the unrelated bare
    // code-shaped-identifier heuristic, not by this refused pattern. Had `^` silently been
    // accepted and produced nothing, this specific pass's contribution would be indistinguishable
    // from a config with no extraProtectedPatterns configured at all.
    expect(
      result.document.protectedRegions.some((r) => r.note === 'User-supplied protected pattern.'),
    ).toBe(false);
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
    ['a lookahead containing an optional element, not itself repeated', '(?=a?)b'],
    ['a lookbehind containing an optional element, not itself repeated', '(?<=a?)b'],
    // Two range-quantified atoms, but not the SAME atom, and not adjacent to each other in a way
    // that creates cross-boundary ambiguity — a false positive an overly blunt adjacent-repetition
    // check could produce.
    ['two different atoms, each independently range-quantified', '(\\d+)(\\d+)'],
    ['an exact count next to a real repetition, only one is ambiguous', 'DOC-[A-Z]{2}-\\d+'],
    ['the same atom reused, but separated by an unquantified atom', 'v\\d+\\.\\d+'],
    ['the same atom, but the second occurrence is an exact count', 'a*a{2}'],
    // A lookaround's own content never consumes from the caller's point of view, but content
    // *outside* it does — this is not zero-width-only.
    ['a lookahead with consuming content after it', '(?=PN)PN'],
    ['an anchor plus consuming content', '^PN'],
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
    // Reported in external review of PR #73: `^a*a*a*a*a*a*a*a*b$` compiled and passed the screen
    // above (neither nested nor alternating) despite Node's own engine taking over 3s to match it
    // against 40 `a`s followed by a non-matching character — the ambiguity is not inside either
    // repeat, but in how the same run of characters can be divided between two adjacent ones.
    ['the same atom independently repeated twice in a row', 'a*a*b', 'adjacent-repetition'],
    ['the reported eight-way case', 'a*a*a*a*a*a*a*a*b', 'adjacent-repetition'],
    // `?` (min 0, max 1) has the same "consume it or don't" choice as `*` and chains the same way.
    [
      'the same optional atom repeated many times in a row',
      'a?a?a?a?a?a?a?a?a?a?b',
      'adjacent-repetition',
    ],
    // `extraPatternPass` discards a zero-length match, so a pattern that can only ever produce one
    // protects nothing — silently, unlike every other refusal here, since it's neither invalid
    // syntax nor a complexity risk.
    ['a bare anchor, no consuming content at all', '^', 'matches-only-empty'],
    ['a bare word boundary', '\\b', 'matches-only-empty'],
    ['a lookahead with nothing outside it', '(?=PN)', 'matches-only-empty'],
    ['a lookbehind with nothing outside it', '(?<=PN)', 'matches-only-empty'],
    ['two lookarounds and nothing that consumes', '(?=PN)(?!SN)', 'matches-only-empty'],
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
