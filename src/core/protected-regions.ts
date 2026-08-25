import { MASK_CHAR, maskRanges, mergeRanges } from './text.js';
import type { DocumentFormat, ProtectedRegion, ProtectedRegionKind, SourceRange } from './types.js';

export interface ProtectedRegionOptions {
  readonly format: DocumentFormat;
  /**
   * Project terminology that must be treated as a literal name rather than ordinary prose.
   * Matched case-sensitively on word boundaries. Supplied by the rule pack or user config.
   */
  readonly approvedTerms: readonly string[];
  /** Additional user-supplied regular expressions, each protected as `identifier`. */
  readonly extraPatterns: readonly string[];
}

export const defaultProtectedRegionOptions: ProtectedRegionOptions = {
  format: 'markdown',
  approvedTerms: [],
  extraPatterns: [],
};

interface Pass {
  readonly kind: ProtectedRegionKind;
  readonly opaque: boolean;
  readonly note: string;
  /**
   * Runs against the progressively-masked text so a pattern can never match inside code.
   *
   * `priorRegions` accumulates every region produced by passes that ran earlier in this same
   * `extractProtectedRegions` call (in the same pass array), so a pass placed late in the order
   * can corroborate a bare token against naming decisions earlier passes already made. Optional
   * so the many existing `find` implementations and `regexPass`-closure call sites that only ever
   * supply the first three arguments keep type-checking unmodified; `extractProtectedRegions`
   * always supplies it.
   */
  readonly find: (
    masked: string,
    raw: string,
    options: ProtectedRegionOptions,
    priorRegions?: readonly ProtectedRegion[],
  ) => SourceRange[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function regexPass(re: RegExp, group = 0): Pass['find'] {
  return (masked) => {
    const out: SourceRange[] = [];
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of masked.matchAll(rx)) {
      const whole = m[0];
      if (group === 0) {
        out.push({ start: m.index, end: m.index + whole.length });
        continue;
      }
      const captured = m[group];
      if (captured === undefined || captured.length === 0) continue;
      const rel = whole.indexOf(captured);
      if (rel < 0) continue;
      out.push({ start: m.index + rel, end: m.index + rel + captured.length });
    }
    return out;
  };
}

function containsMask(text: string): boolean {
  return text.includes(MASK_CHAR);
}

// ---------------------------------------------------------------------------
// Operator-supplied pattern screening
// ---------------------------------------------------------------------------

/**
 * Longest accepted `extraPatterns` source, in characters.
 *
 * A protected pattern describes the shape of an identifier — a part number, a document code — so
 * 200 characters is far more than any such shape needs. The bound exists so that a pathological
 * source cannot reach the engine at all, independently of the shape checks below.
 */
export const MAX_PROTECTED_PATTERN_LENGTH = 200;

/** Why a `extraPatterns` entry was refused. Reported verbatim in the run notice's `detail`. */
export type ProtectedPatternRejectionReason =
  /** `new RegExp(source, 'gu')` threw: the source is not a valid regular expression. */
  | 'invalid-syntax'
  /** The source is longer than {@link MAX_PROTECTED_PATTERN_LENGTH}. */
  | 'source-too-long'
  /** A repetition quantifier applied to a group whose body already repeats, e.g. `(\d+)+`. */
  | 'nested-quantifier'
  /** A repetition quantifier applied to a group containing an alternation, e.g. `(a|ab)*`. */
  | 'quantified-alternation'
  /**
   * A repetition quantifier applied to a group containing an optional element, e.g. `(a?)+`: each
   * iteration can consume the optional atom or skip it, so the same input span has more than one
   * derivation across iterations — the same exponential-backtracking mechanism as a nested
   * quantifier, reached through `?`/`{0,n}` instead of `+`/`*`.
   */
  | 'quantified-optional'
  /**
   * The same atom is independently range-quantified twice in a row with nothing but the boundary
   * between them, e.g. `a*a*`: match time grows with the number of ways to divide the same run of
   * characters between the two repeats, not with nesting or alternation.
   */
  | 'adjacent-repetition'
  /**
   * Every possible match is zero-length, e.g. `^` or `(?=PN)` alone: `extraPatternPass` discards a
   * zero-length match (there is no span to protect), so a pattern that can never produce anything
   * else protects nothing — silently, unlike every other refusal here, since it is neither invalid
   * syntax nor a complexity risk.
   */
  | 'matches-only-empty';

export interface ProtectedPatternRejection {
  /** The offending source, exactly as configured. */
  readonly source: string;
  readonly reason: ProtectedPatternRejectionReason;
  /** One sentence naming the defect, suitable for a user-facing message. */
  readonly explanation: string;
}

export interface ScreenedProtectedPatterns {
  /** Sources that compiled and passed the complexity screen, in configured order. */
  readonly accepted: readonly string[];
  /** Sources that were refused, in configured order. Never silently dropped by the caller. */
  readonly rejected: readonly ProtectedPatternRejection[];
}

interface QuantifierAt {
  /** Smallest number of repetitions the quantifier requires; `0` for `*` and `?`. */
  readonly min: number;
  /** Largest number of repetitions the quantifier permits; `Infinity` for `*`, `+` and `{n,}`. */
  readonly max: number;
  /** Characters consumed by the quantifier, so the scanner can step over it. */
  readonly length: number;
}

/**
 * Read a quantifier at `index`, or `undefined` when no quantifier starts there.
 *
 * A trailing lazy modifier (`*?`, `+?`, `??`, `{n,m}?`) changes match semantics, not the size of
 * the search space this screen reasons about, so it is consumed as part of the same quantifier —
 * `length` covers it too. Missing it would let the caller's next iteration read the lazy `?` as a
 * *separate* quantifier applying to nothing, silently breaking whatever streak this file is
 * tracking through that position (confirmed: this was exactly how `^a*?a*?a*?a*?a*?a*?a*?a*?b$`
 * bypassed the adjacent-repetition check — each lazy `?` reset it). JS regular expressions have no
 * possessive-quantifier syntax (`a*+` is a syntax error, verified directly), so lazy is the only
 * suffix that exists to check for.
 */
function quantifierAt(source: string, index: number): QuantifierAt | undefined {
  const ch = source[index];
  let min: number;
  let max: number;
  let length: number;
  if (ch === '*') {
    min = 0;
    max = Number.POSITIVE_INFINITY;
    length = 1;
  } else if (ch === '+') {
    min = 1;
    max = Number.POSITIVE_INFINITY;
    length = 1;
  } else if (ch === '?') {
    min = 0;
    max = 1;
    length = 1;
  } else if (ch === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(index));
    if (m === null) return undefined;
    min = Number(m[1]);
    max = m[2] === undefined ? min : m[3] === '' ? Number.POSITIVE_INFINITY : Number(m[3]);
    length = m[0].length;
  } else {
    return undefined;
  }
  if (source[index + length] === '?') length += 1;
  return { min, max, length };
}

/**
 * Length of the escape sequence starting at the `\` at `index` — `2` for an ordinary escape
 * (`\d`, `\.`, `\1`), or the full extent of a multi-character escape: a Unicode property escape
 * (`\p{Letter}`, `\P{Script=Greek}`) through its closing `}`, a braced Unicode code point escape
 * (`\u{1F600}`) through its closing `}`, a fixed four-hex-digit Unicode escape (`\u` followed by
 * four hex digits, e.g. `0061`), or a fixed two-hex-digit hex escape (`\x61`).
 *
 * Reading only two characters for `\p{L}` splits it into `\p`, then reads `{`, `L`, `}` as three
 * unrelated bare atoms — corrupting every per-atom check downstream, since none of them is aware
 * they were ever part of one escape. Found in external review of PR #73, round 7:
 * `\p{L}*\p{L}*\p{L}*\p{L}*\p{L}*\p{L}*\p{L}*\p{L}*X` passed adjacent-repetition because only the
 * trailing `}` was ever quantified and compared, and the unquantified `\p`/`{`/`L` atoms between
 * one `}` and the next reset the streak every time; confirmed 7.187s for 40 `a`s before that fix.
 * Round 8, same mechanism, three more escape forms — the braced code point escape, the fixed
 * four-hex-digit escape, and `\x61` — all reduced to their prefix plus separately-scanned
 * digit/brace characters, each confirmed over 5s for 40 `a`s before this fix.
 *
 * Every source reaching this already compiled via `new RegExp`, so `\p`/`\P`/`\u`/`\x` here are
 * each guaranteed to be followed by one of these well-formed shapes. This function does not
 * attempt to decode any of them to the character they represent — `\x61` and bare `a` are both
 * accepted independently but never compared as the same atom, the same "provable, not exhaustive"
 * limitation `atomCharSet` already documents for other atom shapes.
 */
function escapeAtomLength(source: string, index: number): number {
  const kind = source[index + 1];
  if (kind === 'p' || kind === 'P') {
    const closeBrace = source.indexOf('}', index + 2);
    if (closeBrace >= 0) return closeBrace - index + 1;
  }
  if (kind === 'u') {
    if (source[index + 2] === '{') {
      const closeBrace = source.indexOf('}', index + 3);
      if (closeBrace >= 0) return closeBrace - index + 1;
    } else {
      const m = /^\\u[0-9A-Fa-f]{4}/.exec(source.slice(index));
      if (m !== null) return m[0].length;
    }
  }
  if (kind === 'x') {
    const m = /^\\x[0-9A-Fa-f]{2}/.exec(source.slice(index));
    if (m !== null) return m[0].length;
  }
  return 2;
}

/** One group's accumulated shape, used to judge the quantifier that may follow its `)`. */
interface GroupShape {
  /** A repetition quantifier (max > 1) occurs somewhere inside this group, at any depth. */
  repeats: boolean;
  /** An alternation occurs somewhere inside this group, at any depth. */
  alternates: boolean;
  /**
   * An atom, group, or the group itself has a minimum of zero (`?`, `*`, `{0,n}`) somewhere inside
   * this group, at any depth — including a subgroup whose own trailing quantifier is optional.
   */
  optional: boolean;
  /**
   * The bare atom most recently and immediately quantified with a *range* quantifier (`min !==
   * max`, so there is genuinely more than one way to satisfy it) directly in this frame's own body
   * — `undefined` once anything breaks the adjacency: a different, non-overlapping atom, an
   * exact-count quantifier, no quantifier at all, or a `|`/`(`/`)`. Used to catch a second one
   * appearing immediately after it (`a*a*`) — including one that matches an overlapping but not
   * textually identical set of characters (`a*[ab]*`) — where the ambiguity is which repeat
   * consumed which character, not whether either individually can.
   */
  lastRangeQuantifiedAtom: RangeQuantifiedAtom | undefined;
  /**
   * Index into `source` where this group's body starts — right after its opening marker (`(`,
   * `(?:`, `(?<name>`, …). Recorded so the `)` handler can slice out the group's exact body text
   * (`source.slice(bodyStart, closingParenIndex)`) and feed it through the same adjacency
   * comparison a bare atom gets, letting a repeated group — trivial (`(?:a)*a*`) or not
   * (`(?:ab)*(?:ab)*`) — be recognised the same way `a*a*` already is. Found in external review of
   * PR #73: a closed group unconditionally cleared the parent's adjacency streak regardless of
   * what the group contained, confirmed 5.39s for 40 `a`s for the trivial-wrapper case and 5.31s
   * for the two-atom case.
   */
  bodyStart: number;
}

/** An atom quantified with a range quantifier, retained so the next atom can be compared to it. */
interface RangeQuantifiedAtom {
  /** Normalized source text (see {@link normalizeAtomText}), for an exact-spelling match. */
  readonly text: string;
  /**
   * The finite set of single characters this atom can match, when cheaply enumerable — see
   * {@link atomCharSet}. `undefined` when this atom's character set is not determined, in which
   * case only an identical `text` can still catch a match.
   */
  readonly charSet: ReadonlySet<string> | undefined;
}

/**
 * Length of the group-type marker immediately after an opening `(`, or `0` for an ordinary
 * capturing group.
 *
 * `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!` and a named group's `(?<name>` all start with a literal `?`
 * that is not a quantifier — there is nothing before it, inside the frame just pushed for `(`, for
 * it to quantify. Without skipping the marker here, the bare-atom scan below would read that `?` as
 * an optional quantifier applied to nothing and mark the group `optional`, so every non-capturing
 * group or lookaround — `(?:[A-Z][A-Z]-)`, harmless — would look exactly like `(a?)`, genuinely
 * ambiguous, the moment either sits under an outer repetition.
 *
 * Every source reaching this function already compiled via `new RegExp` (`screenExtraPatterns`
 * checks that first), so a `?` here is guaranteed to start one of these five recognised forms —
 * never a malformed one.
 */
function groupMarkerLength(source: string, openParenIndex: number): number {
  if (source[openParenIndex + 1] !== '?') return 0;
  const marker = source[openParenIndex + 2];
  if (marker === ':' || marker === '=' || marker === '!') return 2;
  if (marker === '<') {
    const lookbehind = source[openParenIndex + 3];
    if (lookbehind === '=' || lookbehind === '!') return 3;
    // A named group: `?<`, the name, and the closing `>`. The marker runs from `?` (at
    // `openParenIndex + 1`) through `>` (at `nameEnd`) inclusive, so its length is the distance
    // between them, not one more — `nameEnd - openParenIndex + 1` over-counts by one character and
    // swallows the first character of the group's actual body along with the marker.
    const nameEnd = source.indexOf('>', openParenIndex + 3);
    return nameEnd - openParenIndex;
  }
  return 0;
}

/**
 * Refuse the regular-expression shapes whose match time is not bounded by document length.
 *
 * This is static inspection, chosen over a time bound (JavaScript regular expressions cannot be
 * interrupted once `matchAll` has entered the engine, so a "bound" would only be observed after
 * the hang it was meant to prevent) and over a linear-time engine (a second engine for one config
 * field). It costs a single scan of the source and no match time at all.
 *
 * Four shapes are refused, each because a repetition wraps something that can consume the same
 * span more than one way: a repetition applied to a group that already repeats — `(\d+)+`,
 * `(a*)*`, `(?:x+|y)+`, the classic exponential forms; a repetition applied to a group containing
 * an alternation — `(a|ab)*` — because deciding whether the branches are ambiguous is exactly the
 * analysis this cheap screen does not do; a repetition applied to a group containing an optional
 * element — `(a?)+` — because each iteration can consume or skip the optional atom, which is the
 * same ambiguity reached through `?`/`{0,n}` instead of `+`/`*`; and two range-quantified atoms
 * that are immediately adjacent and can match an overlapping set of characters — `\d+\d+x`,
 * `a*[ab]*` — because the ambiguity is at the boundary between the two repeats, not inside either
 * one, so it needs no nesting or alternation to be exponentially costly in the number of adjacent
 * repeats.
 *
 * The screen is deliberately syntactic, and therefore both over- and under-approximates. It refuses
 * `(?:foo|bar)+`, which is harmless in practice, and for the adjacent-repetition shape specifically
 * it only proves overlap when both atoms' character sets are cheaply enumerable (see
 * {@link atomCharSet}) — two range-quantified atoms it cannot analyse that way, such as `[a-z]+` next
 * to `[0-9]+`, are accepted even where they happen to be disjoint or to overlap.
 * `docs/configuration.md` documents all four refused shapes, together with the workaround: rewrite
 * the repeated group so its body neither repeats, alternates, nor contains an optional element, and
 * so no two adjacent range-quantified atoms can match the same character.
 */
/** Whether `(` at `openParenIndex` opens a lookahead or lookbehind assertion. */
function isLookaroundMarker(source: string, openParenIndex: number): boolean {
  if (source[openParenIndex + 1] !== '?') return false;
  const marker = source[openParenIndex + 2];
  if (marker === '=' || marker === '!') return true;
  if (marker === '<') {
    const lookbehind = source[openParenIndex + 3];
    return lookbehind === '=' || lookbehind === '!';
  }
  return false;
}

/**
 * Every capturing-group key (its ordinal as a string, and its name if it has one) for a group not
 * nested inside a lookaround, anywhere in `source` — a lightweight pre-pass mirroring the same
 * group-numbering and lookaround-nesting rules {@link canOnlyMatchEmpty}'s main walk uses
 * ({@link capturingGroupNameAt}, {@link isLookaroundMarker}), but without tracking consumption,
 * since numbering is all this needs.
 *
 * Exists so a *forward* backreference (`\1()`, `\k<x>(?<x>)`) can be told apart from a reference to
 * a group the main walk never tracks at all (nested inside a lookaround): both are absent from
 * `canOnlyMatchEmpty`'s `groupEmptyOnly` map at the point the backreference is scanned, in a single
 * left-to-right pass, but they mean opposite things — a forward reference to a group *this walk
 * will eventually see* always matches empty (JavaScript: a backreference to a capture that has not
 * yet participated matches the empty string), while a reference to a group permanently out of this
 * walk's scope is genuinely unknown and stays conservatively "may consume". Found in external
 * review of PR #73: `\1()` and `\k<x>(?<x>)` — both provably zero-width-only — were accepted
 * because the earlier version of the backreference lookup could not distinguish the two.
 */
function collectTrackableGroupKeys(source: string): ReadonlySet<string> {
  const keys = new Set<string>();
  const lookaroundStack: boolean[] = [];
  let lookaroundDepth = 0;
  let nextGroupNumber = 1;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += escapeAtomLength(source, i);
      continue;
    }
    if (ch === '[') {
      i += 1;
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === '(') {
      const isLookaround = isLookaroundMarker(source, i);
      lookaroundStack.push(isLookaround);
      if (isLookaround) {
        lookaroundDepth += 1;
      } else {
        const capture = capturingGroupNameAt(source, i);
        if (capture !== false) {
          const number = nextGroupNumber;
          nextGroupNumber += 1;
          if (lookaroundDepth === 0) {
            keys.add(String(number));
            if (capture !== undefined) keys.add(capture);
          }
        }
      }
      i += 1 + groupMarkerLength(source, i);
      continue;
    }
    if (ch === ')') {
      if (lookaroundStack.pop() === true) lookaroundDepth -= 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return keys;
}

/**
 * Whether `(` at `openParenIndex` opens a capturing group, and its name if it has one — `false`
 * for a non-capturing group or a lookaround, `undefined` for an unnamed capturing group, or the
 * name for a named one. Used by {@link canOnlyMatchEmpty} to assign JavaScript's left-to-right
 * capturing-group numbers and to key its per-group emptiness map by both number and name, since a
 * backreference can spell either (`\1` or `\k<name>`). Parses the same five marker forms as
 * {@link groupMarkerLength} and {@link isLookaroundMarker}, from the capturing side of that split.
 */
function capturingGroupNameAt(source: string, openParenIndex: number): string | undefined | false {
  if (source[openParenIndex + 1] !== '?') return undefined; // plain `(`: capturing, unnamed
  const marker = source[openParenIndex + 2];
  if (marker === ':' || marker === '=' || marker === '!') return false;
  if (marker === '<') {
    const lookbehind = source[openParenIndex + 3];
    if (lookbehind === '=' || lookbehind === '!') return false; // lookbehind, not a name
    const nameEnd = source.indexOf('>', openParenIndex + 3);
    return source.slice(openParenIndex + 3, nameEnd);
  }
  return false;
}

/**
 * Whether `source` can only ever produce a zero-length match, e.g. `^`, `(?=PN)`, `\b` alone.
 *
 * Walks the pattern once, tracking one thing: whether a *consuming* atom — a literal character, an
 * escape other than the zero-width assertions `\b`/`\B`, or a character class — occurs anywhere
 * outside a lookaround assertion, is itself capable of consuming at all. Lookaround content never
 * advances the match position no matter what it contains, so `(?=PN)` alone is zero-width-only even
 * though `PN` inside it consumes two characters when the assertion itself is tested; `(?=PN)PN` is
 * not, because of the second `PN` outside the assertion. `^`, `$` and `|` are structural, not
 * consuming, either way. An atom or group quantified with an exact zero count (`a{0}`, `(PN){0}`)
 * can never actually run regardless of what it is, so it does not count either — resolved together
 * with its own trailing quantifier, the same way {@link complexityRejection} resolves an atom and
 * its quantifier as one step, for the same reason: judging before that quantifier has been seen
 * would call `a{0}` or `(PN){0}` consuming when neither can ever run.
 *
 * A backreference (`\1`, `\k<name>`) consumes only if the group it refers to can — a backreference
 * to a group that can only ever capture empty is itself zero-width, found in external review of
 * PR #73 (`()\1`, `(a{0})\1`, `(?<x>)\k<x>` all previously accepted, since the escape branch
 * treated every backreference as an ordinary consuming escape). Groups are recorded as they close,
 * keyed by both number and name, so a later backreference — the only order this matters in, since a
 * backreference to a group that has not yet closed can never have captured anything and is already
 * always empty regardless — can look its group up.
 *
 * This under-approximates on purpose, matching the rest of this screen: a pattern this walk cannot
 * prove is zero-width-only is accepted, not flagged on suspicion. A backreference to a group this
 * walk did not resolve — including one nested inside a lookaround, out of scope for the same reason
 * lookaround content is never tracked for consumption — is conservatively treated as consuming.
 */
function canOnlyMatchEmpty(source: string): boolean {
  const trackableGroupKeys = collectTrackableGroupKeys(source);
  let i = 0;
  let lookaroundDepth = 0;
  const lookaroundStack: boolean[] = [];
  // One entry per currently-open *ordinary* (non-lookaround) group not itself nested inside a
  // lookaround, tracking whether anything in its body so far can consume. Index 0 is the whole
  // pattern. A group whose own trailing quantifier turns out to have a maximum of exactly zero
  // (`(PN){0}`) never runs regardless of what is marked here — found in external review of PR #73
  // as a shape the previous, immediate-`return false` version of this function got wrong by
  // deciding before it had seen that quantifier at all. Judgment is deferred to `)` for exactly
  // this reason; the final verdict is read from index 0 once the whole pattern has been walked.
  const consumingStack: boolean[] = [false];
  // Parallel to `lookaroundStack`, one entry per `(` of any kind: the capturing-group keys (its
  // ordinal as a string, and its name if it has one) to record in `groupEmptyOnly` once the group
  // closes, or `undefined` for a non-capturing group, a lookaround, or a capturing group nested
  // inside one (whose own emptiness this walk does not track — same scope limit as everywhere else
  // lookaround content is involved).
  const captureKeyStack: (readonly string[] | undefined)[] = [];
  let nextGroupNumber = 1;
  const groupEmptyOnly = new Map<string, boolean>();

  function markConsuming(): void {
    if (lookaroundDepth > 0) return;
    consumingStack[consumingStack.length - 1] = true;
  }

  /**
   * Consumes the quantifier (if any) at `i` and reports whether whatever it was just called for
   * can still run at least sometimes — false only when that quantifier's maximum is exactly zero
   * (`{0}`), the one shape where an otherwise-consuming atom or group provably never runs. Always
   * called, even inside a lookaround or when the preceding thing already can't consume, so `i`
   * stays correctly positioned for the rest of the scan either way.
   */
  function stillConsumes(): boolean {
    const quantifier = quantifierAt(source, i);
    if (quantifier !== undefined) i += quantifier.length;
    return quantifier?.max !== 0;
  }

  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      const backreference = /^\\(?:([1-9]\d*)|k<([^>]+)>)/.exec(source.slice(i));
      if (backreference !== null) {
        const key = backreference[1] ?? backreference[2] ?? '';
        i += backreference[0].length;
        // `resolved` is set once the target group has closed (this pass is left-to-right, same
        // order source appears in). Not yet set means either a forward reference to a group this
        // walk hasn't reached yet — always empty, see `collectTrackableGroupKeys` — or a
        // reference to a group permanently out of scope, conservatively treated as consuming.
        const resolved = groupEmptyOnly.get(key);
        const emptyOnly = resolved ?? trackableGroupKeys.has(key);
        if (!emptyOnly && stillConsumes()) markConsuming();
        continue;
      }
      const escaped = source[i + 1];
      i += escapeAtomLength(source, i);
      if (escaped !== 'b' && escaped !== 'B' && stillConsumes()) markConsuming();
      continue;
    }
    if (ch === '[') {
      i += 1;
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      i += 1;
      if (stillConsumes()) markConsuming();
      continue;
    }
    if (ch === '(') {
      const isLookaround = isLookaroundMarker(source, i);
      lookaroundStack.push(isLookaround);
      if (isLookaround) {
        lookaroundDepth += 1;
        captureKeyStack.push(undefined);
      } else {
        if (lookaroundDepth === 0) consumingStack.push(false);
        const capture = capturingGroupNameAt(source, i);
        if (capture === false) {
          captureKeyStack.push(undefined);
        } else {
          const number = nextGroupNumber;
          nextGroupNumber += 1;
          captureKeyStack.push(
            lookaroundDepth === 0
              ? capture === undefined
                ? [String(number)]
                : [String(number), capture]
              : undefined,
          );
        }
      }
      i += 1 + groupMarkerLength(source, i);
      continue;
    }
    if (ch === ')') {
      const wasLookaround = lookaroundStack.pop();
      const keys = captureKeyStack.pop();
      i += 1;
      if (wasLookaround === true) {
        lookaroundDepth -= 1;
        continue;
      }
      // JS regular expressions have no syntax for quantifying a lookaround (`(?!x)+` is a syntax
      // error, verified directly), so only an ordinary group's own trailing quantifier can ever
      // neutralize what is inside it — `stillConsumes` always runs, both to keep `i` positioned
      // correctly for whatever follows and because its result is now also needed to record this
      // group's own emptiness for any backreference later in the pattern.
      const closedConsumes = lookaroundDepth === 0 ? (consumingStack.pop() ?? false) : false;
      const finalConsumes = closedConsumes && stillConsumes();
      if (finalConsumes) markConsuming();
      if (keys !== undefined) {
        for (const key of keys) groupEmptyOnly.set(key, !finalConsumes);
      }
      continue;
    }
    if (ch === '^' || ch === '$' || ch === '|') {
      i += 1;
      continue;
    }
    const bareQuantifier = quantifierAt(source, i);
    if (bareQuantifier !== undefined) {
      // A quantifier reached here without a preceding atom in this same iteration is repeating
      // whatever the *previous* iteration already classified and consumed past — nothing left to
      // re-check.
      i += bareQuantifier.length;
      continue;
    }
    // A bare literal atom: exactly one character, then whatever quantifier (if any) follows it.
    i += 1;
    if (stillConsumes()) markConsuming();
  }

  return !consumingStack[0];
}

/**
 * Regex metacharacters that mean something different outside a character class than the literal
 * character they spell inside one — `.` is "any character" bare but a literal dot in `[.]`; `^`,
 * `\`, `[`, `]`, `{`, `}`, `(`, `)`, `|`, `?`, `*`, `+` are all structural outside a class; `$` is
 * the zero-width end-of-string anchor bare but a literal dollar sign in `[$]`. A single-character
 * class built from one of these is therefore not a safe stand-in for the bare character.
 *
 * `-` is deliberately not in this set: it is only ever a range operator between two other
 * characters, so as the sole character in a class (`[-]`, neither first-of-two nor last-of-two)
 * it is unambiguously a literal hyphen — exactly what bare `-` already means outside a class too.
 * Everything else inside `[x]` means the same thing as the bare `x`.
 */
const CLASS_UNSAFE_METACHARACTERS = new Set([
  '\\',
  '^',
  '$',
  '.',
  '|',
  '?',
  '*',
  '+',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
]);

/**
 * Reduce a single-character class such as `[a]` to the bare literal `a` it is equivalent to, so
 * the adjacent-repetition streak below recognises `a*[a]*` as the same atom spelled two ways —
 * found in external review of PR #73 (`a*[a]*a*[a]*a*[a]*a*[a]*b`, confirmed 5.185s for 40 `a`s
 * before this fix, because `lastRangeQuantifiedAtom` compared the raw source text and `"a"` !==
 * `"[a]"`). Only a class of exactly `[` + one character + `]` qualifies: that shape rules out
 * escapes (`[\d]`), ranges (`[a-z]`), and negation (`[^a]`) without inspecting them separately, and
 * {@link CLASS_UNSAFE_METACHARACTERS} rules out the characters whose meaning changes outside the
 * class. Every other input is returned unchanged.
 */
function normalizeAtomText(atomText: string): string {
  if (atomText.length !== 3 || atomText[0] !== '[' || atomText[2] !== ']') return atomText;
  const inner = atomText[1];
  if (inner === undefined || CLASS_UNSAFE_METACHARACTERS.has(inner)) return atomText;
  return inner;
}

/**
 * The finite set of single characters `atomText` can match, when that set is cheaply enumerable —
 * a bare literal character, or a character class made up entirely of individual literal
 * characters, with no range, escape, or negation. `undefined` for anything else (`.`, `\d`,
 * `[a-z]`, `[^a]`, …): not because those provably can't overlap with another atom, but because
 * this parser does not attempt to prove it, the same "provable, not exhaustive" bias as the rest
 * of this screen. Used to catch two adjacent range-quantified atoms that are not textually
 * identical but can still match the same character — found in external review of PR #73
 * (`a*[ab]*a*[ab]*a*[ab]*a*[ab]*b`, confirmed 5.066s for 40 `a`s before this fix, because the
 * single-character-class normalization above only recognises `[a]` as equivalent to `a`, not `[ab]`
 * as *overlapping* with `a`).
 */
function atomCharSet(atomText: string): ReadonlySet<string> | undefined {
  if (atomText.length === 1) {
    // Bare `.` reaching here is always the wildcard metacharacter — a literal dot is scanned as
    // the escape `\.` instead, never as this one-character bare-atom case.
    return atomText === '.' ? undefined : new Set([atomText]);
  }
  if (atomText.length < 3 || atomText[0] !== '[' || atomText[atomText.length - 1] !== ']') {
    return undefined;
  }
  const inner = atomText.slice(1, -1);
  if (inner.length === 0 || inner.startsWith('^') || inner.includes('\\')) return undefined;
  // A `-` between two other characters is a range (`a-z`); only at either end, or alone, is it
  // unambiguously the literal hyphen — the same reasoning `normalizeAtomText` already applies.
  for (let k = 1; k < inner.length - 1; k += 1) {
    if (inner[k] === '-') return undefined;
  }
  return new Set(inner);
}

/** Whether two character sets share at least one member. */
function setsOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const ch of smaller) {
    if (larger.has(ch)) return true;
  }
  return false;
}

/**
 * Compare `atomText` (already established to be directly under a *range* quantifier) against
 * `frame.lastRangeQuantifiedAtom`, returning a rejection on a match and otherwise recording
 * `atomText` as the new value to compare the next one against.
 *
 * The comparison is two-layered: exact normalized text (`normalizeAtomText`) catches literal
 * spelling repeats and the single-character-class equivalence, and character-set overlap
 * (`atomCharSet`/`setsOverlap`) additionally catches two *different* atoms that can still match
 * the same character (`a*[ab]*`). Either is sufficient; neither is necessary — an atom whose set
 * is not enumerable (`.`, `\d`, `[a-z]`, …) still only matches via the exact-text path.
 *
 * Shared between {@link consumeQuantifier}, for a bare atom, and the `)` handler below, for a
 * closed non-empty ordinary group, fed its own body text (`GroupShape.bodyStart` through the
 * closing `)`) in place of a bare atom's text — the same comparison applies either way, since
 * `(?:a)*a*` is exactly as ambiguous as `a*a*`, and `(?:ab)*(?:ab)*` exactly as ambiguous as two
 * identical multi-character bodies repeated.
 */
function applyAdjacentAtom(
  source: string,
  frame: GroupShape,
  atomText: string,
): ProtectedPatternRejection | undefined {
  const normalized = normalizeAtomText(atomText);
  const charSet = atomCharSet(normalized);
  const previous = frame.lastRangeQuantifiedAtom;
  const sameText = previous?.text === normalized;
  const overlappingSets =
    previous?.charSet !== undefined &&
    charSet !== undefined &&
    setsOverlap(previous.charSet, charSet);
  if (previous !== undefined && (sameText || overlappingSets)) {
    return {
      source,
      reason: 'adjacent-repetition',
      explanation: sameText
        ? `"${atomText}" is independently repeated more than once in a row, so the same input ` +
          'can be divided between the repeats in more than one way'
        : `"${previous.text}" and "${atomText}" can match overlapping characters and are ` +
          'independently repeated back to back, so the same input can be divided between the ' +
          'repeats in more than one way',
    };
  }
  frame.lastRangeQuantifiedAtom = { text: normalized, charSet };
  return undefined;
}

function complexityRejection(source: string): ProtectedPatternRejection | undefined {
  // Index 0 is the whole pattern, which nothing can quantify; each `(` pushes a frame.
  const stack: GroupShape[] = [
    {
      repeats: false,
      alternates: false,
      optional: false,
      lastRangeQuantifiedAtom: undefined,
      bodyStart: 0,
    },
  ];
  // Parallel to `stack`, one entry per `(`: whether that group is a lookaround. Kept separate
  // from `GroupShape` because it answers a different question at a different time — not "what
  // does this group's body look like" but "does closing this group even happen at the same match
  // position it opened at" — consulted only by the `)` handler, to decide whether closing a
  // lookaround should leave `parent.lastRangeQuantifiedAtom` untouched (see there for why).
  const isLookaroundStack: boolean[] = [];
  let i = 0;

  /**
   * Read the quantifier (if any) at `i`, apply it to `frame`, and advance `i` past it.
   *
   * `atomText` is the exact source span of the bare atom this quantifier would apply to (escape,
   * character class, or single literal character), so an atom and its quantifier are always
   * resolved together in one step — never split across loop iterations the way the surrounding
   * scan otherwise processes one token per pass. That matters here specifically: the
   * adjacent-repetition check below must see every atom that turned out NOT to continue a streak
   * (a different atom, an exact-count quantifier, or no quantifier at all) and clear
   * `lastRangeQuantifiedAtom` for it before the *next* atom is checked against a stale value —
   * splitting atom production from quantifier detection across iterations, as the rest of this
   * scanner does, would leave that reset one atom late.
   */
  function consumeQuantifier(
    frame: GroupShape,
    atomText: string,
  ): ProtectedPatternRejection | undefined {
    const quantifier = quantifierAt(source, i);
    if (quantifier === undefined) {
      frame.lastRangeQuantifiedAtom = undefined;
      return undefined;
    }
    if (quantifier.max > 1) frame.repeats = true;
    if (quantifier.min === 0) frame.optional = true;
    // Only a *range* quantifier (min !== max) gives the engine more than one way to satisfy this
    // atom — `{2}` always consumes exactly two characters, with no ambiguity for a neighbour to
    // compound with, so it does not continue or start a streak. This is deliberately independent
    // of `max`: `?` (min 0, max 1) has exactly the same "consume it or don't" choice as `*`, and
    // chains into the identical adjacent-optional blowup (`a?a?a?…` is `2^n`, confirmed directly
    // against Node's engine), not just `*`/`+`-shaped ranges.
    if (quantifier.min !== quantifier.max) {
      const rejection = applyAdjacentAtom(source, frame, atomText);
      if (rejection !== undefined) return rejection;
    } else {
      frame.lastRangeQuantifiedAtom = undefined;
    }
    i += quantifier.length;
    return undefined;
  }

  while (i < source.length) {
    const ch = source[i];
    const frame = stack[stack.length - 1];
    if (frame === undefined) break; // Unbalanced `)`: `new RegExp` has already rejected it.

    if (ch === '\\') {
      // An escape sequence is one atom — `\(`, `\[`, `\|`, `\*` must not be read as structure, and
      // a Unicode property escape (`\p{L}`) is one atom through its closing `}`, not several.
      const atomStart = i;
      i += escapeAtomLength(source, i);
      const rejection = consumeQuantifier(frame, source.slice(atomStart, i));
      if (rejection !== undefined) return rejection;
      continue;
    }
    if (ch === '[') {
      const atomStart = i;
      i += 1;
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      i += 1;
      const rejection = consumeQuantifier(frame, source.slice(atomStart, i));
      if (rejection !== undefined) return rejection;
      continue;
    }
    if (ch === '|') {
      frame.alternates = true;
      frame.lastRangeQuantifiedAtom = undefined;
      i += 1;
      continue;
    }
    if (ch === '(') {
      // `frame.lastRangeQuantifiedAtom` is deliberately left untouched here, unlike every other
      // event in this scanner — the subgroup about to be pushed may turn out to be comparable
      // against exactly that streak value once it closes (`applyAdjacentAtom` in the `)` handler
      // below), so resetting it on open would destroy the state the comparison needs before it
      // ever runs. The `)` handler resets it in every case that does *not* end up comparable, so
      // nothing is left stale afterward — it is just cleared one step later than the other reset
      // points.
      isLookaroundStack.push(isLookaroundMarker(source, i));
      const bodyStart = i + 1 + groupMarkerLength(source, i);
      stack.push({
        repeats: false,
        alternates: false,
        optional: false,
        lastRangeQuantifiedAtom: undefined,
        bodyStart,
      });
      i = bodyStart;
      continue;
    }
    if (ch === ')') {
      const closed = stack.pop();
      const wasLookaround = isLookaroundStack.pop();
      const parent = stack[stack.length - 1];
      if (closed === undefined || parent === undefined) break;
      const quantifier = quantifierAt(source, i + 1);
      if (quantifier !== undefined && quantifier.max > 1) {
        if (closed.repeats) {
          return {
            source,
            reason: 'nested-quantifier',
            explanation:
              'a repetition quantifier is applied to a group whose body already repeats, so match ' +
              'time can grow exponentially with document length',
          };
        }
        if (closed.alternates) {
          return {
            source,
            reason: 'quantified-alternation',
            explanation:
              'a repetition quantifier is applied to a group containing an alternation, whose ' +
              'branches this screen cannot prove unambiguous',
          };
        }
        if (closed.optional) {
          return {
            source,
            reason: 'quantified-optional',
            explanation:
              'a repetition quantifier is applied to a group containing an optional element, so ' +
              'the same input span has more than one way to divide across iterations',
          };
        }
        parent.repeats = true;
      }
      // A group's shape is part of its parent's shape: `((\d+))+` must read as nested repetition.
      parent.repeats = parent.repeats || closed.repeats;
      parent.alternates = parent.alternates || closed.alternates;
      // The group itself is optional from the parent's point of view either because something
      // optional happened inside it, or because its own trailing quantifier makes the whole group
      // optional, e.g. the `(a+)?` in `((a+)?)+` — either way, a later outer repetition on `parent`
      // must see it.
      parent.optional = parent.optional || closed.optional || quantifier?.min === 0;
      const bodyText = source.slice(closed.bodyStart, i);
      if (wasLookaround === true || bodyText === '') {
        // Neither a lookaround nor a syntactically empty group (`()`) can advance the match
        // position, so neither can break adjacency between the atom before it and the atom after
        // it — `parent.lastRangeQuantifiedAtom` is left exactly as it was, regardless of what the
        // lookaround's own body contains (it never runs at the surrounding match position anyway)
        // or the empty group's own trailing quantifier says (repeating nothing is still nothing).
        // Found in external review of PR #73: `a*(?=a*)a*(?=a*)…` (eight `a*` separated by
        // lookaheads) confirmed 6.589s for 40 `a`s, and `a*()a*()…` (eight `a*` separated by empty
        // captures) confirmed 4.802s, both before this fix, because every closing `)` unconditionally
        // reset the streak. JS regular expressions have no syntax for quantifying a lookaround, so
        // `quantifier` here is always `undefined` for that case; this branch does not touch it.
      } else if (quantifier !== undefined && quantifier.min !== quantifier.max) {
        // A closed *ordinary*, non-empty group is compared against the streak the same way a bare
        // atom is, using its exact body text — `(?:a)*a*` is exactly as ambiguous as `a*a*`
        // (`applyAdjacentAtom`'s normalization and character-set logic still applies to a
        // single-character body), and `(?:ab)*(?:ab)*` is exactly as ambiguous as two identical
        // multi-character bodies repeated, caught by the same exact-text comparison the atom path
        // already relies on. Found in external review of PR #73: an earlier version of this fix
        // only recognised a group whose body was exactly one un-quantified bare atom, so
        // `(?:ab)*(?:ab)*…` (eight two-atom groups) confirmed 5.309s for 40 `ab` pairs before this
        // fix, because a group with more than one atom never had anything recorded to compare.
        const rejection = applyAdjacentAtom(source, parent, bodyText);
        if (rejection !== undefined) return rejection;
      } else {
        parent.lastRangeQuantifiedAtom = undefined;
      }
      i += 1 + (quantifier?.length ?? 0);
      continue;
    }

    // A bare literal atom: exactly one character, then whatever quantifier (if any) follows it.
    const atomStart = i;
    i += 1;
    const rejection = consumeQuantifier(frame, source.slice(atomStart, i));
    if (rejection !== undefined) return rejection;
  }

  return undefined;
}

/**
 * Split configured `extraPatterns` into the ones that may run and the ones that must be reported.
 *
 * Both defects this addresses are invisible by construction, which is why nothing here returns a
 * bare filtered list: a pattern that does not run means the literals it named are matched as
 * ordinary prose by every vocabulary rule *and* are no longer masked out of the passages sent to
 * the semantic service. The caller owes the operator a notice for every entry in `rejected`;
 * {@link ../analysis/analyse.ts} emits `invalid-protected-pattern` at `error` level.
 */
export function screenExtraPatterns(sources: readonly string[]): ScreenedProtectedPatterns {
  const accepted: string[] = [];
  const rejected: ProtectedPatternRejection[] = [];

  for (const source of sources) {
    if (source.length > MAX_PROTECTED_PATTERN_LENGTH) {
      rejected.push({
        source,
        reason: 'source-too-long',
        explanation:
          `the source is ${String(source.length)} characters, over the ` +
          `${String(MAX_PROTECTED_PATTERN_LENGTH)}-character limit for a protected pattern`,
      });
      continue;
    }
    try {
      // Compiling is the check. The compiled instance is discarded because each consumer needs its
      // own — a shared global regex carries `lastIndex` between documents.
      void new RegExp(source, 'gu');
    } catch (error) {
      rejected.push({
        source,
        reason: 'invalid-syntax',
        explanation: `it is not a valid regular expression (${
          error instanceof Error ? error.message : String(error)
        })`,
      });
      continue;
    }
    const complexity = complexityRejection(source);
    if (complexity !== undefined) {
      rejected.push(complexity);
      continue;
    }
    if (canOnlyMatchEmpty(source)) {
      rejected.push({
        source,
        reason: 'matches-only-empty',
        explanation: 'every possible match is zero-length, so it can never protect a span of text',
      });
      continue;
    }
    accepted.push(source);
  }

  return { accepted, rejected };
}

// ---------------------------------------------------------------------------
// Individual passes, in application order.
// ---------------------------------------------------------------------------

/** YAML/TOML front matter, only at offset 0. */
const frontMatterPass: Pass = {
  kind: 'front-matter',
  opaque: true,
  note: 'Front matter is metadata, not prose.',
  find: (masked) => {
    const m = /^(---|\+\+\+)\r?\n[\s\S]*?\r?\n\1[ \t]*(?:\r?\n|$)/.exec(masked);
    return m ? [{ start: 0, end: m[0].length }] : [];
  },
};

/**
 * Fenced code blocks. The fence lines are protected together with the content so that a
 * language tag is never read as prose.
 */
const fencedCodePass: Pass = {
  kind: 'fenced-code',
  opaque: true,
  note: 'Fenced code must never be rewritten or lexically judged.',
  find: (masked) => {
    const out: SourceRange[] = [];
    const re = /^([ \t]{0,3})(`{3,}|~{3,})[^\n]*\n?/gm;
    let searchFrom = 0;
    while (searchFrom < masked.length) {
      re.lastIndex = searchFrom;
      const open = re.exec(masked);
      if (open === null) break;
      const fence = open[2] ?? '';
      const marker = fence[0] ?? '`';
      const bodyStart = open.index + open[0].length;
      const closeRe = new RegExp(
        `^[ \\t]{0,3}${marker.repeat(fence.length)}${marker}*[ \\t]*$`,
        'm',
      );
      const rest = masked.slice(bodyStart);
      const close = closeRe.exec(rest);
      const end = close === null ? masked.length : bodyStart + close.index + close[0].length;
      out.push({ start: open.index, end });
      searchFrom = end;
    }
    return out;
  },
};

const htmlCommentPass: Pass = {
  kind: 'comment',
  opaque: true,
  note: 'HTML comments are not reader-visible prose.',
  find: regexPass(/<!--[\s\S]*?-->/g),
};

const htmlBlockPass: Pass = {
  kind: 'html-block',
  opaque: true,
  note: 'Raw HTML block markup is structural.',
  find: regexPass(/^[ \t]{0,3}<\/?[A-Za-z][^\n>]*>[ \t]*$/gm),
};

const htmlInlinePass: Pass = {
  kind: 'html-inline',
  opaque: true,
  note: 'Inline HTML tags are structural markup, not words.',
  find: regexPass(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>\n]*)?\/?>/g),
};

/** Indented code blocks: 4+ spaces after a blank line, outside list content. */
const indentedCodePass: Pass = {
  kind: 'indented-code',
  opaque: true,
  note: 'Indented code block.',
  find: (masked) => {
    const out: SourceRange[] = [];
    const lines: { start: number; end: number; text: string }[] = [];
    let offset = 0;
    for (const line of masked.split('\n')) {
      lines.push({ start: offset, end: offset + line.length, text: line });
      offset += line.length + 1;
    }
    let previousBlank = true;
    let listContext = false;
    let run: { start: number; end: number } | null = null;
    for (const line of lines) {
      const blank = line.text.trim().length === 0;
      const indented = /^(?: {4}|\t)/.test(line.text) && !blank;
      if (!blank && !indented) {
        listContext = /^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]/.test(line.text);
      }
      if (indented && previousBlank && !listContext && run === null) {
        run = { start: line.start, end: line.end };
      } else if (run !== null && (indented || blank)) {
        run.end = line.end;
      } else if (run !== null) {
        out.push({ start: run.start, end: run.end });
        run = null;
      }
      if (!blank) previousBlank = false;
      else previousBlank = true;
    }
    if (run !== null) out.push(run);
    return out;
  },
};

/** Link reference definitions: `[label]: destination "title"`. */
const referenceDefinitionPass: Pass = {
  kind: 'reference-definition',
  opaque: true,
  note: 'Link reference definition.',
  find: regexPass(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S+[ \t]*(?:"[^"\n]*")?[ \t]*$/gm),
};

/** Inline code spans with backtick-run matching. */
const inlineCodePass: Pass = {
  kind: 'inline-code',
  opaque: true,
  note: 'Inline code is a literal.',
  find: (masked) => {
    const out: SourceRange[] = [];
    let i = 0;
    while (i < masked.length) {
      if (masked[i] !== '`') {
        i += 1;
        continue;
      }
      let runLength = 0;
      while (masked[i + runLength] === '`') runLength += 1;
      const open = '`'.repeat(runLength);
      const searchFrom = i + runLength;
      let closeIndex = -1;
      let probe = searchFrom;
      while (probe < masked.length) {
        const found = masked.indexOf(open, probe);
        if (found < 0) break;
        let after = found + runLength;
        if (masked[after] === '`') {
          while (masked[after] === '`') after += 1;
          probe = after;
          continue;
        }
        closeIndex = found;
        break;
      }
      if (closeIndex < 0) {
        i += runLength;
        continue;
      }
      const end = closeIndex + runLength;
      if (masked.slice(i, end).includes('\n\n')) {
        i += runLength;
        continue;
      }
      out.push({ start: i, end });
      i = end;
    }
    return out;
  },
};

const mathPass: Pass = {
  kind: 'math',
  opaque: true,
  note: 'Mathematical notation.',
  find: (masked) => [
    ...regexPass(/\$\$[\s\S]*?\$\$/g)(masked, masked, defaultProtectedRegionOptions),
    ...regexPass(/(?<![\w$])\$(?!\s)[^$\n]{1,200}?(?<!\s)\$(?![\w$])/g)(
      masked,
      masked,
      defaultProtectedRegionOptions,
    ),
  ],
};

/**
 * `[text](destination "title")` — protect the destination, keep the link text as prose.
 *
 * The lookbehind matters: masking the `]` as well would leave the opening `[` unpaired, and
 * sentence-splitter's pair tracking then treats the remainder of the block as being inside a
 * bracket, collapsing every following sentence into one. The mask must keep brackets balanced.
 */
const linkDestinationPass: Pass = {
  kind: 'link-destination',
  opaque: true,
  note: 'Link destination is a literal address.',
  find: regexPass(
    /(?<=\])\((?:<[^>\n]*>|[^()\s]*(?:\([^()\s]*\))?[^()\s]*)(?:[ \t]+"[^"\n]*")?\)/g,
    0,
  ),
};

const autolinkPass: Pass = {
  kind: 'autolink',
  opaque: true,
  note: 'Autolink.',
  find: regexPass(/<(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|mailto:)[^>\s]+>/g),
};

const urlPass: Pass = {
  kind: 'url',
  opaque: true,
  note: 'URL.',
  find: regexPass(/\b(?:https?|ftps?|file|ssh|git):\/\/[^\s<>"')\]]+/g),
};

const emailPass: Pass = {
  kind: 'email',
  opaque: true,
  note: 'Email address.',
  find: regexPass(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g),
};

/**
 * GFM table markup: the delimiter row in full, and every pipe character of a table row.
 * Cell contents stay as prose so ordinary rules still apply inside cells.
 */
const tableMarkupPass: Pass = {
  kind: 'table-markup',
  opaque: true,
  note: 'Table structural markup.',
  find: (masked) => {
    const out: SourceRange[] = [];
    const lines: { start: number; text: string }[] = [];
    let offset = 0;
    for (const line of masked.split('\n')) {
      lines.push({ start: offset, text: line });
      offset += line.length + 1;
    }
    const delimiter = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;
    const inTable: boolean[] = Array.from({ length: lines.length }, () => false);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const next = lines[i + 1];
      if (line === undefined) continue;
      if (line.text.includes('|') && next !== undefined && delimiter.test(next.text)) {
        // header + delimiter + following contiguous rows containing a pipe
        inTable[i] = true;
        out.push({ start: next.start, end: next.start + next.text.length });
        inTable[i + 1] = true;
        for (let j = i + 2; j < lines.length; j += 1) {
          const row = lines[j];
          if (row === undefined || !row.text.includes('|') || row.text.trim().length === 0) break;
          inTable[j] = true;
        }
      }
    }
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined || inTable[i] !== true) continue;
      for (let c = 0; c < line.text.length; c += 1) {
        if (line.text[c] === '|') out.push({ start: line.start + c, end: line.start + c + 1 });
      }
    }
    return out;
  },
};

const headingMarkerPass: Pass = {
  kind: 'heading-marker',
  opaque: true,
  note: 'Heading marker.',
  find: regexPass(/^[ \t]{0,3}(#{1,6})[ \t]+/gm, 0),
};

const blockquoteMarkerPass: Pass = {
  kind: 'blockquote-marker',
  opaque: true,
  note: 'Blockquote marker.',
  find: regexPass(/^[ \t]{0,3}(?:>[ \t]?)+/gm),
};

const listMarkerPass: Pass = {
  kind: 'list-marker',
  opaque: true,
  note: 'List marker; the ordinal is not a prose word.',
  find: regexPass(/^[ \t]*(?:[-*+]|\d{1,9}[.)])(?=[ \t])[ \t]*/gm),
};

/**
 * Emphasis markers. Single `_` is excluded on purpose: markdown does not treat intraword
 * underscores as emphasis, and masking them would destroy `snake_case` identifiers before the
 * identifier pass could recognise them.
 */
const emphasisMarkerPass: Pass = {
  kind: 'emphasis-marker',
  opaque: true,
  note: 'Emphasis marker.',
  find: regexPass(/\*{1,3}|__|~~/g),
};

const footnotePass: Pass = {
  kind: 'footnote-marker',
  opaque: true,
  note: 'Footnote reference.',
  find: regexPass(/\[\^[^\]\n]+\]/g),
};

/** `{{var}}`, `<PLACEHOLDER>`, `${VAR}`, `%s`, `%(name)s`, `$1`. */
const placeholderPass: Pass = {
  kind: 'placeholder',
  opaque: true,
  note: 'Placeholder token.',
  find: (masked) => [
    ...regexPass(/\{\{[^}\n]{1,120}\}\}/g)(masked, masked, defaultProtectedRegionOptions),
    ...regexPass(/\$\{[^}\n]{1,120}\}/g)(masked, masked, defaultProtectedRegionOptions),
    ...regexPass(/<[A-Z][A-Z0-9_-]{1,60}>/g)(masked, masked, defaultProtectedRegionOptions),
    ...regexPass(/%(?:\([A-Za-z_][A-Za-z0-9_]*\))?[sdifr]\b/g)(
      masked,
      masked,
      defaultProtectedRegionOptions,
    ),
    ...regexPass(/\$(?:[A-Z_][A-Z0-9_]{1,60}|\d{1,2})\b/g)(
      masked,
      masked,
      defaultProtectedRegionOptions,
    ),
  ],
};

const shellCommandPass: Pass = {
  kind: 'shell-command',
  opaque: true,
  note: 'Shell command line.',
  find: regexPass(/^[ \t]{0,3}[$#][ \t]+\S.*$/gm),
};

/** POSIX and Windows paths, and dotted relative paths. */
const filePathPass: Pass = {
  kind: 'file-path',
  opaque: true,
  note: 'File path.',
  find: (masked) => [
    ...regexPass(/(?:^|(?<=[\s("'[]))(?:\.{1,2}\/|\/)[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~*-]+)*\/?/g)(
      masked,
      masked,
      defaultProtectedRegionOptions,
    ),
    ...regexPass(/\b[A-Za-z]:\\[^\s"'<>|]+/g)(masked, masked, defaultProtectedRegionOptions),
    ...regexPass(/\b[A-Za-z0-9_-]+(?:\/[A-Za-z0-9._-]+)+\.[A-Za-z0-9]{1,8}\b/g)(
      masked,
      masked,
      defaultProtectedRegionOptions,
    ),
  ],
};

/**
 * Configuration assignments that appear outside a code fence.
 *
 * Deliberately strict: the value must be a single token and, for the `:` form, the key must be
 * lowercase. Without those constraints the pattern swallows admonition prose such as
 * `WARNING: Do not touch the busbar.` and `Note: see section 4.`, which are exactly the
 * passages this linter most needs to read.
 */
const configFragmentPass: Pass = {
  kind: 'config-fragment',
  opaque: true,
  note: 'Configuration key/value fragment.',
  find: (masked) => [
    ...regexPass(/^[ \t]{0,3}[A-Za-z_][A-Za-z0-9_.-]*[ \t]*=[ \t]*\S+[ \t]*$/gm)(
      masked,
      masked,
      defaultProtectedRegionOptions,
    ),
    ...regexPass(/^[ \t]{0,3}[a-z_][a-z0-9_.-]*[ \t]*:[ \t]*\S+[ \t]*$/gm)(
      masked,
      masked,
      defaultProtectedRegionOptions,
    ),
    // Mid-sentence assignment, e.g. `PRAGMA secure_delete=ON` or a quoted `auto_vacuum=FULL`.
    // Unlike the two alternatives above, this one is not anchored to line start/end. The key
    // must have at least one `_`/`.` separator (so a bare single word can never satisfy it) and
    // the value grammar never absorbs a trailing `.`, so a sentence-final period stays prose.
    ...regexPass(
      /\b(?:[A-Z]{2,12}[ \t]+)?[a-z][a-z0-9]*(?:[_.][a-z0-9]+)+=[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*/g,
    )(masked, masked, defaultProtectedRegionOptions),
  ],
};

/**
 * Identifiers: CamelCase, snake_case, SCREAMING_SNAKE, dotted API paths, function calls,
 * flags, and mixed alphanumeric part numbers. These are not ordinary words.
 */
const identifierPass: Pass = {
  kind: 'identifier',
  opaque: true,
  note: 'Code-shaped identifier.',
  find: (masked) => {
    const patterns: RegExp[] = [
      // Dotted API path or function call. Every segment must be at least two characters so
      // that `e.g.`, `i.e.` and `U.S.` stay prose and are handled by the abbreviation rule.
      /\b[A-Za-z_][A-Za-z0-9_]+(?:\.[A-Za-z_][A-Za-z0-9_]+)+(?:\(\s*\))?/g,
      /\b[A-Za-z_][A-Za-z0-9_]*\(\s*\)/g,
      // snake_case and SCREAMING_SNAKE_CASE
      /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g,
      // internal CamelCase (requires a lower→upper transition after the first char)
      /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g,
      /\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g,
      // CLI flags
      /(?:^|(?<=\s))--?[A-Za-z][A-Za-z0-9-]*\b/g,
      // part numbers / mixed alphanumerics with a digit and a letter and a separator
      /\b[A-Z]{1,6}[0-9]{1,6}(?:[-/][A-Z0-9]{1,6})+\b/g,
      /\b[A-Z]{2,}[0-9]{2,}\b/g,
      // Standards-body citation numbers, e.g. `RFC 3986`, `FIPS 140-2`, `ISO 9001`.
      /\b[A-Z]{2,6}[ \t]\d{1,6}(?:[.-]\d+)*\b/g,
    ];
    const out: SourceRange[] = [];
    for (const re of patterns) {
      for (const m of masked.matchAll(re)) {
        if (containsMask(m[0])) continue;
        out.push({ start: m.index, end: m.index + m[0].length });
      }
    }
    return out;
  },
};

/**
 * Numeric expressions: quantities with units, tolerances, ranges, versions, percentages,
 * temperatures. Protected because rewriting a number is never acceptable, and because unit
 * abbreviations are not prose words.
 */
const numericPass: Pass = {
  kind: 'numeric-expression',
  opaque: true,
  note: 'Quantity, tolerance, version, or unit expression.',
  find: (masked) => {
    const patterns: RegExp[] = [
      /[+±-]?\d+(?:[.,]\d+)?(?:\s?[×x]\s?10\^?-?\d+)?\s?(?:°[CF]|K\b|%|mm|cm|m\b|km|in\b|ft\b|mil\b|µm|nm|kg|g\b|mg|lb\b|oz\b|N·m|Nm\b|lbf(?:·|-)?(?:ft|in)?|Pa\b|kPa|MPa|bar\b|psi\b|V\b|mV|kV|A\b|mA|W\b|kW|MW|Hz|kHz|MHz|GHz|Ω|ohm|ohms|F\b|µF|nF|pF|s\b|ms\b|µs|ns\b|min\b|h\b|hr\b|dB\b|rpm\b|L\b|mL\b|gal\b|B\b|KB|MB|GB|TB|Kib|KiB|MiB|GiB|TiB|bps|kbps|Mbps|Gbps)/g,
      /\b\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.]+)?\b/g,
      /[+-]?\d+(?:\.\d+)?\s?±\s?\d+(?:\.\d+)?/g,
      /\b\d+(?:\.\d+)?\s?(?:to|–|—|-)\s?\d+(?:\.\d+)?\b/g,
      /\b0x[0-9A-Fa-f]+\b/g,
      /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g,
    ];
    const out: SourceRange[] = [];
    for (const re of patterns) {
      for (const m of masked.matchAll(re)) {
        if (containsMask(m[0])) continue;
        out.push({ start: m.index, end: m.index + m[0].length });
      }
    }
    return out;
  },
};

/**
 * Quoted literal UI text: a short double-quoted span that reads like a label or button caption.
 * Restricted to at most four tokens where every token is capitalised or all-caps, which keeps
 * ordinary quoted prose out.
 */
const quotedLiteralPass: Pass = {
  kind: 'quoted-literal',
  opaque: true,
  note: 'Quoted literal UI text.',
  find: (masked) => {
    const out: SourceRange[] = [];
    for (const m of masked.matchAll(/"([^"\n]{1,60})"/g)) {
      const inner = m[1];
      if (inner === undefined || containsMask(inner)) continue;
      const tokens = inner.trim().split(/\s+/);
      if (tokens.length > 4) continue;
      const literalLooking = tokens.every((t) => /^[A-Z0-9][A-Za-z0-9._>-]*$/.test(t));
      if (!literalLooking) continue;
      out.push({ start: m.index, end: m.index + m[0].length });
    }
    return out;
  },
};

const approvedTermPass: Pass = {
  kind: 'approved-term',
  opaque: true,
  note: 'Project-approved technical term.',
  find: (masked, _raw, options) => {
    const out: SourceRange[] = [];
    for (const term of options.approvedTerms) {
      if (term.trim().length === 0) continue;
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'gu');
      for (const m of masked.matchAll(re)) {
        out.push({ start: m.index, end: m.index + m[0].length });
      }
    }
    return out;
  },
};

/**
 * Operator-supplied patterns.
 *
 * `find` returns `SourceRange[]` and has no channel for a notice, so it cannot be the place a
 * refusal is *reported* — {@link screenExtraPatterns} is called once per run by the analysis entry
 * point, which does have one. It is called again here so that the decision about which patterns may
 * reach the engine lives in exactly one function: `extractProtectedRegions` is public and is called
 * with unscreened sources by the evaluation harness (`src/evaluation/evaluate.ts`) and by tests.
 * Re-screening an already-accepted list is idempotent and costs one scan of each source.
 */
const extraPatternPass: Pass = {
  kind: 'identifier',
  opaque: true,
  note: 'User-supplied protected pattern.',
  find: (masked, _raw, options) => {
    const out: SourceRange[] = [];
    for (const source of screenExtraPatterns(options.extraPatterns).accepted) {
      const re = new RegExp(source, 'gu');
      for (const m of masked.matchAll(re)) {
        if (m[0].length === 0) continue;
        out.push({ start: m.index, end: m.index + m[0].length });
      }
    }
    return out;
  },
};

/**
 * Credential-shaped tokens sitting in bare prose.
 *
 * Everything else in this file protects spans because they are not *prose*. This pass protects
 * spans because they must not *leave the machine*. Fenced blocks, inline code and `KEY=value`
 * fragments already cover the common shapes, but a key pasted into a sentence — "The account uses
 * AKIAIOSFODNN7EXAMPLE" — is, structurally, an ordinary word, so it survived masking and was
 * transmitted verbatim to the semantic service. Masking it here closes that path for every
 * downstream consumer at once, because every passage the broker sends is built from masked text.
 *
 * The patterns are deliberately narrow. A false positive costs one unchecked word; a false
 * negative sends a live secret to a network service, so where a shape is ambiguous this pass
 * prefers to match. It is a mitigation, not a secret scanner: it does not detect low-entropy
 * secrets that are indistinguishable from prose, and no configuration turns it off.
 */
const credentialPass: Pass = {
  kind: 'credential',
  opaque: true,
  note: 'Credential-shaped token: withheld from analysis and from any model request.',
  find: (masked) => {
    const patterns: RegExp[] = [
      // PEM blocks, header line through footer line.
      /-----BEGIN[^\n]*-----[\s\S]*?-----END[^\n]*-----/g,
      // Vendor-prefixed tokens. The prefix is the evidence; the body only has to be long enough
      // that an ordinary hyphenated word cannot reach it.
      /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
      /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
      /\bsk-(?:live|test|proj|ant|or)?-?[A-Za-z0-9_-]{16,}\b/g,
      /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
      /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA|ASCA)[A-Z0-9]{12,}\b/g,
      /\bAIza[A-Za-z0-9_-]{30,}\b/g,
      /\bya29\.[A-Za-z0-9_-]{20,}\b/g,
      /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
      /\bnpm_[A-Za-z0-9]{30,}\b/g,
      // JSON Web Tokens: three base64url segments, the first of which decodes to `{"`.
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      // Hex digests and hex-encoded keys. 32 is the shortest that is not plausibly an identifier
      // a writer would type by hand, and prose has no 32-character all-hex words.
      /\b(?:[0-9a-f]{32,}|[0-9A-F]{32,})\b/g,
      // A credential noun bound to a value in prose. The value must carry a digit or be long,
      // which keeps "The password is set by the installer" out of the match.
      /\b(?:pass(?:word|phrase|wd)|secret|api[ -]?key|access[ -]?key|private[ -]?key|token|credential)s?\s*(?:is|are|=|:)\s*(["'`]?)([A-Za-z0-9_./+-]*(?:[0-9][A-Za-z0-9_./+-]*|[A-Za-z0-9_./+-]{11,}))\1/gi,
    ];
    const out: SourceRange[] = [];
    for (const re of patterns) {
      for (const m of masked.matchAll(re)) {
        if (containsMask(m[0])) continue;
        const value = m[2];
        if (value === undefined) {
          out.push({ start: m.index, end: m.index + m[0].length });
          continue;
        }
        // Only the value is protected; the sentence around it stays available to the prose rules,
        // which is the whole point of masking rather than dropping the passage.
        if (value.length < 4) continue;
        const rel = m[0].lastIndexOf(value);
        if (rel < 0) continue;
        out.push({ start: m.index + rel, end: m.index + rel + value.length });
      }
    }
    // Mixed-class high-entropy runs, checked separately because the class test is not expressible
    // as one regular expression without catastrophic alternation.
    for (const m of masked.matchAll(/\b[A-Za-z0-9_+/-]{24,}={0,2}(?![A-Za-z0-9_+/=-])/g)) {
      const token = m[0];
      if (containsMask(token)) continue;
      const classes =
        Number(/[a-z]/.test(token)) + Number(/[A-Z]/.test(token)) + Number(/[0-9]/.test(token));
      if (classes < 3) continue;
      out.push({ start: m.index, end: m.index + token.length });
    }
    return out;
  },
};

/**
 * Region kinds whose matched literal text represents a name a document author chose deliberately
 * (a config key/value, an identifier, a quoted literal, project terminology, or a product name) —
 * as opposed to a kind such as `url` or `credential` whose text is not a naming decision at all.
 * Used by {@link corroboratedConstantPass} to decide which earlier regions are eligible evidence.
 */
const NAMING_KINDS: ReadonlySet<ProtectedRegionKind> = new Set([
  'config-fragment',
  'identifier',
  'quoted-literal',
  'approved-term',
  'product-identifier',
]);

/** Shortest literal or segment {@link buildProtectedLiteralIndex} will index. */
const MIN_SEGMENT_LENGTH = 2;

/**
 * Builds the set of literal strings a bare all-caps token can be corroborated against: the full
 * text of every eligible naming region, plus each `_`/`.`/whitespace/quote/`=`-delimited segment
 * of that text that is itself all-caps (so `LLVM_ENABLE_PROJECTS` also indexes bare `LLVM`).
 */
function buildProtectedLiteralIndex(
  raw: string,
  priorRegions: readonly ProtectedRegion[],
): ReadonlySet<string> {
  const index = new Set<string>();
  for (const region of priorRegions) {
    if (!region.opaque || !NAMING_KINDS.has(region.kind)) continue;
    const literal = raw.slice(region.range.start, region.range.end).trim();
    if (literal.length >= MIN_SEGMENT_LENGTH) index.add(literal);
    for (const segment of literal.split(/[_.\-\s"'=]+/)) {
      if (segment.length >= MIN_SEGMENT_LENGTH && /^[A-Z0-9]+$/.test(segment)) {
        index.add(segment);
      }
    }
  }
  return index;
}

/**
 * Protects a bare all-caps token (e.g. `LLVM`, `FULL`, `ON`) that is not, on its own, shaped like
 * any other protected kind, but is corroborated elsewhere in the same document by a region a
 * naming-shaped pass already recognised (e.g. an `identifier` region `LLVM_ENABLE_PROJECTS`, or a
 * `config-fragment` region containing `=FULL`). A single non-iterative sweep: it only consults
 * `priorRegions` as accumulated by passes earlier in the same pass array, never spans it itself
 * produces, and never re-runs against its own output.
 */
const corroboratedConstantPass: Pass = {
  kind: 'constant',
  opaque: true,
  note: 'Bare token corroborated by a naming region elsewhere in the document.',
  find: (masked, raw, _options, priorRegions = []) => {
    const index = buildProtectedLiteralIndex(raw, priorRegions);
    const out: SourceRange[] = [];
    for (const m of masked.matchAll(/\b[A-Z][A-Z0-9]{1,9}\b/g)) {
      if (containsMask(m[0])) continue;
      if (!index.has(m[0])) continue;
      out.push({ start: m.index, end: m.index + m[0].length });
    }
    return out;
  },
};

const MARKDOWN_PASSES: readonly Pass[] = [
  frontMatterPass,
  fencedCodePass,
  htmlCommentPass,
  htmlBlockPass,
  indentedCodePass,
  referenceDefinitionPass,
  inlineCodePass,
  mathPass,
  linkDestinationPass,
  autolinkPass,
  urlPass,
  emailPass,
  tableMarkupPass,
  headingMarkerPass,
  blockquoteMarkerPass,
  listMarkerPass,
  footnotePass,
  htmlInlinePass,
  // Credentials run ahead of user terminology: a redaction guarantee that a terminology list can
  // switch off is not a guarantee.
  credentialPass,
  // User-declared terminology and user patterns run before every heuristic pass. Otherwise a
  // multi-word approved term such as `Acme WidgetPro` fails to match, because the heuristic
  // CamelCase pass has already masked half of it.
  approvedTermPass,
  extraPatternPass,
  placeholderPass,
  shellCommandPass,
  filePathPass,
  configFragmentPass,
  identifierPass,
  numericPass,
  // Emphasis runs after the identifier pass so that `**snake_case**` yields both a marker
  // region and an intact identifier region.
  emphasisMarkerPass,
  quotedLiteralPass,
  corroboratedConstantPass,
];

/** Plain text has no markdown structure, so structural passes are omitted. */
const PLAIN_TEXT_PASSES: readonly Pass[] = [
  urlPass,
  emailPass,
  credentialPass,
  approvedTermPass,
  extraPatternPass,
  placeholderPass,
  shellCommandPass,
  filePathPass,
  configFragmentPass,
  identifierPass,
  numericPass,
  quotedLiteralPass,
  corroboratedConstantPass,
];

/**
 * Extract every protected region from `text`.
 *
 * Passes run in a fixed order against progressively-masked text. A later pattern therefore
 * cannot match inside an already-protected span, which is what makes the result stable and
 * order-independent for callers.
 */
export function extractProtectedRegions(
  text: string,
  options: ProtectedRegionOptions = defaultProtectedRegionOptions,
): ProtectedRegion[] {
  const passes = options.format === 'markdown' ? MARKDOWN_PASSES : PLAIN_TEXT_PASSES;
  const regions: ProtectedRegion[] = [];
  const opaqueRanges: SourceRange[] = [];
  let masked = text;

  for (const pass of passes) {
    const found = pass.find(masked, text, options, regions);
    const clean = found.filter((r) => r.end > r.start && r.start >= 0 && r.end <= text.length);
    if (clean.length === 0) continue;
    for (const range of mergeRanges(clean)) {
      regions.push({ kind: pass.kind, range, opaque: pass.opaque, note: pass.note });
      if (pass.opaque) opaqueRanges.push(range);
    }
    masked = maskRanges(text, mergeRanges(opaqueRanges));
  }

  regions.sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end);
  return regions;
}

export function opaqueRangesOf(regions: readonly ProtectedRegion[]): SourceRange[] {
  return mergeRanges(regions.filter((r) => r.opaque).map((r) => r.range));
}
