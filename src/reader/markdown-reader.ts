import { parse } from '@textlint/markdown-to-ast';
import type {
  AnyTxtNode,
  TxtBlockQuoteNode,
  TxtCodeBlockNode,
  TxtHeaderNode,
  TxtListItemNode,
  TxtListNode,
  TxtParagraphNode,
  TxtTableCellNode,
  TxtTableNode,
  TxtTableRowNode,
} from '@textlint/ast-node-types';
import {
  detectAdmonition,
  detectMode,
  defaultStructureOptions,
  isAdmonitionLabelLine,
  isBareAdmonitionOpener,
} from '../core/structure.js';
import type { AdmonitionKind, SourceDocument, SourceRange, TextMode } from '../core/types.js';
import type { TextUnit } from './types.js';

/**
 * Reads Markdown through a real parser (`@textlint/markdown-to-ast`) instead of the regex-driven
 * block scanner in `src/core/structure.ts`. `docs/architecture.md`'s "Document reader" design note
 * has the full reasoning; in short, a real AST gets table cells, links and directive-plus-title
 * lines right by construction, which is exactly what issue #11 measured the regex scanner getting
 * wrong.
 *
 * Positions are never computed by this reader — every `TextUnit.range` is read directly off a
 * parsed node's own `range`, or derived from its children's ranges (see {@link contentRange}). The
 * offset contract holds by construction: nothing here re-slices, re-indexes or otherwise
 * reconstructs a position, so every range is already a valid offset into the source the parser saw.
 *
 * Synchronous, not behind an async `DocumentReader` interface: `src/analysis/analyse.ts` is the one
 * production caller, `analyseTextDeterministic` documents itself as performing no I/O (a contract
 * existing callers rely on), and nothing here actually needs an event-loop turn — `parse()` and the
 * tree walk are both synchronous underneath. An earlier async `DocumentReader.read()` wrapper around
 * this function was removed (ponytail-audit yagni finding) once it turned out to have no caller of
 * its own; see `docs/architecture.md`, "Document reader", for the full history. Reintroduce an async
 * seam if and when a reader that genuinely needs real I/O (docx, a remotely-fetched document) lands.
 */
export function readMarkdownUnitsSync(doc: SourceDocument): TextUnit[] {
  const ast = parse(doc.text);
  const counter = new Counter();
  const ctx: WalkContext = {
    sourceText: doc.text,
    depth: 0,
    listDepth: 0,
    containerKind: undefined,
    listOrdinal: undefined,
    // A one-shot admonition register, shared by reference across the whole walk — not a per-call
    // local. `structure.ts`'s own `pendingAdmonition` is a single variable for the entire scan,
    // consumed by whichever block is pushed next regardless of nesting; a `let` re-declared at the
    // top of each recursive `walkChildren` call cannot reproduce that; a box threaded unchanged
    // through every recursive call can.
    pending: { value: 'none' },
    // A container-scoped admonition register, distinct from `pending` above: `structure.ts`'s own
    // `containerAdmonition` applies to every block belonging to the container an opener introduced,
    // not just the next one — the register lapses only when the container itself ends, not on first
    // use. A GFM alert (`> [!WARNING]`) is the shape that needs it: its marker and every following
    // quoted paragraph are siblings inside the same `BlockQuote`, so this box gets replaced with a
    // fresh one exactly when `walkChildren` recurses into a `BlockQuote`'s own children — reset at
    // the container's boundary, exactly like `structure.ts`'s indent-based reset, but expressed as
    // object identity instead of an indent comparison.
    containerAdmonition: { value: 'none' },
    counter,
  };
  return [...walkChildren(ast.children, ctx)];
}

/**
 * Distinct, stable-within-one-read ids. A plain incrementing counter is enough: `read()` is not
 * asked to survive across edits to the source, only to name which unit failed within one run.
 */
class Counter {
  #value = 0;
  next(): number {
    this.#value += 1;
    return this.#value;
  }
}

interface WalkContext {
  readonly sourceText: string;
  /** Blockquote nesting: `>` marker count, 1-based, matching `structure.ts`'s own convention. */
  readonly depth: number;
  /** List nesting: 0 for a top-level list, incremented only for a list genuinely nested inside
   * another list's item — matching `structure.ts`'s `Math.floor(markerIndent / 2)`, which is 0 for
   * an unindented top-level list. Kept separate from `depth` because the two conventions disagree
   * (blockquote depth is 1-based; list depth is 0-based) and a block is only ever one kind at a time. */
  readonly listDepth: number;
  /**
   * Set while walking the children of a `ListItem` or `BlockQuote`, so a `Paragraph` found there is
   * reported as the container it actually is, not as a bare top-level paragraph.
   */
  readonly containerKind: 'list-item' | 'blockquote' | undefined;
  /** The written ordinal of the enclosing list item, when it is one item of an ordered list. */
  readonly listOrdinal: number | undefined;
  readonly pending: { value: AdmonitionKind };
  /** See the doc comment where this is first constructed, in `readMarkdownUnitsSync`. */
  readonly containerAdmonition: { value: AdmonitionKind };
  readonly counter: Counter;
}

/**
 * Walk one level of siblings, in source order, propagating an admonition register the way
 * `src/core/structure.ts`'s block scanner does — except `structure.ts` actually keeps *two*
 * distinct registers, and this walk has to as well:
 *
 * - `ctx.pending`: a **one-shot** label (AsciiDoc's `[WARNING]`, alone on its own line at the same
 *   indent as what follows). It applies to whichever unit is produced *next in traversal order* —
 *   once, then it lapses, even if that next unit is found after descending into a list or a
 *   blockquote.
 * - `ctx.containerAdmonition`: a **container-scoped** register (a GFM alert's `> [!WARNING]`, an
 *   MkDocs `!!! warning`, an RST `.. warning::`) that scopes every child of the container the
 *   opener introduces — every quoted paragraph in a GFM alert's `BlockQuote`, not just the first —
 *   and lapses only when the container itself ends, matched here by giving `BlockQuote` a fresh
 *   box when `walkChildren` recurses into it (see the `BlockQuote` case below), rather than by
 *   consuming it on first use the way `pending` does.
 *
 * A combined marker-and-body paragraph (a GFM alert's `> [!WARNING]` and its quoted line parse as
 * one `Paragraph` node) is not a bare opener by this test — `isBareAdmonitionOpener` requires the
 * whole line to be nothing else — so it falls through to the ordinary branch and reports its own
 * admonition directly, with nothing left to propagate.
 */
// Every `child as TxtXNode` cast below is verified by the immediately preceding `case 'X':` on
// `child.type`, but TypeScript cannot narrow on it: `@textlint/ast-node-types` exports
// `AnyTxtNode` as `TxtNode | TxtTextNode | TxtParentNode` (see `NodeType.d.ts`), a structural
// three-way split, not a union discriminated per node tag, so `switch (child.type)` narrows only
// within those three shapes, never down to the exact node interface a specific `case` implies.
// The runtime tag is authoritative; the cast just restates what the `case` already guarantees.
function* walkChildren(children: readonly AnyTxtNode[], ctx: WalkContext): Generator<TextUnit> {
  for (const child of children) {
    switch (child.type) {
      case 'Header': {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment above walkChildren
        const header = child as TxtHeaderNode;
        const pending = ctx.pending.value;
        ctx.pending.value = 'none';
        const own = detectAdmonition(header.raw);
        yield buildUnit(
          ctx,
          'heading',
          contentRange(header),
          header.depth,
          own !== 'none' ? own : pending !== 'none' ? pending : ctx.containerAdmonition.value,
          // scanBlocks forces every heading to `descriptive` unconditionally
          // (`kind === 'heading' ? 'descriptive' : detectMode(...)`) — `detectMode` never runs on a
          // heading's own text at all, so an imperative-sounding title is not misread as an
          // instruction the way a paragraph's would be.
          'descriptive',
        );
        break;
      }

      case 'Paragraph': {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment above walkChildren
        const paragraph = child as TxtParagraphNode;
        const pending = ctx.pending.value;
        ctx.pending.value = 'none';
        const raw = paragraph.raw;
        const own = detectAdmonition(raw);
        // `isBareAdmonitionOpener`'s GFM alternative is written against a raw source *line*, which
        // always carries its blockquote's leading `>` — but an HTML comment on its own line (the
        // shape a suppression directive takes) makes the parser split the blockquote into separate
        // `Paragraph` nodes around it, and each node's own `.raw` no longer includes the `>` the AST
        // has already attributed to the container. Reconstructed here, for this one check only —
        // `detectAdmonition` already tolerates the marker with or without `>`, so `own` above needed
        // no such reconstruction.
        const openerCandidate = ctx.containerKind === 'blockquote' ? `> ${raw}` : raw;
        // An opener carries no prose: it names a register for what follows and produces no unit,
        // matching `scanBlocks`'s "a block made only of markup carries no prose" rule.
        //
        // AsciiDoc's `[WARNING]` label is one-shot (`ctx.pending`) regardless of where it is found.
        // A bare *container* opener (GFM alert, MkDocs, RST/MyST) found as a direct child of the
        // blockquote it is itself opening is different: it must scope every sibling paragraph in
        // that same `BlockQuote`, not just the next one, so it goes into `ctx.containerAdmonition`
        // instead — a register this call's own `BlockQuote` recursion resets on entry, never
        // consumed on first use the way `ctx.pending` is. Found anywhere else (top-level MkDocs/RST,
        // which the parser represents as plain siblings with no enclosing container node to bound
        // the scope), it stays one-shot via `ctx.pending`, same as before — the immediately
        // following unit (typically the indented body `CodeBlock`, see that case below) is what
        // actually needs it.
        if (own !== 'none' && isAdmonitionLabelLine(raw)) {
          ctx.pending.value = own;
          continue;
        }
        if (own !== 'none' && isBareAdmonitionOpener(openerCandidate)) {
          if (ctx.containerKind === 'blockquote') {
            ctx.containerAdmonition.value = own;
          } else {
            ctx.pending.value = own;
          }
          continue;
        }
        // Without a blank line, commonmark merges a bare opener with the prose that follows it into
        // ONE `Paragraph` node — `scanBlocks`, a line-by-line scanner, never merges an opener line
        // with what follows it, blank line or not, so this shape has no counterpart there to match
        // by omission. `isBareAdmonitionOpener`/`isAdmonitionLabelLine` test one line in isolation;
        // run against the whole merged blob above, the opener is followed by real content and no
        // longer reads as "only" a marker, so the register was silently lost. Not attempted inside a
        // blockquote: a GFM alert's marker-and-body merging into one unit, with the marker's own
        // admonition applied directly to it (the branch just above, when it does *not* split), is a
        // deliberate, different convention for that one form, not an oversight to unify with this.
        if (ctx.containerKind !== 'blockquote') {
          const split = splitLeadingOpener(raw);
          if (split !== undefined) {
            const contentRangeValue = contentRange(paragraph);
            const bodyRange: SourceRange = {
              start: contentRangeValue.start + split.bodyOffset,
              end: contentRangeValue.end,
            };
            const kind = ctx.containerKind ?? 'paragraph';
            const depth = ctx.containerKind === 'list-item' ? ctx.listDepth : 0;
            yield buildUnit(
              ctx,
              kind,
              bodyRange,
              depth,
              split.admonition,
              undefined,
              ctx.containerKind === 'list-item' ? ctx.listOrdinal : undefined,
            );
            break;
          }
        }
        const kind = ctx.containerKind ?? 'paragraph';
        const depth =
          ctx.containerKind === 'list-item'
            ? ctx.listDepth
            : ctx.containerKind === 'blockquote'
              ? ctx.depth
              : 0;
        yield buildUnit(
          ctx,
          kind,
          contentRange(paragraph),
          depth,
          own !== 'none' ? own : pending !== 'none' ? pending : ctx.containerAdmonition.value,
          undefined,
          ctx.containerKind === 'list-item' ? ctx.listOrdinal : undefined,
        );
        break;
      }

      case 'BlockQuote': {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment above walkChildren
        const blockQuote = child as TxtBlockQuoteNode;
        yield* walkChildren(blockQuote.children, {
          ...ctx,
          depth: ctx.depth + 1,
          containerKind: 'blockquote',
          listOrdinal: undefined,
          // A fresh box, not the enclosing scope's: this `BlockQuote`'s own container-scoped
          // admonition (if one of its direct-child paragraphs opens one) must not leak out to a
          // sibling of the blockquote once this recursive call returns, and a blockquote nested
          // inside another admonition-bearing blockquote must not inherit the outer one's register
          // as though it were its own container.
          containerAdmonition: { value: 'none' },
        });
        break;
      }

      case 'List': {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment above walkChildren
        const list = child as TxtListNode;
        // Only a list nested inside another list's item is genuinely one level deeper; a list found
        // directly under the document (or a blockquote) is the outermost list and stays at 0.
        const nextListDepth = ctx.containerKind === 'list-item' ? ctx.listDepth + 1 : ctx.listDepth;
        const ordered = list.ordered === true;
        const start = list.start ?? 1;
        let index = 0;
        for (const listItem of list.children) {
          yield* walkChildren(listItem.children, {
            ...ctx,
            listDepth: nextListDepth,
            containerKind: 'list-item',
            listOrdinal: ordered ? start + index : undefined,
          });
          index += 1;
        }
        break;
      }

      case 'ListItem': {
        // Reached only if a `ListItem` is ever encountered somewhere other than as a direct child of
        // a `List` (the `List` case above handles the normal path itself, so it can assign each
        // item's own ordinal) — defensive, not the primary path.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment above walkChildren
        const listItem = child as TxtListItemNode;
        yield* walkChildren(listItem.children, { ...ctx, containerKind: 'list-item' });
        break;
      }

      case 'Table': {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment above walkChildren
        const table = child as TxtTableNode;
        yield* walkChildren(table.children, ctx);
        break;
      }

      case 'TableRow': {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment above walkChildren
        const row = child as TxtTableRowNode;
        yield* walkChildren(row.children, ctx);
        break;
      }

      case 'TableCell': {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment above walkChildren
        const cell = child as TxtTableCellNode;
        const pending = ctx.pending.value;
        ctx.pending.value = 'none';
        const own = detectAdmonition(cell.raw);
        yield buildUnit(
          ctx,
          'table-cell',
          contentRange(cell),
          0,
          own !== 'none' ? own : pending !== 'none' ? pending : ctx.containerAdmonition.value,
        );
        break;
      }

      case 'CodeBlock': {
        // Standard MkDocs/Material syntax (`!!! warning`, blank line, four-space-indented body) is
        // indistinguishable from an ordinary indented code block to a CommonMark parser — both
        // parse as a `CodeBlock` node. Dropping it unconditionally (the historical default-branch
        // behaviour, still correct for genuine code) silently ate every MkDocs admonition body: no
        // unit, no diagnostics, and the still-pending register left free to attach to whatever
        // unrelated prose happened to follow instead.
        //
        // Recognised as prose, not code, only when BOTH hold: (1) an admonition register — either
        // register, one-shot or container-scoped — is still active from the immediately preceding
        // sibling, meaning this block is standing exactly where a supported opener's body belongs;
        // (2) the block is the *indented* form, not a fenced one (``` or ~~~) — a fenced block is a
        // deliberate code sample the author chose to fence, even inside an admonition, and must stay
        // code regardless of what precedes it. An indented code block with neither condition met
        // (the ordinary case: no admonition opener before it at all) is left alone, exactly as
        // before.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment above walkChildren
        const codeBlock = child as TxtCodeBlockNode;
        const pending = ctx.pending.value;
        const active = pending !== 'none' ? pending : ctx.containerAdmonition.value;
        const isFenced = /^[ \t]*(`{3,}|~{3,})/.test(codeBlock.raw);
        if (active === 'none' || isFenced) break;
        ctx.pending.value = 'none';
        const leadingIndent = /^[ \t]+/.exec(codeBlock.raw)?.[0] ?? '';
        const range: SourceRange = {
          start: codeBlock.range[0] + leadingIndent.length,
          end: codeBlock.range[1],
        };
        const depth =
          ctx.containerKind === 'list-item'
            ? ctx.listDepth
            : ctx.containerKind === 'blockquote'
              ? ctx.depth
              : 0;
        // `'paragraph'` — the body reads as ordinary prose once recognised, and every consumer of
        // `TextUnit.kind` (`analyse.ts`'s `UNIT_KIND_TO_BLOCK_KIND`) already has a mapping for it;
        // no new kind vocabulary is needed for what is, structurally, just an indented paragraph.
        yield buildUnit(ctx, 'paragraph', range, depth, active);
        break;
      }

      default:
        // Raw HTML, front matter, reference definitions, thematic breaks, a fenced or unrelated
        // indented code block, and any node this reader does not yet recognise: no prose, no unit,
        // nothing to recurse into.
        break;
    }
  }
}

/**
 * Whether the first line of `raw` is, on its own, a bare admonition opener — `undefined` when it is
 * not, or when `raw` is only one line to begin with (already handled by the whole-string check that
 * runs before this one; nothing left to split).
 *
 * Tests exactly the first line in isolation, the way `scanBlocks` (a line-by-line scanner) always
 * does, rather than the whole merged blob a `Paragraph` node can carry when no blank line separates
 * an opener from what follows it.
 */
function splitLeadingOpener(
  raw: string,
): { readonly admonition: AdmonitionKind; readonly bodyOffset: number } | undefined {
  const newline = raw.indexOf('\n');
  if (newline < 0) return undefined;
  const firstLine = raw.slice(0, newline);
  const admonition = detectAdmonition(firstLine);
  if (admonition === 'none') return undefined;
  if (!isBareAdmonitionOpener(firstLine) && !isAdmonitionLabelLine(firstLine)) return undefined;
  return { admonition, bodyOffset: newline + 1 };
}

/**
 * The span of a node's actual content, excluding its own markup.
 *
 * A parent node's own `range` sometimes includes markup the reader must not report as content — a
 * `Header`'s range covers its `#` marker, a `TableCell`'s covers its leading space and `|` — while a
 * `Paragraph`'s own range already equals the union of its children in every case observed against
 * this parser. Deriving from children uniformly is correct for both: for a `Paragraph` it reproduces
 * the node's own range exactly; for `Header` and `TableCell` it excludes the markup the node's own
 * range would otherwise have included.
 */
function contentRange(node: {
  readonly range: readonly [number, number];
  readonly children: readonly { readonly range: readonly [number, number] }[];
}): SourceRange {
  const first = node.children[0];
  const last = node.children[node.children.length - 1];
  if (first === undefined || last === undefined) {
    return { start: node.range[0], end: node.range[1] };
  }
  return { start: first.range[0], end: last.range[1] };
}

function buildUnit(
  ctx: WalkContext,
  kind: string,
  range: SourceRange,
  depth: number,
  admonition: AdmonitionKind,
  modeOverride?: TextMode,
  listOrdinal?: number,
): TextUnit {
  const text = ctx.sourceText.slice(range.start, range.end);
  const id = ctx.counter.next();
  // Masking, never stripping, is what keeps `masked` the same length as `text`: a continuation
  // line's own `>` is embedded mid-string (see `maskBlockquoteContinuationMarkers`), and deleting it
  // would shift every offset after it out of correspondence with `range`.
  const masked = kind === 'blockquote' ? maskBlockquoteContinuationMarkers(text) : text;
  return {
    id: `${kind}:${id}:${range.start}`,
    kind,
    range,
    text,
    masked,
    mode: modeOverride ?? detectMode(text, defaultStructureOptions),
    admonition,
    depth,
    ...(listOrdinal === undefined ? {} : { listOrdinal }),
  };
}

/**
 * Replace an embedded continuation line's own `>` (and any nesting `>`s, and their leading indent)
 * with an equal-length run of U+FFFD.
 *
 * Only a blockquote *paragraph*'s first line ever has its marker excluded by the parser
 * (`contentRange` derives the unit's start from its first child, past the opening `>`); every line
 * after the first keeps its own `>` sitting mid-string, verbatim, in `text`. Left alone, a checker
 * reading `masked` would see that `>` as though the author had written it as prose — a
 * sentence-initial word with no capital, immediately after a full stop. The space that follows the
 * marker is left alone: it is ordinary word-separating whitespace, not markup.
 */
function maskBlockquoteContinuationMarkers(text: string): string {
  return text.replace(
    /\n([ \t]{0,3}>+)/g,
    (_match, marker: string) => `\n${'�'.repeat(marker.length)}`,
  );
}
