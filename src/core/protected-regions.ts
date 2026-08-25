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
  | 'quantified-optional';

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
 * A lazy or possessive modifier (`+?`, `*+`) changes match semantics, not the size of the search
 * space, and is counted the same.
 */
function quantifierAt(source: string, index: number): QuantifierAt | undefined {
  const ch = source[index];
  if (ch === '*') return { min: 0, max: Number.POSITIVE_INFINITY, length: 1 };
  if (ch === '+') return { min: 1, max: Number.POSITIVE_INFINITY, length: 1 };
  if (ch === '?') return { min: 0, max: 1, length: 1 };
  if (ch !== '{') return undefined;
  const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(index));
  if (m === null) return undefined;
  const min = Number(m[1]);
  const max = m[2] === undefined ? min : m[3] === '' ? Number.POSITIVE_INFINITY : Number(m[3]);
  return { min, max, length: m[0].length };
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
    // A named group: `?<`, the name, and the closing `>`.
    const nameEnd = source.indexOf('>', openParenIndex + 3);
    return nameEnd - openParenIndex + 1;
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
 * Three shapes are refused, each because a repetition wraps a group whose body can consume the
 * same span more than one way: a repetition applied to a group that already repeats — `(\d+)+`,
 * `(a*)*`, `(?:x+|y)+`, the classic exponential forms; a repetition applied to a group containing
 * an alternation — `(a|ab)*` — because deciding whether the branches are ambiguous is exactly the
 * analysis this cheap screen does not do; and a repetition applied to a group containing an
 * optional element — `(a?)+` — because each iteration can consume or skip the optional atom, which
 * is the same ambiguity reached through `?`/`{0,n}` instead of `+`/`*`.
 *
 * The screen is deliberately syntactic, and therefore both over- and under-approximates. It refuses
 * `(?:foo|bar)+`, which is harmless in practice, and it does not refuse shapes whose cost comes
 * from two adjacent repetitions rather than nesting (`\d+\d+x`, polynomial rather than exponential).
 * `docs/configuration.md` documents all three refused shapes, together with the workaround: rewrite
 * the repeated group so its body neither repeats, alternates, nor contains an optional element.
 */
function complexityRejection(source: string): ProtectedPatternRejection | undefined {
  // Index 0 is the whole pattern, which nothing can quantify; each `(` pushes a frame.
  const stack: GroupShape[] = [{ repeats: false, alternates: false, optional: false }];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const frame = stack[stack.length - 1];
    if (frame === undefined) break; // Unbalanced `)`: `new RegExp` has already rejected it.

    if (ch === '\\') {
      // An escape sequence is one atom; skipping both characters keeps `\(`, `\[`, `\|` and `\*`
      // from being read as structure.
      i += 2;
      continue;
    }
    if (ch === '[') {
      i += 1;
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === '|') {
      frame.alternates = true;
      i += 1;
      continue;
    }
    if (ch === '(') {
      stack.push({ repeats: false, alternates: false, optional: false });
      i += 1 + groupMarkerLength(source, i);
      continue;
    }
    if (ch === ')') {
      const closed = stack.pop();
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
      i += 1 + (quantifier?.length ?? 0);
      continue;
    }

    const quantifier = quantifierAt(source, i);
    if (quantifier !== undefined) {
      if (quantifier.max > 1) frame.repeats = true;
      if (quantifier.min === 0) frame.optional = true;
      i += quantifier.length;
      continue;
    }
    i += 1;
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
