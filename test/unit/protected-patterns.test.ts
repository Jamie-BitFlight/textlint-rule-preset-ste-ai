import { describe, expect, it } from 'vite-plus/test';
import { analyseText, analyseTextDeterministic } from '../../src/analysis/analyse.js';
import {
  MAX_PROTECTED_PATTERN_LENGTH,
  screenExtraPatterns,
} from '../../src/core/protected-regions.js';
import type { RunNotice } from '../../src/core/types.js';

const SAMPLE = 'Part PN1234 is ready.\n';

/** The note `extraPatternPass` stamps on every region it contributes, and nothing else does. */
const USER_PATTERN_NOTE = 'User-supplied protected pattern.';

function patternNotices(notices: readonly RunNotice[]): RunNotice[] {
  return notices.filter((n) => n.code === 'invalid-protected-pattern');
}

function analyse(patterns: readonly string[]) {
  return analyseTextDeterministic(SAMPLE, {
    config: { extraProtectedPatterns: [...patterns] },
  });
}

/**
 * Whether `PN1234` is protected *by a user-supplied pattern* — not merely protected at all.
 *
 * The distinction is the entire point of the assertion. `PN1234` is code-shaped, so the bare
 * identifier heuristic protects it whatever `extraProtectedPatterns` contains; an oracle that only
 * asked `document.isProtected(...)` stayed `true` even when `extraPatternPass` contributed nothing,
 * so it could not tell "the configured pattern was applied" apart from "the configured pattern was
 * ignored". Only `extraPatternPass` stamps {@link USER_PATTERN_NOTE}, so requiring a region that
 * carries that note *and* covers the span is what actually proves the configured pattern ran — the
 * same discriminating check the `matches-only-empty` test below already relies on for its negative.
 */
function pnProtectedByUserPattern(result: ReturnType<typeof analyseTextDeterministic>): boolean {
  const start = SAMPLE.indexOf('PN1234');
  const end = start + 'PN1234'.length;
  return result.document.protectedRegions.some(
    (r) => r.note === USER_PATTERN_NOTE && r.range.start <= start && r.range.end >= end,
  );
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

    // One bad entry must not disable the rest of the list — and "the rest of the list still ran"
    // has to be read off a region `extraPatternPass` itself contributed, not off `PN1234` merely
    // being protected by something.
    expect(pnProtectedByUserPattern(result)).toBe(true);
    expect(result.document.protectedRegions.some((r) => r.kind === 'identifier')).toBe(true);
  });

  it('reports a nested-quantifier pattern under its own reason (issue #21)', () => {
    const result = analyse(['PN\\d+', '(\\d+)+$']);

    const notices = patternNotices(result.notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.level).toBe('error');
    expect(notices[0]?.detail?.['reason']).toBe('nested-quantifier');
    expect(notices[0]?.detail?.['pattern']).toBe('(\\d+)+$');
    expect(pnProtectedByUserPattern(result)).toBe(true);
  });

  it('reports a quantified alternation, whose branches the screen cannot prove unambiguous', () => {
    const notices = patternNotices(analyse(['(a|ab)*']).notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('quantified-alternation');
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

  it('reports a forward backreference to an empty capture as matches-only-empty', () => {
    // Reported in external review of PR #73, round 8: a backreference to a group that has not yet
    // closed at the point it's scanned — including a genuine forward reference, `\1()` — was
    // treated as an unresolved, conservatively-consuming reference instead of the always-empty
    // match JavaScript itself gives an unparticipated capture's backreference.
    const notices = patternNotices(analyse(['\\1()']).notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail?.['reason']).toBe('matches-only-empty');
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
    expect(result.document.protectedRegions.some((r) => r.note === USER_PATTERN_NOTE)).toBe(false);
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
    expect(pnProtectedByUserPattern(result)).toBe(true);
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

// The explanation each refusal carries is what an operator reads to learn why their configuration
// was refused, so the reject table below asserts the sentence its own row produces rather than
// merely that some non-empty string came back. These are the clauses `screenExtraPatterns` builds,
// split out so each row supplies only the part that is specific to it.
const NESTED_QUANTIFIER_SAYS =
  'a repetition quantifier is applied to a group whose body already repeats';
const QUANTIFIED_ALTERNATION_SAYS =
  'a group containing an alternation, whose branches this screen cannot prove unambiguous';
const QUANTIFIED_OPTIONAL_SAYS =
  'a group containing an optional element, so the same input span has more than one way to divide across iterations';
const MATCHES_ONLY_EMPTY_SAYS =
  'every possible match is zero-length, so it can never protect a span of text';

/** The adjacent-repetition sentence for two occurrences of the *same* atom, which it names. */
function repeatedAtomSays(atom: string): string {
  return `"${atom}" is independently repeated more than once in a row`;
}

/** The adjacent-repetition sentence for two *different* atoms whose character sets overlap. */
function overlappingAtomsSay(first: string, second: string): string {
  return `"${first}" and "${second}" can match overlapping characters and are independently repeated back to back`;
}

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
    // character.
    ['a character range next to the bare atom it starts with', '[a-z]*a*b'],
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
  ])('accepts %s', (_label, source) => {
    expect(screenExtraPatterns([source])).toEqual({ accepted: [source], rejected: [] });
  });

  // Every source below is a real defect: issue #21, or one of the rounds of external review on
  // PR #73 that the comments name. Some of them were, until this table absorbed them, also asserted
  // by a second test that built the same regex by hand, ran `.test()` on a short input, and
  // required the elapsed time to exceed a fixed threshold.
  //
  // That timing half is gone, and deliberately not replaced. It measured the host engine's
  // backtracking, not `screenExtraPatterns`, so it was uncorrelated with product correctness in
  // both directions: a faster engine fails it while the screen is perfectly healthy, and a slower
  // engine passes it while the screen is broken. Some of those bounds were already marginal on
  // CI-class hardware, so they passed by luck of the box rather than by anything the screen did.
  //
  // The product never runs these patterns at all. `screenExtraPatterns` refuses each one by reading
  // its source, so the cost of screening is independent of how catastrophically the pattern would
  // backtrack if it were ever compiled and executed — which it is not. To see that for yourself,
  // time `screenExtraPatterns([source])` against `new RegExp(source, 'u').test('a'.repeat(40) + '!')`
  // for any row below whose reason is `adjacent-repetition`.
  //
  // The regression value was always the refusal — this source, this reason, this explanation —
  // which is exactly what these rows assert, deterministically.
  it.each([
    ['nested repetition', '(\\d+)+', 'nested-quantifier', NESTED_QUANTIFIER_SAYS],
    ['a repeated star group', '(a*)*', 'nested-quantifier', NESTED_QUANTIFIER_SAYS],
    ['repetition nested two groups deep', '((\\d+))+', 'nested-quantifier', NESTED_QUANTIFIER_SAYS],
    [
      'a repeated alternation of repetitions',
      '(?:x+|y)+',
      'nested-quantifier',
      NESTED_QUANTIFIER_SAYS,
    ],
    [
      'a repeated ambiguous alternation',
      '(a|ab)*',
      'quantified-alternation',
      QUANTIFIED_ALTERNATION_SAYS,
    ],
    // Each iteration of the outer `+` can consume the optional atom or skip it, so the same input
    // has more than one way to split across iterations — the same mechanism as a nested repetition,
    // reached through `?` instead of `+`/`*`. This is the shape that bypassed an earlier version of
    // this screen, reported in external review of PR #73: that version checked only for a nested
    // repetition or alternation inside the repeated group, so an optional atom — not an explicit
    // `+`/`*` — compiled and passed straight through to `matchAll`.
    [
      'a repeated group with a trailing optional atom',
      '(aa?)+',
      'quantified-optional',
      QUANTIFIED_OPTIONAL_SAYS,
    ],
    [
      'the reported case as written, anchored',
      '^(aa?)+$',
      'quantified-optional',
      QUANTIFIED_OPTIONAL_SAYS,
    ],
    [
      'the minimal repeated-optional shape',
      '(a?)+',
      'quantified-optional',
      QUANTIFIED_OPTIONAL_SAYS,
    ],
    [
      'a repeated optional shape inside a named group',
      '(?<part>a?)+',
      'quantified-optional',
      QUANTIFIED_OPTIONAL_SAYS,
    ],
    [
      'a repeated optional shape nested two groups deep',
      '((a?))+',
      'quantified-optional',
      QUANTIFIED_OPTIONAL_SAYS,
    ],
    [
      'a bounded optional repetition, min zero',
      '(a{0,3})+',
      'nested-quantifier',
      NESTED_QUANTIFIER_SAYS,
    ],
    // Reported in external review of PR #73: `a*a*a*a*a*a*a*a*b` compiled and passed the screen
    // above (neither nested nor alternating) despite Node's own engine taking seconds to match it
    // against 40 `a`s followed by a non-matching character — the ambiguity is not inside either
    // repeat, but in how the same run of characters can be divided between two adjacent ones.
    [
      'the same atom independently repeated twice in a row',
      'a*a*b',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    [
      'the reported eight-way case',
      'a*a*a*a*a*a*a*a*b',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    [
      'the reported eight-way case as written, anchored',
      '^a*a*a*a*a*a*a*a*b$',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    // `?` (min 0, max 1) has the same "consume it or don't" choice as `*` and chains the same way.
    [
      'the same optional atom repeated many times in a row',
      'a?a?a?a?a?a?a?a?a?a?b',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    // A lazy `?` suffix (`*?`, `+?`, `??`, `{n,m}?`) is part of the same quantifier, not a
    // separate one — reported in external review of PR #73 as a way to defeat the check above:
    // `quantifierAt` read only the greedy quantifier character, so the lazy marker was read as a
    // separate, unrelated quantifier on the next loop iteration and cleared the streak.
    [
      'the same eight-way case, written lazily',
      'a*?a*?a*?a*?a*?a*?a*?a*?b',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    [
      'the same eight-way lazy case as written, anchored',
      '^a*?a*?a*?a*?a*?a*?a*?a*?b$',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    // Round 6: the same atom, spelled two different ways (bare and as a single-char class), is
    // just as ambiguous adjacent as the same spelling repeated — `lastRangeQuantifiedAtom`
    // previously compared raw source text, so `a*` and `[a]*` never matched each other. The
    // explanation names the atom as the operator spelled it, which is what makes each of these
    // three orderings distinguishable from the others.
    [
      'the same atom, bare then as a single-char class',
      'a*[a]*b',
      'adjacent-repetition',
      repeatedAtomSays('[a]'),
    ],
    [
      'the same atom, single-char class then bare',
      '[a]*a*b',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    [
      'the same atom, single-char class both times',
      '[a]*[a]*b',
      'adjacent-repetition',
      repeatedAtomSays('[a]'),
    ],
    [
      'the eight-way case, alternating spellings',
      'a*[a]*a*[a]*a*[a]*a*[a]*b',
      'adjacent-repetition',
      repeatedAtomSays('[a]'),
    ],
    [
      'the eight-way alternating-spelling case as written, anchored',
      '^a*[a]*a*[a]*a*[a]*a*[a]*b$',
      'adjacent-repetition',
      repeatedAtomSays('[a]'),
    ],
    // A lone `-` inside a class has no adjacent character to form a range with, so it is
    // unambiguously a literal hyphen — the same atom as the bare `-` outside a class.
    [
      'a literal hyphen, bare and as a single-char class',
      '[-]*-*b',
      'adjacent-repetition',
      repeatedAtomSays('-'),
    ],
    // `extraPatternPass` discards a zero-length match, so a pattern that can only ever produce one
    // protects nothing — silently, unlike every other refusal here, since it's neither invalid
    // syntax nor a complexity risk.
    [
      'a bare anchor, no consuming content at all',
      '^',
      'matches-only-empty',
      MATCHES_ONLY_EMPTY_SAYS,
    ],
    ['a bare word boundary', '\\b', 'matches-only-empty', MATCHES_ONLY_EMPTY_SAYS],
    [
      'a lookahead with nothing outside it',
      '(?=PN)',
      'matches-only-empty',
      MATCHES_ONLY_EMPTY_SAYS,
    ],
    [
      'a lookbehind with nothing outside it',
      '(?<=PN)',
      'matches-only-empty',
      MATCHES_ONLY_EMPTY_SAYS,
    ],
    [
      'two lookarounds and nothing that consumes',
      '(?=PN)(?!SN)',
      'matches-only-empty',
      MATCHES_ONLY_EMPTY_SAYS,
    ],
    // An exact zero-count quantifier means the atom it quantifies can never actually run —
    // reported in external review of PR #73 as a shape the first version of this check missed by
    // returning as soon as it saw the atom, without checking what quantified it.
    [
      'an atom quantified to occur exactly zero times',
      'a{0}',
      'matches-only-empty',
      MATCHES_ONLY_EMPTY_SAYS,
    ],
    [
      'a character class quantified to occur exactly zero times',
      '[A-Z]{0}',
      'matches-only-empty',
      MATCHES_ONLY_EMPTY_SAYS,
    ],
    // Round 6: a *group's own* exact-zero trailing quantifier means its body can never run,
    // regardless of what the body contains — the earlier version of this check judged each atom
    // the moment it was seen, before it had scanned as far as the group's closing quantifier.
    [
      'a group quantified to occur exactly zero times',
      '(PN){0}',
      'matches-only-empty',
      MATCHES_ONLY_EMPTY_SAYS,
    ],
    [
      'a group quantified to occur exactly zero times, nested two deep',
      '((PN)){0}',
      'matches-only-empty',
      MATCHES_ONLY_EMPTY_SAYS,
    ],
    // Round 7: a Unicode property escape is one atom, not the four unrelated characters an
    // earlier version of the scanner split it into — the escape branch always read exactly two
    // characters, so `\p{L}` became the unrelated atoms `\p`, `{`, `L`, `}`, only the trailing `}`
    // was ever quantified, and the unquantified atoms between one `}` and the next reset the
    // streak every time. So the same adjacent-repetition ambiguity as `a*a*` applies to
    // `\p{L}*\p{L}*` too, and to its negation `\P{...}` the same way.
    [
      'the same Unicode property escape, repeated adjacently, eight-way',
      '^\\p{L}*\\p{L}*\\p{L}*\\p{L}*\\p{L}*\\p{L}*\\p{L}*\\p{L}*X$',
      'adjacent-repetition',
      repeatedAtomSays('\\p{L}'),
    ],
    [
      'a negated Unicode property escape, repeated adjacently',
      '\\P{L}*\\P{L}*b',
      'adjacent-repetition',
      repeatedAtomSays('\\P{L}'),
    ],
    // Round 7: two atoms that are not textually identical but can still match the same character
    // are just as ambiguous adjacent as the same atom repeated. Round 6's single-character-class
    // normalization recognised `[a]` as the same atom as bare `a`, but not `[ab]` as an atom that
    // *overlaps* with `a` — the raw source text still differed, so the streak was never caught.
    // The explanation names both atoms, in the order they appear.
    [
      'a bare literal and a multi-character class that contains it',
      'a*[ab]*b',
      'adjacent-repetition',
      overlappingAtomsSay('a', '[ab]'),
    ],
    [
      'two multi-character classes that share a character',
      '[ab]*[bc]*d',
      'adjacent-repetition',
      overlappingAtomsSay('[ab]', '[bc]'),
    ],
    [
      'the reported eight-way case, alternating a bare literal and an overlapping class',
      '^a*[ab]*a*[ab]*a*[ab]*a*[ab]*b$',
      'adjacent-repetition',
      overlappingAtomsSay('a', '[ab]'),
    ],
    // Round 7: a backreference to a group that can only ever capture empty is itself zero-width —
    // the escape branch previously treated every backreference as an ordinary consuming escape.
    ['a backreference to an empty capture', '()\\1', 'matches-only-empty', MATCHES_ONLY_EMPTY_SAYS],
    [
      'a backreference to a capture whose own content is quantified to zero',
      '(a{0})\\1',
      'matches-only-empty',
      MATCHES_ONLY_EMPTY_SAYS,
    ],
    [
      'a named backreference to an empty capture',
      '(?<x>)\\k<x>',
      'matches-only-empty',
      MATCHES_ONLY_EMPTY_SAYS,
    ],
    // Round 8: a multi-character escape is one atom, not several unrelated characters, so the same
    // adjacent-repetition ambiguity as `a*a*` applies to each of these escape forms too —
    // `escapeAtomLength` only special-cased `\p`/`\P`, so `\u{61}` still split into `\u`, `{`,
    // `6`, `1`, `}`, and `\x61` split the same way.
    [
      'a braced Unicode code point escape, repeated adjacently, eight-way',
      '^\\u{61}*\\u{61}*\\u{61}*\\u{61}*\\u{61}*\\u{61}*\\u{61}*\\u{61}*b$',
      'adjacent-repetition',
      repeatedAtomSays('\\u{61}'),
    ],
    [
      'a fixed-width Unicode escape, repeated adjacently, eight-way',
      '^\\u0061*\\u0061*\\u0061*\\u0061*\\u0061*\\u0061*\\u0061*\\u0061*b$',
      'adjacent-repetition',
      repeatedAtomSays('\\u0061'),
    ],
    [
      'a two-digit hex escape, repeated adjacently, eight-way',
      '^\\x61*\\x61*\\x61*\\x61*\\x61*\\x61*\\x61*\\x61*b$',
      'adjacent-repetition',
      repeatedAtomSays('\\x61'),
    ],
    // Round 8: a trivial wrapper group whose entire body is exactly one bare atom is, for this
    // check, indistinguishable from that atom written bare — a closed group used to reset the
    // parent's streak unconditionally, so `(?:a)*a*` was never compared even though `(?:a)` means
    // exactly `a`.
    [
      'a wrapper group next to the bare atom it wraps',
      '(?:a)*a*b',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    [
      'the bare atom next to the wrapper group that wraps it',
      'a*(?:a)*b',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    [
      'a wrapper group next to itself, twice',
      '(?:a)*(?:a)*b',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    [
      'a wrapper group next to an overlapping multi-character class',
      '(?:a)*[ab]*c',
      'adjacent-repetition',
      overlappingAtomsSay('a', '[ab]'),
    ],
    [
      'the reported eight-way case, alternating a wrapper group and the bare atom it wraps',
      '^(?:a)*a*(?:a)*a*(?:a)*a*(?:a)*a*b$',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    // Round 8: a backreference to a group not yet closed at the point it's scanned is either a
    // forward reference (always empty, per spec — the group has not yet participated) or a
    // reference this walk cannot resolve, but a *forward* reference must not be conflated with the
    // latter, conservative-consuming case.
    [
      'a forward backreference to an empty capture',
      '\\1()',
      'matches-only-empty',
      MATCHES_ONLY_EMPTY_SAYS,
    ],
    [
      'a forward named backreference to an empty capture',
      '\\k<x>(?<x>)',
      'matches-only-empty',
      MATCHES_ONLY_EMPTY_SAYS,
    ],
    // Round 9: a lookaround is zero-width, so it cannot break adjacency between the atom before
    // it and the atom after it, regardless of what the lookaround itself asserts — every closing
    // `)`, lookaround or not, used to reset the streak.
    [
      'two atoms adjacent across an intervening lookahead',
      'a*(?=a*)a*b',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    [
      'the reported eight-way case, separated by lookaheads',
      '^a*(?=a*)a*(?=a*)a*(?=a*)a*(?=a*)a*(?=a*)a*(?=a*)a*(?=a*)a*b$',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    [
      'two atoms adjacent across an intervening negative lookahead',
      'a*(?!a*)a*b',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    [
      'two atoms adjacent across an intervening lookbehind',
      'a*(?<=a*)a*b',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    [
      'two atoms adjacent across an intervening negative lookbehind',
      'a*(?<!a*)a*b',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    [
      'an unrelated lookahead does not shield the adjacency either',
      'a*(?=x)a*b',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    // Round 10: a repeated group is now compared by its exact body text, not just when that body
    // is a single bare atom — the round-8 fix only recognised a closed group as comparable when
    // its entire body was exactly one un-quantified bare atom, so `(?:ab)*(?:ab)*` (two atoms, not
    // one) still reset the streak on every close. Two identical multi-atom bodies are just as
    // ambiguous adjacent as two identical bare atoms, and the explanation names the body.
    [
      'two adjacent groups with identical two-atom bodies',
      '(?:ab)*(?:ab)*c',
      'adjacent-repetition',
      repeatedAtomSays('ab'),
    ],
    [
      'the reported eight-way case, repeated two-atom groups',
      '^(?:ab)*(?:ab)*(?:ab)*(?:ab)*(?:ab)*(?:ab)*(?:ab)*(?:ab)*c$',
      'adjacent-repetition',
      repeatedAtomSays('ab'),
    ],
    // Round 10: a syntactically empty ordinary group (`()`) is zero-width the same way a
    // lookaround is, and must not break adjacency between the atoms on either side of it — only
    // the lookaround case had been fixed, so every closing `)` for an ordinary group still reset
    // the streak regardless of whether the group had any body at all.
    [
      'two atoms adjacent across an intervening empty group',
      'a*()a*b',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    [
      'the reported eight-way case, separated by empty groups',
      '^a*()a*()a*()a*()a*()a*()a*()a*b$',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    // Round 11: `\B`/`\b` never consume, so — like a lookaround or an empty group — they cannot
    // break adjacency between the atoms on either side; the escape branch used to feed them
    // through `consumeQuantifier` like an ordinary consuming atom.
    [
      'two atoms adjacent across an intervening non-word-boundary',
      'a*\\Ba*b',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    [
      'two atoms adjacent across an intervening word-boundary',
      'a*\\ba*b',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    [
      'the reported eight-way case, separated by non-word-boundaries',
      '^a*\\Ba*\\Ba*\\Ba*\\Ba*\\Ba*\\Ba*\\Ba*b$',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    // Round 11: two group bodies that spell the same atom sequence differently are just as
    // ambiguous adjacent as two identical spellings — the round-10 fix compared raw, unnormalized
    // body text, so `(?:ab)*` and the equivalent `(?:a[b])*` were never recognised as the same
    // body. The normalized body is what the explanation names.
    [
      'two repeated groups whose bodies differ only by single-char-class spelling',
      '(?:ab)*(?:a[b])*c',
      'adjacent-repetition',
      repeatedAtomSays('ab'),
    ],
    [
      'the reported eight-way case, alternating body spellings',
      '^(?:ab)*(?:a[b])*(?:ab)*(?:a[b])*(?:ab)*(?:a[b])*(?:ab)*(?:a[b])*c$',
      'adjacent-repetition',
      repeatedAtomSays('ab'),
    ],
    // Round 11: a group whose body is provably zero-width — not just literally empty — is zero-
    // width the same way `()` is, and must not break adjacency either; the round-10 fix only
    // recognised a literally empty body, so `(?:x{0})` still reset the streak.
    [
      'two atoms adjacent across a group proven zero-width, not literally empty',
      'a*(?:x{0})a*b',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    [
      'the reported eight-way case, separated by provably zero-width groups',
      '^a*(?:x{0})a*(?:x{0})a*(?:x{0})a*(?:x{0})a*(?:x{0})a*(?:x{0})a*(?:x{0})a*b$',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    // Round 12: a *bare atom* proven zero-width by its own quantifier — not just a group wrapping
    // one — must not break adjacency either; the group case above and this bare-atom case are
    // resolved by two different branches (`)` handler vs. `consumeQuantifier`) and round 11 only
    // fixed the former.
    [
      'two atoms adjacent across a bare atom quantified to occur exactly zero times',
      'a*x{0}a*b',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    [
      'the reported eight-way case, separated by a bare zero-count atom',
      '^a*x{0}a*x{0}a*x{0}a*x{0}a*x{0}a*x{0}a*x{0}a*b$',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    // Round 12: a backreference proven zero-width (per `canOnlyMatchEmpty`'s own group-emptiness
    // proof) must not break adjacency either — `complexityRejection` previously never consulted
    // that proof and treated every backreference as an ordinary consuming escape.
    [
      'two atoms adjacent across a backreference proven zero-width',
      '()a*\\1a*b',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    [
      'the reported eight-way case, separated by a backreference to an empty capture',
      '^()a*\\1a*\\1a*\\1a*\\1a*\\1a*\\1a*\\1a*\\1b$',
      'adjacent-repetition',
      repeatedAtomSays('a'),
    ],
    // The engine's own diagnosis is passed through verbatim, so the operator can tell an
    // unterminated class from an unterminated group without re-running the regex themselves.
    [
      'an unterminated character class',
      '([unclosed',
      'invalid-syntax',
      'it is not a valid regular expression (Invalid regular expression: /([unclosed/gu: Unterminated character class)',
    ],
    [
      'an unmatched group',
      '(?:',
      'invalid-syntax',
      'it is not a valid regular expression (Invalid regular expression: /(?:/gu: Unterminated group)',
    ],
  ])('rejects %s', (_label, source, reason, explanationSays) => {
    const screened = screenExtraPatterns([source]);
    expect(screened.accepted).toEqual([]);
    expect(screened.rejected).toHaveLength(1);
    expect(screened.rejected[0]?.reason).toBe(reason);
    expect(screened.rejected[0]?.source).toBe(source);
    // Not merely non-empty: the explanation has to name the construct this row is about. A screen
    // that returned one constant sentence for every refusal — or named the wrong atom of an
    // adjacent pair, or dropped the engine's own syntax diagnosis — passes a length check and
    // fails here.
    expect(screened.rejected[0]?.explanation).toContain(explanationSays);
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
