import { IMPERATIVE_VERBS } from './imperative-verbs.js';
import { trimRange } from './text.js';
import type {
  AdmonitionKind,
  BlockKind,
  DocumentFormat,
  SourceRange,
  TextBlock,
  TextMode,
} from './types.js';

export interface StructureOptions {
  readonly format: DocumentFormat;
  /** Extra verbs, lower-case base form, that mark a passage as an instruction. */
  readonly extraImperativeVerbs: readonly string[];
}

export const defaultStructureOptions: StructureOptions = {
  format: 'markdown',
  extraImperativeVerbs: [],
};

interface Line {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  /** Raw line text without the newline. */
  readonly raw: string;
  /** Masked line text (protected regions replaced), used for structural detection. */
  readonly masked: string;
}

function splitLines(raw: string, masked: string): Line[] {
  const out: Line[] = [];
  let offset = 0;
  const rawLines = raw.split('\n');
  const maskedLines = masked.split('\n');
  for (let i = 0; i < rawLines.length; i += 1) {
    const text = rawLines[i] ?? '';
    out.push({
      index: i,
      start: offset,
      end: offset + text.length,
      raw: text,
      masked: maskedLines[i] ?? text,
    });
    offset += text.length + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Admonition detection
// ---------------------------------------------------------------------------

const ADMONITION_WORDS: readonly [RegExp, AdmonitionKind][] = [
  [/\bdanger\b/i, 'danger'],
  [/\bwarning\b/i, 'warning'],
  [/\bcaution\b/i, 'caution'],
  [/\battention\b/i, 'caution'],
  [/\bimportant\b/i, 'note'],
  [/\bnotice\b/i, 'note'],
  [/\bnote\b/i, 'note'],
  [/\btip\b/i, 'note'],
];

/** `.. warning::`, `.. admonition:: Danger` — reStructuredText and MyST directives. */
const RST_DIRECTIVE_RE = /^\s*\.\.\s+([A-Za-z][A-Za-z-]*)::[ \t]*(.*)$/;
/** `[WARNING]` on a line of its own — AsciiDoc's block admonition label. */
const ASCIIDOC_LABEL_RE = /^\s*\[([A-Za-z]+)\][ \t]*$/;
/** `WARNING` alone on a line, with no colon. Bold and underline variants included. */
const BARE_LABEL_RE = /^\s*(?:\*{1,2}|_{1,2})?([A-Z][A-Z]{2,11})(?:\*{1,2}|_{1,2})?[ \t]*$/;

/**
 * Recognise the admonition register of a line.
 *
 * Covers the shapes that occur across the fixture corpus and the ecosystems it is drawn from:
 * GitHub alerts (`> [!WARNING]`), MkDocs/Material admonitions (`!!! warning`), directive fences
 * (`:::caution`), reStructuredText and MyST directives (`.. warning::`, `.. admonition:: Danger`),
 * AsciiDoc block labels (`[WARNING]`), and the plain leading-label form (`WARNING:` / `**Caution**`
 * / `Danger!` / a bare `WARNING` line). Returns `'none'` when the line carries no safety register.
 *
 * The reStructuredText forms are not decoration: three fixtures in this corpus are RST, and while
 * they were unrecognised every paragraph inside a `.. warning::` was treated as ordinary prose —
 * which meant the autofix gate, whose entire job is to never rewrite inside a safety admonition,
 * would have rewritten inside one.
 */
export function detectAdmonition(line: string): AdmonitionKind {
  const gfm = /^\s*>?\s*\[!([A-Za-z]+)\]/.exec(line);
  const mkdocs = /^\s*(?:!!!|\?\?\?)\+?\s+([A-Za-z]+)/.exec(line);
  const directive = /^\s*:{3,}\s*\{?([A-Za-z]+)\}?/.exec(line);
  const rst = RST_DIRECTIVE_RE.exec(line);
  // `.. admonition:: Danger` names the register in its argument; every other directive names it in
  // the directive itself, and its argument is a title that must not be read as a register.
  const rstWord = rst === null ? undefined : rst[1] === 'admonition' ? rst[2] : rst[1];
  const asciidoc = ASCIIDOC_LABEL_RE.exec(line);
  const label = /^\s*>?\s*(?:\*{1,2}|_{1,2})?([A-Z][A-Za-z]{2,11})(?:\*{1,2}|_{1,2})?\s*[:!]/.exec(
    line,
  );
  const bare = BARE_LABEL_RE.exec(line);
  const candidate =
    gfm?.[1] ??
    mkdocs?.[1] ??
    directive?.[1] ??
    rstWord ??
    asciidoc?.[1] ??
    label?.[1] ??
    bare?.[1];
  if (candidate === undefined || candidate.length === 0) return 'none';
  for (const [re, kind] of ADMONITION_WORDS) {
    if (re.test(candidate)) return kind;
  }
  return 'none';
}

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

const NEGATIVE_IMPERATIVE = /^(?:do not|don't|never|always)\b/i;

/**
 * Classify a passage as an instruction or a description.
 *
 * This is a **provisional heuristic**, not a parser: the first content word is compared against
 * a closed list of base-form technical action verbs, and a leading `Do not` / `Never` / `Always`
 * is treated as imperative. It has no part-of-speech model, so `Record the value` is procedural
 * while `Record the value is stored in flash` is misclassified. Rules that depend on the
 * distinction therefore emit review-required candidates rather than hard violations wherever the
 * classification changes the outcome.
 */
export function detectMode(text: string, options: StructureOptions): TextMode {
  const stripped = text.replace(/^[\s>*_-]+/, '');
  if (NEGATIVE_IMPERATIVE.test(stripped)) return 'procedural';
  const firstWord = /^[\p{L}]+/u.exec(stripped)?.[0]?.toLowerCase();
  if (firstWord === undefined) return 'descriptive';
  if (IMPERATIVE_VERBS.has(firstWord)) return 'procedural';
  if (options.extraImperativeVerbs.includes(firstWord)) return 'procedural';
  return 'descriptive';
}

// ---------------------------------------------------------------------------
// Block scanning
// ---------------------------------------------------------------------------

const LIST_ITEM_RE = /^([ \t]*)(?:([-*+])|(\d{1,9})[.)])[ \t]+/;
const HEADING_RE = /^[ \t]{0,3}(#{1,6})[ \t]+/;
const BLOCKQUOTE_RE = /^[ \t]{0,3}((?:>[ \t]?)+)/;
const TABLE_DELIM_RE = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;
const THEMATIC_BREAK_RE = /^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/**
 * Scan prose blocks with exact source offsets.
 *
 * `masked` must be the **structural** mask produced by
 * {@link import('./document.js').buildStructuralMask}: content protected regions (code, front
 * matter, URLs, identifiers, quantities) are masked, while structural markers (list markers,
 * heading markers, blockquote markers, table pipes, emphasis) remain visible — this scanner
 * needs those markers to find blocks at all. Blocks whose span carries no prose are dropped.
 */
export function scanBlocks(
  raw: string,
  masked: string,
  options: StructureOptions = defaultStructureOptions,
): TextBlock[] {
  const lines = splitLines(raw, masked);
  const blocks: TextBlock[] = [];
  let counter = 0;
  const nextId = (): string => `b${(counter += 1)}`;

  /** Admonition register inherited by following indented/quoted content. */
  let containerAdmonition: AdmonitionKind = 'none';
  let containerIndent = -1;
  /**
   * Register that applies to the next block only.
   *
   * AsciiDoc writes the label on its own line and the content at the *same* indent, so the
   * indent-scoped container above can never carry it: the very next line already satisfies
   * `indent <= containerIndent` and clears it. A one-shot register is the correct scope for that
   * shape, and consuming it on the next block keeps it from bleeding into the rest of the document.
   */
  let pendingAdmonition: AdmonitionKind = 'none';

  const push = (
    kind: BlockKind,
    range: SourceRange,
    depth: number,
    inList: boolean,
    admonitionHint: AdmonitionKind,
    listOrdinal?: number,
  ): void => {
    const trimmed = trimRange(raw, range);
    if (trimmed.end <= trimmed.start) return;
    const rawSlice = raw.slice(trimmed.start, trimmed.end);
    const maskedSlice = masked.slice(trimmed.start, trimmed.end);
    // A block made only of protected content and structural markers carries no prose.
    if (maskedSlice.replace(/[\s�#>*_~|+-]/g, '').length === 0) return;
    const pending = pendingAdmonition;
    pendingAdmonition = 'none';
    const own = detectAdmonition(rawSlice);
    const admonition = own !== 'none' ? own : pending !== 'none' ? pending : admonitionHint;
    const block: TextBlock = {
      id: nextId(),
      kind,
      range: trimmed,
      text: rawSlice,
      mode: kind === 'heading' ? 'descriptive' : detectMode(maskedSlice, options),
      admonition,
      depth,
      inList,
      ...(listOrdinal === undefined ? {} : { listOrdinal }),
    };
    blocks.push(block);
  };

  if (options.format === 'text') {
    let start: number | null = null;
    let end = 0;
    for (const line of lines) {
      const blank = line.masked.trim().length === 0;
      if (blank) {
        if (start !== null) push('paragraph', { start, end }, 0, false, 'none');
        start = null;
      } else {
        if (start === null) start = line.start;
        end = line.end;
      }
    }
    if (start !== null) push('paragraph', { start, end }, 0, false, 'none');
    return blocks;
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    const maskedText = line.masked;

    if (maskedText.trim().length === 0) {
      i += 1;
      continue;
    }

    if (THEMATIC_BREAK_RE.test(maskedText)) {
      i += 1;
      continue;
    }

    // Container-only admonition openers: the line names a register and carries no prose of its
    // own, so the register belongs to what follows.
    const opener = detectAdmonition(line.raw);
    const isBareOpener =
      opener !== 'none' &&
      (/^\s*(?:!!!|\?\?\?)\+?\s+[A-Za-z]+\s*(?:"[^"]*")?\s*$/.test(line.raw) ||
        /^\s*:{3,}\s*\{?[A-Za-z]+\}?\s*$/.test(line.raw) ||
        /^\s*>\s*\[![A-Za-z]+\]\s*$/.test(line.raw) ||
        // reStructuredText/MyST: `.. warning::`, optionally with a title on the same line. The
        // body is indented under it, which is exactly the scope the indent container models.
        RST_DIRECTIVE_RE.test(line.raw));
    if (isBareOpener) {
      containerAdmonition = opener;
      containerIndent = /^\s*/.exec(line.raw)?.[0].length ?? 0;
      i += 1;
      continue;
    }
    // AsciiDoc: `[WARNING]` labels the block that follows it at the same indent.
    if (opener !== 'none' && ASCIIDOC_LABEL_RE.test(line.raw)) {
      pendingAdmonition = opener;
      i += 1;
      continue;
    }
    const indent = /^[ \t]*/.exec(maskedText)?.[0].length ?? 0;
    if (containerAdmonition !== 'none' && indent <= containerIndent && !/^\s*>/.test(line.raw)) {
      containerAdmonition = 'none';
      containerIndent = -1;
    }

    // Heading
    // Heading. The range starts after the `#` marker, matching how list items exclude their
    // marker, so a diagnostic on a heading quotes the heading text and not the markup.
    const heading = HEADING_RE.exec(maskedText);
    if (heading !== null) {
      push(
        'heading',
        { start: line.start + heading[0].length, end: line.end },
        heading[1]?.length ?? 1,
        false,
        'none',
      );
      i += 1;
      continue;
    }

    // Table row → one block per cell
    const next = lines[i + 1];
    if (maskedText.includes('|') && next !== undefined && TABLE_DELIM_RE.test(next.masked)) {
      let row = i;
      while (row < lines.length) {
        const current = lines[row];
        if (current === undefined) break;
        if (current.masked.trim().length === 0) break;
        if (row !== i + 1 && current.masked.includes('|')) {
          for (const cell of splitTableCells(current)) {
            push('table-cell', cell, 0, false, containerAdmonition);
          }
        } else if (row !== i + 1) {
          break;
        }
        row += 1;
      }
      i = row;
      continue;
    }

    // List item (including lazy continuation lines)
    const listMatch = LIST_ITEM_RE.exec(maskedText);
    if (listMatch !== null) {
      const markerIndent = listMatch[1]?.length ?? 0;
      const contentStart = line.start + listMatch[0].length;
      let itemEnd = line.end;
      let j = i + 1;
      while (j < lines.length) {
        const cont = lines[j];
        if (cont === undefined) break;
        if (cont.masked.trim().length === 0) break;
        if (LIST_ITEM_RE.test(cont.masked)) break;
        if (HEADING_RE.test(cont.masked)) break;
        const contIndent = /^[ \t]*/.exec(cont.masked)?.[0].length ?? 0;
        if (contIndent < markerIndent) break;
        itemEnd = cont.end;
        j += 1;
      }
      const ordinalText = listMatch[3];
      push(
        'list-item',
        { start: contentStart, end: itemEnd },
        Math.floor(markerIndent / 2),
        true,
        containerAdmonition,
        ordinalText === undefined ? undefined : Number.parseInt(ordinalText, 10),
      );
      i = j;
      continue;
    }

    // Blockquote
    const quote = BLOCKQUOTE_RE.exec(maskedText);
    if (quote !== null) {
      const depth = (quote[1]?.match(/>/g) ?? []).length;
      let end = line.end;
      let admonition = detectAdmonition(line.raw);
      let j = i + 1;
      while (j < lines.length) {
        const cont = lines[j];
        if (cont === undefined) break;
        if (cont.masked.trim().length === 0) break;
        if (!BLOCKQUOTE_RE.test(cont.masked)) break;
        if (admonition === 'none') admonition = detectAdmonition(cont.raw);
        end = cont.end;
        j += 1;
      }
      // A GitHub alert opener (`> [!WARNING]`) is consumed as a bare container opener, so the
      // register for the quoted body comes from `containerAdmonition` when the body itself
      // carries no label.
      push(
        'block-quote',
        { start: line.start, end },
        depth,
        false,
        admonition !== 'none' ? admonition : containerAdmonition,
      );
      i = j;
      continue;
    }

    // Paragraph
    let end = line.end;
    let j = i + 1;
    while (j < lines.length) {
      const cont = lines[j];
      if (cont === undefined) break;
      if (cont.masked.trim().length === 0) break;
      if (
        LIST_ITEM_RE.test(cont.masked) ||
        HEADING_RE.test(cont.masked) ||
        BLOCKQUOTE_RE.test(cont.masked) ||
        THEMATIC_BREAK_RE.test(cont.masked)
      ) {
        break;
      }
      end = cont.end;
      j += 1;
    }
    push('paragraph', { start: line.start, end }, 0, false, containerAdmonition);
    i = j;
  }

  return blocks;
}

/** True when the character at `index` is escaped by an odd-length run of preceding backslashes. */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/**
 * Split a table row into cell ranges on unescaped pipes.
 *
 * GFM requires a literal pipe inside a table cell to be written `\|` even within a code span,
 * so an unescaped pipe is always a cell boundary and this split cannot break a code span.
 */
function splitTableCells(line: Line): SourceRange[] {
  const out: SourceRange[] = [];
  let cellStart = line.start;
  for (let c = 0; c <= line.raw.length; c += 1) {
    const abs = line.start + c;
    const atEnd = c === line.raw.length;
    const isBoundary = atEnd || (line.raw[c] === '|' && !isEscaped(line.raw, c));
    if (!isBoundary) continue;
    if (abs > cellStart) out.push({ start: cellStart, end: abs });
    cellStart = abs + 1;
  }
  return out;
}
