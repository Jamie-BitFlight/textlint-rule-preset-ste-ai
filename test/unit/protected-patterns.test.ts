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

  it('reports an adjacent repetition spelled two different ways, bare and single-char class', () => {
    // Reported in external review of PR #73, round 6: `lastRangeQuantifiedAtom` compared the raw
    // source text of each atom, so `a*` and `[a]*` — the same atom, spelled two different ways —
    // were never recognised as a streak even though they are exactly as ambiguous adjacent as
    // `a*a*`. Same proof discipline: measure first.
    const attack = new RegExp('^a*[a]*a*[a]*a*[a]*a*[a]*b$', 'u');
    const input = `${'a'.repeat(40)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(analyse(['^a*[a]*a*[a]*a*[a]*a*[a]*b$']).notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('adjacent-repetition');
  });

  it('reports the same adjacent repetition written with lazy quantifiers', () => {
    // Reported in external review of PR #73, on the fix above: `quantifierAt` read only the
    // greedy quantifier character, not a trailing lazy `?` (`*?`, `+?`, `??`, `{n,m}?`), so the
    // lazy marker was read as a separate, unrelated quantifier on the next loop iteration and
    // incorrectly cleared the streak this check tracks. Same proof discipline: measure first.
    const attack = new RegExp('^a*?a*?a*?a*?a*?a*?a*?a*?b$', 'u');
    const input = `${'a'.repeat(40)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(analyse(['^a*?a*?a*?a*?a*?a*?a*?a*?b$']).notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('adjacent-repetition');
  });

  it('reports an adjacent repetition of a Unicode property escape, not four unrelated atoms', () => {
    // Reported in external review of PR #73, round 7: the escape branch always read exactly two
    // characters, so `\p{L}` split into the unrelated atoms `\p`, `{`, `L`, `}` — only the
    // trailing `}` ever got quantified, and the unquantified atoms between one `}` and the next
    // reset the adjacent-repetition streak every time. Same proof discipline: measure first.
    const attack = new RegExp('^\\p{L}*\\p{L}*\\p{L}*\\p{L}*\\p{L}*\\p{L}*\\p{L}*\\p{L}*X$', 'u');
    const input = `${'a'.repeat(40)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(
      analyse(['^\\p{L}*\\p{L}*\\p{L}*\\p{L}*\\p{L}*\\p{L}*\\p{L}*\\p{L}*X$']).notices,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('adjacent-repetition');
  });

  it('reports an adjacent repetition between two different classes that overlap', () => {
    // Reported in external review of PR #73, round 7: round 6's single-character-class
    // normalization recognised `[a]` as the same atom as bare `a`, but not `[ab]` as an atom that
    // *overlaps* with `a` — the raw source text still differed, so the streak was never caught.
    // Same proof discipline: measure first.
    const attack = new RegExp('^a*[ab]*a*[ab]*a*[ab]*a*[ab]*b$', 'u');
    const input = `${'a'.repeat(40)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(analyse(['^a*[ab]*a*[ab]*a*[ab]*a*[ab]*b$']).notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('adjacent-repetition');
  });

  it('reports a backreference to an empty capture as matches-only-empty, not a consuming atom', () => {
    // Reported in external review of PR #73, round 7: the escape branch treated every
    // backreference as an ordinary consuming escape, so `()\1` — a capture that can only ever be
    // empty, followed by a backreference to it — compiled and passed every check even though
    // every possible match is zero-length.
    const notices = patternNotices(analyse(['()\\1']).notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('matches-only-empty');
  });

  it('reports an adjacent repetition of a braced Unicode code point escape', () => {
    // Reported in external review of PR #73, round 8: `escapeAtomLength` only special-cased `\p`
    // and `\P`, so `\u{61}` still split into `\u`, `{`, `6`, `1`, `}` as unrelated atoms. Same
    // proof discipline: measure first.
    const attack = new RegExp(
      '^\\u{61}*\\u{61}*\\u{61}*\\u{61}*\\u{61}*\\u{61}*\\u{61}*\\u{61}*b$',
      'u',
    );
    const input = `${'a'.repeat(40)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(
      analyse(['^\\u{61}*\\u{61}*\\u{61}*\\u{61}*\\u{61}*\\u{61}*\\u{61}*\\u{61}*b$']).notices,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('adjacent-repetition');
  });

  it('reports an adjacent repetition of a two-digit hex escape', () => {
    // Reported in external review of PR #73, round 8, alongside the braced form: `\x61` split the
    // same way. Same proof discipline: measure first.
    const attack = new RegExp('^\\x61*\\x61*\\x61*\\x61*\\x61*\\x61*\\x61*\\x61*b$', 'u');
    const input = `${'a'.repeat(40)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(
      analyse(['^\\x61*\\x61*\\x61*\\x61*\\x61*\\x61*\\x61*\\x61*b$']).notices,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('adjacent-repetition');
  });

  it('reports an adjacent repetition where a trivial wrapper group stands in for a bare atom', () => {
    // Reported in external review of PR #73, round 8: a closed group unconditionally reset the
    // parent's adjacent-repetition streak, so `(?:a)*a*` — a trivial wrapper group and the bare
    // atom it wraps, alternating — was never compared even though `(?:a)` means exactly `a`. Same
    // proof discipline: measure first.
    const attack = new RegExp('^(?:a)*a*(?:a)*a*(?:a)*a*(?:a)*a*b$', 'u');
    const input = `${'a'.repeat(40)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(analyse(['^(?:a)*a*(?:a)*a*(?:a)*a*(?:a)*a*b$']).notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('adjacent-repetition');
  });

  it('reports a forward backreference to an empty capture as matches-only-empty', () => {
    // Reported in external review of PR #73, round 8: a backreference to a group that has not yet
    // closed at the point it's scanned — including a genuine forward reference, `\1()` — was
    // treated as an unresolved, conservatively-consuming reference instead of the always-empty
    // match JavaScript itself gives an unparticipated capture's backreference.
    const notices = patternNotices(analyse(['\\1()']).notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('matches-only-empty');
  });

  it('reports an adjacent repetition across an intervening zero-width lookaround', () => {
    // Reported in external review of PR #73, round 9: a lookaround never advances the match
    // position, so it cannot break adjacency between the atom before it and the atom after it —
    // but every closing `)`, lookaround or not, unconditionally reset the streak. Same proof
    // discipline: measure first.
    const attack = new RegExp('^a*(?=a*)a*(?=a*)a*(?=a*)a*(?=a*)a*(?=a*)a*(?=a*)a*(?=a*)a*b$', 'u');
    const input = `${'a'.repeat(40)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(
      analyse(['^a*(?=a*)a*(?=a*)a*(?=a*)a*(?=a*)a*(?=a*)a*(?=a*)a*(?=a*)a*b$']).notices,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('adjacent-repetition');
  });

  it('reports an adjacent repetition of a repeated multi-atom group', () => {
    // Reported in external review of PR #73, round 10: the round-8 fix only recognised a closed
    // group as comparable when its entire body was exactly one un-quantified bare atom, so
    // `(?:ab)*(?:ab)*` — two atoms, not one — still reset the streak on every close. Same proof
    // discipline: measure first.
    const attack = new RegExp('^(?:ab)*(?:ab)*(?:ab)*(?:ab)*(?:ab)*(?:ab)*(?:ab)*(?:ab)*c$', 'u');
    const input = `${'ab'.repeat(40)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(
      analyse(['^(?:ab)*(?:ab)*(?:ab)*(?:ab)*(?:ab)*(?:ab)*(?:ab)*(?:ab)*c$']).notices,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('adjacent-repetition');
  });

  it('reports an adjacent repetition across an intervening syntactically empty group', () => {
    // Reported in external review of PR #73, round 10: an ordinary group that is syntactically
    // empty (`()`) can never advance the match position either, the same reasoning as the
    // lookaround case above, but only the lookaround case was fixed — every closing `)` for an
    // ordinary group still reset the streak regardless of whether the group had any body at all.
    // Same proof discipline: measure first.
    const attack = new RegExp('^a*()a*()a*()a*()a*()a*()a*()a*b$', 'u');
    const input = `${'a'.repeat(40)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(analyse(['^a*()a*()a*()a*()a*()a*()a*()a*b$']).notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('adjacent-repetition');
  });

  it('reports an adjacent repetition across an intervening word-boundary escape', () => {
    // Reported in external review of PR #73, round 11: `\B` never consumes, the same reasoning as
    // a lookaround or an empty group, but the escape branch always fed it through
    // `consumeQuantifier` like an ordinary consuming atom. Same proof discipline: measure first.
    const attack = new RegExp('^a*\\Ba*\\Ba*\\Ba*\\Ba*\\Ba*\\Ba*\\Ba*b$', 'u');
    const input = `${'a'.repeat(40)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(analyse(['^a*\\Ba*\\Ba*\\Ba*\\Ba*\\Ba*\\Ba*\\Ba*b$']).notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('adjacent-repetition');
  });

  it('reports an adjacent repetition between group bodies that spell the same atoms differently', () => {
    // Reported in external review of PR #73, round 11: the round-10 fix compared raw, unnormalized
    // group body text, so `(?:ab)*` and the equivalent `(?:a[b])*` — same atoms, one spelled with
    // a single-character class — were never recognised as the same body. Same proof discipline:
    // measure first.
    const attack = new RegExp(
      '^(?:ab)*(?:a[b])*(?:ab)*(?:a[b])*(?:ab)*(?:a[b])*(?:ab)*(?:a[b])*c$',
      'u',
    );
    const input = `${'ab'.repeat(40)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(
      analyse(['^(?:ab)*(?:a[b])*(?:ab)*(?:a[b])*(?:ab)*(?:a[b])*(?:ab)*(?:a[b])*c$']).notices,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('adjacent-repetition');
  });

  it('reports an adjacent repetition across a group proven zero-width, not just literally empty', () => {
    // Reported in external review of PR #73, round 11: the round-10 fix only recognised a group
    // as zero-width when its body was literally empty (`()`), so `(?:x{0})` — a non-empty body
    // that can still only ever match empty — still reset the streak. Same proof discipline:
    // measure first.
    const attack = new RegExp(
      '^a*(?:x{0})a*(?:x{0})a*(?:x{0})a*(?:x{0})a*(?:x{0})a*(?:x{0})a*(?:x{0})a*b$',
      'u',
    );
    const input = `${'a'.repeat(40)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(
      analyse(['^a*(?:x{0})a*(?:x{0})a*(?:x{0})a*(?:x{0})a*(?:x{0})a*(?:x{0})a*(?:x{0})a*b$'])
        .notices,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('adjacent-repetition');
  });

  it('reports an adjacent repetition across a bare atom quantified to occur exactly zero times', () => {
    // Reported in external review of PR #73, round 12: round 11's zero-width fix only covered a
    // *group* proven zero-width (`(?:x{0})`), not a bare atom quantified the same way — the exact
    // case that already produces the `matches-only-empty` verdict for a whole pattern
    // (`a{0}` in the `screenExtraPatterns` table below) still unconditionally reset the parent's
    // adjacent-repetition streak inside `consumeQuantifier`. Same proof discipline: measure first.
    const attack = new RegExp('^a*x{0}a*x{0}a*x{0}a*x{0}a*x{0}a*x{0}a*x{0}a*b$', 'u');
    const input = `${'a'.repeat(40)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(
      analyse(['^a*x{0}a*x{0}a*x{0}a*x{0}a*x{0}a*x{0}a*x{0}a*b$']).notices,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('adjacent-repetition');
  });

  it('reports an adjacent repetition across a backreference proven zero-width', () => {
    // Reported in external review of PR #73, round 12: `canOnlyMatchEmpty` already proves a
    // backreference to an always-empty capture is zero-width (for the whole-pattern
    // `matches-only-empty` verdict), but `complexityRejection`'s own separate scan never consulted
    // that proof — the escape branch fed every backreference through `consumeQuantifier` like an
    // ordinary consuming atom, regardless of what it referred to. Same proof discipline: measure
    // first.
    const attack = new RegExp('^()a*\\1a*\\1a*\\1a*\\1a*\\1a*\\1a*\\1a*\\1b$', 'u');
    const input = `${'a'.repeat(40)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(
      analyse(['^()a*\\1a*\\1a*\\1a*\\1a*\\1a*\\1a*\\1a*\\1b$']).notices,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('adjacent-repetition');
  });

  it('reports an adjacent repetition between two character ranges that overlap', () => {
    // Reported in external review of PR #73, round 13: a range was left entirely unenumerated even
    // when small, so `atomCharSet` returned `undefined` for both `[a-z]` and `[b-z]` and no overlap
    // could be proven, although every character `[b-z]` matches is also in `[a-z]`. Same proof
    // discipline: measure first.
    const attack = new RegExp('^[a-z]*[b-z]*[a-z]*[b-z]*[a-z]*[b-z]*[a-z]*[b-z]*X$', 'u');
    const input = `${'b'.repeat(40)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(
      analyse(['^[a-z]*[b-z]*[a-z]*[b-z]*[a-z]*[b-z]*[a-z]*[b-z]*X$']).notices,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('adjacent-repetition');
  });

  it('reports an adjacent repetition across a wrapped backreference that loses capture context in isolation', () => {
    // Reported in external review of PR #73, round 13: the `)` handler called `canOnlyMatchEmpty`
    // on the closed group's isolated body text alone, so a backreference inside a wrapper group
    // (`(?:\1)`) could never resolve a capture defined outside that slice — `canOnlyMatchEmpty`
    // could only ever conclude it consumes. Same proof discipline: measure first.
    const attack = new RegExp(
      '^()a*(?:\\1)a*(?:\\1)a*(?:\\1)a*(?:\\1)a*(?:\\1)a*(?:\\1)a*(?:\\1)a*b$',
      'u',
    );
    const input = `${'a'.repeat(40)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(
      analyse(['^()a*(?:\\1)a*(?:\\1)a*(?:\\1)a*(?:\\1)a*(?:\\1)a*(?:\\1)a*(?:\\1)a*b$']).notices,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('adjacent-repetition');
  });

  it('reports an adjacent repetition of the same astral character spelled as both a class and a bare atom', () => {
    // Reported in external review of PR #73/#76, round 15: round 14 fixed the class-only overlap
    // comparison (`[😀]*[😀]*`), but the bare-atom scanning loop still advanced one UTF-16 code
    // unit at a time — leaving `i` mid-character so the trailing quantifier was checked at the
    // wrong position — and both `normalizeAtomText` and `atomCharSet`'s single-atom branches still
    // assumed a bare/reducible atom is exactly one JS string-length unit. Same proof discipline:
    // measure first.
    const attack = new RegExp(
      '^[\u{1F600}]*\u{1F600}*[\u{1F600}]*\u{1F600}*[\u{1F600}]*\u{1F600}*[\u{1F600}]*\u{1F600}*X$',
      'u',
    );
    const input = `${'\u{1F600}'.repeat(40)}!`;
    const start = performance.now();
    const matched = attack.test(input);
    const elapsedMs = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeGreaterThan(500);

    const notices = patternNotices(
      analyse([
        '^[\u{1F600}]*\u{1F600}*[\u{1F600}]*\u{1F600}*[\u{1F600}]*\u{1F600}*[\u{1F600}]*\u{1F600}*X$',
      ]).notices,
    );
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
    // A range that includes zero as its minimum can still consume up to its maximum — only an
    // EXACT zero count (`{0}`) can never consume.
    ['an atom that may consume zero to three times, not always zero', 'a{0,3}'],
    // `.` is "any character" bare but a literal dot inside `[.]` — round 6's single-char-class
    // normalization must not conflate them, in either order, or it would over-reject a harmless
    // pattern.
    ['a bare dot next to a single-char class of a different meaning', '.*[.]*b'],
    ['the same pair in the other order', '[.]*.*b'],
    // Different single literal characters, one spelled bare and one as a single-char class — not
    // the same atom, so not a streak.
    ['different atoms, one bare and one a single-char class', 'a*[b]*c'],
    // A range or negated class is not a single-char class, so it must not normalize to its first
    // character. Round 13 taught `atomCharSet` to expand small ranges for overlap detection, so a
    // range next to an atom it contains is now correctly caught below, not accepted here — a
    // negated class stays unenumerated (round 13 only expanded ordinary ranges, not negation) and
    // still belongs in this list.
    ['a negated class next to the bare atom it excludes', '[^a]*a*b'],
    // An escape inside a class is not a bare single character either.
    ['an escaped digit class next to the bare escape', '[\\d]*\\d*b'],
    // A group whose own trailing quantifier has an exact-zero maximum can never actually run, so
    // an outer repetition on the group is not reached — no different from `a{0}` on a bare atom.
    ['a group with an exact-zero trailing quantifier, not itself repeated', '(PN){0}b'],
    // Round 7: a Unicode property escape is one atom (`\p{L}` is length 5, not two separate
    // characters), so `\p{L}` and `\p{N}` are two genuinely different, non-overlapping atoms — the
    // parser has no enumerable character set for either, so no overlap is provable and neither
    // shape is flagged on suspicion.
    ['a repeated Unicode property escape, alone', '\\p{L}+'],
    ['two different Unicode property escapes, adjacent', '\\p{L}*\\p{N}*b'],
    // A backreference to a group that genuinely consumes is an ordinary consuming atom — only a
    // backreference to a *provably empty* capture is treated as zero-width.
    ['a backreference to a group that actually consumes', '(a)\\1'],
    ['a backreference to an empty capture, with consuming content after it', '()\\1b'],
    // Two multi-character classes with genuinely no character in common — the range and
    // escape-inside-a-class cases just above already cover why `[a-z]`/`[\d]` are not enumerable
    // in the first place, so overlap with another atom is never claimed for either.
    ['two disjoint multi-character classes, adjacent', '[ab]*[cd]*e'],
    // Round 8: a multi-character escape (`\u{...}`, `\u` + four hex digits, `\x` + two hex digits)
    // is one atom, not several unrelated characters, so a single repeated escape and two different
    // escape notations of the same character (never decoded, so never compared) both stay accepted.
    ['a repeated braced Unicode code point escape, alone', '\\u{61}+'],
    ['a repeated fixed-width Unicode escape, alone', '\\u0061+'],
    ['a repeated two-digit hex escape, alone', '\\x61+'],
    ['two different notations of the same character, never decoded or compared', '\\u{61}*\\x61*b'],
    // Round 8: a trivial wrapper group `(?:a)` is treated as its sole atom only when nothing else
    // disqualifies it — a group with more than one atom, or whose own atom is itself quantified,
    // does not qualify, so no false positive is claimed for either.
    ['a wrapper group next to a bare atom of a different letter', '(?:a)*(?:b)*c'],
    ['a two-atom group body, not a sole-atom shape', '(?:ab)*a*c'],
    ['a wrapper group with an exact-count trailing quantifier, not a range', '(?:a){3}a*b'],
    // Round 8: `\1` and other backreference forms that resolve to a group actually consuming stay
    // ordinary consuming atoms — only a reference to a *provably empty* capture, forward or
    // backward, is treated as zero-width. `\1(a)` is a forward reference (always empty on its own)
    // immediately followed by the group it refers to, which still consumes when reached.
    ['a forward backreference immediately followed by the group it refers to', '\\1(a)'],
    // Round 9: a lookaround between two adjacent range-quantified atoms does not fabricate an
    // overlap where none exists — it just doesn't interrupt one that already exists.
    ['a lookahead between two atoms with nothing in common', 'a*(?=b)c*d'],
    ['a lookahead alone, no adjacency at all', '(?=PN)b'],
    // Pre-existing behavior, unaffected: an optional element inside a lookahead still propagates
    // `optional` up to the enclosing frame, but nothing wraps that frame here, so it stays
    // accepted regardless.
    ['an optional element inside a lookahead, with consuming content after it', 'a*(?=a?)b'],
    // Round 10: a repeated group is compared by exact body text, not overlap — two different
    // multi-character bodies stay accepted, and only a single occurrence never has a streak
    // partner to compare against.
    ['two repeated groups with different, non-overlapping bodies', '(?:ab)*(?:ba)*c'],
    ['a single repeated multi-atom group, no adjacency at all', '(?:ab)*c'],
    ['a multi-atom group at an exact count next to the same group repeated', '(?:ab){3}(?:ab)*c'],
    // Round 10: an empty group's own trailing quantifier is irrelevant (repeating nothing is
    // still nothing) and it must not fabricate an overlap where the surrounding atoms don't
    // create one on their own.
    ['a syntactically empty group, no adjacency at all', '()b'],
    ['an empty group after only one range-quantified atom', 'a*()b'],
    ['an empty group after an atom that is not range-quantified', '(a)()b'],
    // Round 11: `\B`/`\b` between two atoms with nothing in common must not fabricate an overlap
    // where none exists — it only preserves an adjacency that would already be there.
    ['a word-boundary escape between two atoms with nothing in common', 'a*\\Bc*d'],
    // Round 11: group bodies compared by exact (normalized) text, not overlap — genuinely
    // different bodies stay accepted.
    [
      'two repeated groups with different bodies, one containing a single-char class',
      '(?:ab)*(?:ac)*c',
    ],
    // Round 11: a group proven zero-width only shields adjacency it would otherwise preserve — it
    // must not fabricate one, and a group that genuinely still consumes is unaffected.
    ['a group proven zero-width, no adjacency at all', '(?:x{0})b'],
    ['a group that actually consumes, not zero-width', 'a*(?:x)a*b'],
    // Round 14: two single-character classes holding different supplementary-plane characters
    // (surrogate pairs) must not appear to overlap just because their UTF-16 code units happen to
    // share a high surrogate — `atomCharSet` must read a whole codepoint per member, not one
    // UTF-16 code unit at a time.
    ['two single-character classes of different astral characters', '[\u{1F600}]*[\u{1F601}]*X'],
    // Round 15: a class range whose start endpoint is a literal astral character must be recognised
    // as a range at all — previously misread the character's own low surrogate as the `-`, producing
    // a spurious extra literal `-` member instead of correctly recognising `😀`-to-`😁` as a range
    // (and then, per the existing astral-range policy, leaving it unenumerated rather than falsely
    // reporting overlap with a literal hyphen it does not actually contain).
    [
      'a class range starting with an astral character, next to a literal hyphen it does not contain',
      '[\u{1F600}-\u{1F601}]*-*X',
    ],
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
    // A lazy `?` suffix (`*?`, `+?`, `??`, `{n,m}?`) is part of the same quantifier, not a
    // separate one — reported in external review of PR #73 as a way to defeat the check above by
    // making the scanner misread the lazy marker as its own (non-)quantifier, breaking the streak.
    ['the same eight-way case, written lazily', 'a*?a*?a*?a*?a*?a*?a*?a*?b', 'adjacent-repetition'],
    // Round 6: the same atom, spelled two different ways (bare and as a single-char class), is
    // just as ambiguous adjacent as the same spelling repeated — `lastRangeQuantifiedAtom`
    // previously compared raw source text, so `a*` and `[a]*` never matched each other.
    ['the same atom, bare then as a single-char class', 'a*[a]*b', 'adjacent-repetition'],
    ['the same atom, single-char class then bare', '[a]*a*b', 'adjacent-repetition'],
    ['the same atom, single-char class both times', '[a]*[a]*b', 'adjacent-repetition'],
    [
      'the eight-way case, alternating spellings',
      'a*[a]*a*[a]*a*[a]*a*[a]*b',
      'adjacent-repetition',
    ],
    // A lone `-` inside a class has no adjacent character to form a range with, so it is
    // unambiguously a literal hyphen — the same atom as the bare `-` outside a class.
    ['a literal hyphen, bare and as a single-char class', '[-]*-*b', 'adjacent-repetition'],
    // `extraPatternPass` discards a zero-length match, so a pattern that can only ever produce one
    // protects nothing — silently, unlike every other refusal here, since it's neither invalid
    // syntax nor a complexity risk.
    ['a bare anchor, no consuming content at all', '^', 'matches-only-empty'],
    ['a bare word boundary', '\\b', 'matches-only-empty'],
    ['a lookahead with nothing outside it', '(?=PN)', 'matches-only-empty'],
    ['a lookbehind with nothing outside it', '(?<=PN)', 'matches-only-empty'],
    ['two lookarounds and nothing that consumes', '(?=PN)(?!SN)', 'matches-only-empty'],
    // An exact zero-count quantifier means the atom it quantifies can never actually run —
    // reported in external review of PR #73 as a shape the first version of this check missed by
    // returning as soon as it saw the atom, without checking what quantified it.
    ['an atom quantified to occur exactly zero times', 'a{0}', 'matches-only-empty'],
    ['a character class quantified to occur exactly zero times', '[A-Z]{0}', 'matches-only-empty'],
    // Round 6: a *group's own* exact-zero trailing quantifier means its body can never run,
    // regardless of what the body contains — the earlier version of this check judged each atom
    // the moment it was seen, before it had scanned as far as the group's closing quantifier.
    ['a group quantified to occur exactly zero times', '(PN){0}', 'matches-only-empty'],
    [
      'a group quantified to occur exactly zero times, nested two deep',
      '((PN)){0}',
      'matches-only-empty',
    ],
    // Round 7: a Unicode property escape is one atom, not the four unrelated characters an
    // earlier version of the scanner split it into — so the same adjacent-repetition ambiguity
    // as `a*a*` applies to `\p{L}*\p{L}*` too, and its negation `\P{...}` the same way.
    [
      'the same Unicode property escape, repeated adjacently, eight-way',
      '^\\p{L}*\\p{L}*\\p{L}*\\p{L}*\\p{L}*\\p{L}*\\p{L}*\\p{L}*X$',
      'adjacent-repetition',
    ],
    [
      'a negated Unicode property escape, repeated adjacently',
      '\\P{L}*\\P{L}*b',
      'adjacent-repetition',
    ],
    // Round 7: two atoms that are not textually identical but can still match the same character
    // are just as ambiguous adjacent as the same atom repeated.
    [
      'a bare literal and a multi-character class that contains it',
      'a*[ab]*b',
      'adjacent-repetition',
    ],
    ['two multi-character classes that share a character', '[ab]*[bc]*d', 'adjacent-repetition'],
    [
      'the reported eight-way case, alternating a bare literal and an overlapping class',
      '^a*[ab]*a*[ab]*a*[ab]*a*[ab]*b$',
      'adjacent-repetition',
    ],
    // Round 13: a range was previously left entirely unenumerated, even when small — two adjacent
    // range-quantified ranges that overlap are just as ambiguous as two overlapping enumerated
    // classes, and just as cheap to prove for an ordinary-sized range.
    ['a character range next to the bare atom it contains', '[a-z]*a*b', 'adjacent-repetition'],
    ['two overlapping character ranges', '[a-z]*[b-z]*X', 'adjacent-repetition'],
    [
      'the reported eight-way case, alternating two overlapping ranges',
      '^[a-z]*[b-z]*[a-z]*[b-z]*[a-z]*[b-z]*[a-z]*[b-z]*X$',
      'adjacent-repetition',
    ],
    // Round 14: the same supplementary-plane character repeated in two adjacent classes must
    // still be recognised as overlapping — reading it as a whole codepoint, not per-UTF-16-code-unit,
    // must not stop genuine overlap detection from working.
    [
      'two single-character classes of the same astral character',
      '[\u{1F600}]*[\u{1F600}]*X',
      'adjacent-repetition',
    ],
    // Round 15: the same astral character, alternating class and bare spelling, must compare equal
    // by both the sameText path (normalizeAtomText) and the character-set overlap path
    // (atomCharSet) — round 14 only fixed the class-only comparison; the bare-atom scanning loop
    // still advanced one UTF-16 code unit at a time, and both normalizeAtomText's and
    // atomCharSet's single-atom branches still assumed a bare/reducible atom is exactly one JS
    // string-length unit (true for BMP, false for a two-unit surrogate pair).
    [
      'the same astral character, alternating class and bare spelling, eight-way',
      '^[\u{1F600}]*\u{1F600}*[\u{1F600}]*\u{1F600}*[\u{1F600}]*\u{1F600}*[\u{1F600}]*\u{1F600}*X$',
      'adjacent-repetition',
    ],
    // Round 15 (found alongside the reported findings, same root cause): an astral atom quantified
    // to occur exactly zero times must be classified matches-only-empty, the same as any other
    // atom{0} — canOnlyMatchEmpty's bare-atom path had the identical one-code-unit-at-a-time bug.
    ['an astral atom quantified to occur exactly zero times', '\u{1F600}{0}', 'matches-only-empty'],
    // Round 7: a backreference to a group that can only ever capture empty is itself zero-width —
    // the escape branch previously treated every backreference as an ordinary consuming escape.
    ['a backreference to an empty capture', '()\\1', 'matches-only-empty'],
    [
      'a backreference to a capture whose own content is quantified to zero',
      '(a{0})\\1',
      'matches-only-empty',
    ],
    ['a named backreference to an empty capture', '(?<x>)\\k<x>', 'matches-only-empty'],
    // Round 8: a multi-character escape is one atom, not several unrelated characters, so the same
    // adjacent-repetition ambiguity as `a*a*` applies to each of these escape forms too.
    [
      'a braced Unicode code point escape, repeated adjacently, eight-way',
      '^\\u{61}*\\u{61}*\\u{61}*\\u{61}*\\u{61}*\\u{61}*\\u{61}*\\u{61}*b$',
      'adjacent-repetition',
    ],
    [
      'a fixed-width Unicode escape, repeated adjacently, eight-way',
      '^\\u0061*\\u0061*\\u0061*\\u0061*\\u0061*\\u0061*\\u0061*\\u0061*b$',
      'adjacent-repetition',
    ],
    [
      'a two-digit hex escape, repeated adjacently, eight-way',
      '^\\x61*\\x61*\\x61*\\x61*\\x61*\\x61*\\x61*\\x61*b$',
      'adjacent-repetition',
    ],
    // Round 8: a trivial wrapper group whose entire body is exactly one bare atom is, for this
    // check, indistinguishable from that atom written bare.
    ['a wrapper group next to the bare atom it wraps', '(?:a)*a*b', 'adjacent-repetition'],
    ['the bare atom next to the wrapper group that wraps it', 'a*(?:a)*b', 'adjacent-repetition'],
    ['a wrapper group next to itself, twice', '(?:a)*(?:a)*b', 'adjacent-repetition'],
    [
      'a wrapper group next to an overlapping multi-character class',
      '(?:a)*[ab]*c',
      'adjacent-repetition',
    ],
    [
      'the reported eight-way case, alternating a wrapper group and the bare atom it wraps',
      '^(?:a)*a*(?:a)*a*(?:a)*a*(?:a)*a*b$',
      'adjacent-repetition',
    ],
    // Round 8: a backreference to a group not yet closed at the point it's scanned is either a
    // forward reference (always empty, per spec — the group has not yet participated) or a
    // reference this walk cannot resolve, but a *forward* reference must not be conflated with the
    // latter, conservative-consuming case.
    ['a forward backreference to an empty capture', '\\1()', 'matches-only-empty'],
    ['a forward named backreference to an empty capture', '\\k<x>(?<x>)', 'matches-only-empty'],
    // Round 9: a lookaround is zero-width, so it cannot break adjacency between the atom before
    // it and the atom after it, regardless of what the lookaround itself asserts.
    ['two atoms adjacent across an intervening lookahead', 'a*(?=a*)a*b', 'adjacent-repetition'],
    [
      'two atoms adjacent across an intervening negative lookahead',
      'a*(?!a*)a*b',
      'adjacent-repetition',
    ],
    ['two atoms adjacent across an intervening lookbehind', 'a*(?<=a*)a*b', 'adjacent-repetition'],
    [
      'two atoms adjacent across an intervening negative lookbehind',
      'a*(?<!a*)a*b',
      'adjacent-repetition',
    ],
    [
      'an unrelated lookahead does not shield the adjacency either',
      'a*(?=x)a*b',
      'adjacent-repetition',
    ],
    // Round 10: a repeated group is now compared by its exact body text, not just when that body
    // is a single bare atom — two identical multi-atom bodies are just as ambiguous adjacent as
    // two identical bare atoms.
    [
      'two adjacent groups with identical two-atom bodies',
      '(?:ab)*(?:ab)*c',
      'adjacent-repetition',
    ],
    [
      'the reported eight-way case, repeated two-atom groups',
      '^(?:ab)*(?:ab)*(?:ab)*(?:ab)*(?:ab)*(?:ab)*(?:ab)*(?:ab)*c$',
      'adjacent-repetition',
    ],
    // Round 10: a syntactically empty ordinary group (`()`) is zero-width the same way a
    // lookaround is, and must not break adjacency between the atoms on either side of it.
    ['two atoms adjacent across an intervening empty group', 'a*()a*b', 'adjacent-repetition'],
    [
      'the reported eight-way case, separated by empty groups',
      '^a*()a*()a*()a*()a*()a*()a*()a*b$',
      'adjacent-repetition',
    ],
    // Round 11: `\B`/`\b` never consume, so — like a lookaround or an empty group — they cannot
    // break adjacency between the atoms on either side.
    [
      'two atoms adjacent across an intervening non-word-boundary',
      'a*\\Ba*b',
      'adjacent-repetition',
    ],
    ['two atoms adjacent across an intervening word-boundary', 'a*\\ba*b', 'adjacent-repetition'],
    [
      'the reported eight-way case, separated by non-word-boundaries',
      '^a*\\Ba*\\Ba*\\Ba*\\Ba*\\Ba*\\Ba*\\Ba*b$',
      'adjacent-repetition',
    ],
    // Round 11: two group bodies that spell the same atom sequence differently are just as
    // ambiguous adjacent as two identical spellings.
    [
      'two repeated groups whose bodies differ only by single-char-class spelling',
      '(?:ab)*(?:a[b])*c',
      'adjacent-repetition',
    ],
    [
      'the reported eight-way case, alternating body spellings',
      '^(?:ab)*(?:a[b])*(?:ab)*(?:a[b])*(?:ab)*(?:a[b])*(?:ab)*(?:a[b])*c$',
      'adjacent-repetition',
    ],
    // Round 11: a group whose body is provably zero-width — not just literally empty — is zero-
    // width the same way `()` is, and must not break adjacency either.
    [
      'two atoms adjacent across a group proven zero-width, not literally empty',
      'a*(?:x{0})a*b',
      'adjacent-repetition',
    ],
    [
      'the reported eight-way case, separated by provably zero-width groups',
      '^a*(?:x{0})a*(?:x{0})a*(?:x{0})a*(?:x{0})a*(?:x{0})a*(?:x{0})a*(?:x{0})a*b$',
      'adjacent-repetition',
    ],
    // Round 12: a *bare atom* proven zero-width by its own quantifier — not just a group wrapping
    // one — must not break adjacency either; the group case above and this bare-atom case are
    // resolved by two different branches (`)` handler vs. `consumeQuantifier`) and round 11 only
    // fixed the former.
    [
      'two atoms adjacent across a bare atom quantified to occur exactly zero times',
      'a*x{0}a*b',
      'adjacent-repetition',
    ],
    [
      'the reported eight-way case, separated by a bare zero-count atom',
      '^a*x{0}a*x{0}a*x{0}a*x{0}a*x{0}a*x{0}a*x{0}a*b$',
      'adjacent-repetition',
    ],
    // Round 12: a backreference proven zero-width (per `canOnlyMatchEmpty`'s own group-emptiness
    // proof) must not break adjacency either — `complexityRejection` previously never consulted
    // that proof and treated every backreference as an ordinary consuming escape.
    [
      'two atoms adjacent across a backreference proven zero-width',
      '()a*\\1a*b',
      'adjacent-repetition',
    ],
    [
      'the reported eight-way case, separated by a backreference to an empty capture',
      '^()a*\\1a*\\1a*\\1a*\\1a*\\1a*\\1a*\\1a*\\1b$',
      'adjacent-repetition',
    ],
    // Round 13: a backreference to an empty capture, wrapped in its own group, must still be
    // recognised as zero-width — `canOnlyMatchEmpty` was called on the wrapper's isolated body
    // text, which has no way to see a group defined outside that slice.
    [
      'two atoms adjacent across a wrapper group around a backreference proven zero-width',
      '()a*(?:\\1)a*b',
      'adjacent-repetition',
    ],
    [
      'the reported eight-way case, separated by a wrapped backreference to an empty capture',
      '^()a*(?:\\1)a*(?:\\1)a*(?:\\1)a*(?:\\1)a*(?:\\1)a*(?:\\1)a*(?:\\1)a*b$',
      'adjacent-repetition',
    ],
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
