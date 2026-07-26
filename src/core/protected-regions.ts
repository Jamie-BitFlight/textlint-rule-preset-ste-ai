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
  /** Runs against the progressively-masked text so a pattern can never match inside code. */
  readonly find: (masked: string, raw: string, options: ProtectedRegionOptions) => SourceRange[];
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
    const inTable = new Array<boolean>(lines.length).fill(false);
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

const extraPatternPass: Pass = {
  kind: 'identifier',
  opaque: true,
  note: 'User-supplied protected pattern.',
  find: (masked, _raw, options) => {
    const out: SourceRange[] = [];
    for (const source of options.extraPatterns) {
      let re: RegExp;
      try {
        re = new RegExp(source, 'gu');
      } catch {
        continue;
      }
      for (const m of masked.matchAll(re)) {
        if (m[0].length === 0) continue;
        out.push({ start: m.index, end: m.index + m[0].length });
      }
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
];

/** Plain text has no markdown structure, so structural passes are omitted. */
const PLAIN_TEXT_PASSES: readonly Pass[] = [
  urlPass,
  emailPass,
  approvedTermPass,
  extraPatternPass,
  placeholderPass,
  shellCommandPass,
  filePathPass,
  identifierPass,
  numericPass,
  quotedLiteralPass,
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
    const found = pass.find(masked, text, options);
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
