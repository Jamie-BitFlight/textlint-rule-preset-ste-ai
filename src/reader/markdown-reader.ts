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
  stripTrailingCR,
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
export function readMarkdownUnitsSync(doc: SourceDocument, classifyMode = true): TextUnit[] {
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
    classifyMode,
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
  readonly classifyMode: boolean;
}

/**
 * The node types `walkChildren` actually handles below, as a real discriminated union.
 *
 * `@textlint/ast-node-types` exports `AnyTxtNode` as `TxtNode | TxtTextNode | TxtParentNode` (see
 * `NodeType.d.ts`) — a structural three-way split, not a union discriminated per node tag — so
 * `switch (child.type)` on an `AnyTxtNode` narrows `child.type` to the matching literal but cannot
 * narrow `child` itself down to the exact node interface a specific `case` implies. Every concrete
 * interface below (`TxtHeaderNode`, `TxtParagraphNode`, …) does declare its own literal `type`
 * field, though, so a union of exactly those interfaces *is* a genuine discriminated union — the
 * three-way split only applies to `AnyTxtNode`'s own declared shape, not to what the node actually
 * is once its concrete type is known.
 */
type ConcreteChildNode =
  | TxtHeaderNode
  | TxtParagraphNode
  | TxtBlockQuoteNode
  | TxtListNode
  | TxtListItemNode
  | TxtTableNode
  | TxtTableRowNode
  | TxtTableCellNode
  | TxtCodeBlockNode;

/**
 * Narrows `node` to {@link ConcreteChildNode} by checking its real `.type` tag against every
 * literal the union above declares — one `case` per member, so an interface added to (or removed
 * from) the union without a matching `case` here is a type error, not a silent gap.
 */
function isConcreteChildNode(node: AnyTxtNode): node is ConcreteChildNode {
  switch (node.type) {
    case 'Header':
    case 'Paragraph':
    case 'BlockQuote':
    case 'List':
    case 'ListItem':
    case 'Table':
    case 'TableRow':
    case 'TableCell':
    case 'CodeBlock':
      return true;
    default:
      return false;
  }
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
function* walkChildren(children: readonly AnyTxtNode[], ctx: WalkContext): Generator<TextUnit> {
  for (const child of children) {
    // Every node `walkChildren` produces a unit or recurses for is a `ConcreteChildNode`; anything
    // else (raw HTML, front matter, reference definitions, thematic breaks, inline text nodes, …)
    // falls through here exactly as it fell through the `switch`'s own `default:` case before this
    // guard existed — no prose, no unit, nothing to recurse into.
    if (!isConcreteChildNode(child)) continue;
    switch (child.type) {
      case 'Header': {
        const header = child;
        const pending = ctx.pending.value;
        ctx.pending.value = 'none';
        // header.raw is sliced straight from the untouched source (see stripTrailingCR's doc
        // comment in structure.ts), so it still carries a trailing \r under CRLF -- stripped here,
        // never from anything an offset is later computed from.
        const own = detectAdmonition(stripTrailingCR(header.raw));
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
        const paragraph = child;
        const pending = ctx.pending.value;
        ctx.pending.value = 'none';
        const raw = paragraph.raw;
        // `raw` is sliced straight from the untouched source, so it still carries a trailing \r
        // under CRLF (see stripTrailingCR's doc comment in structure.ts). Stripped only for the
        // classification checks below -- `raw` itself stays untouched for `splitLeadingOpener`,
        // which computes an offset from it.
        const detectionRaw = stripTrailingCR(raw);
        const own = detectAdmonition(detectionRaw);
        // `isBareAdmonitionOpener`'s GFM alternative is written against a raw source *line*, which
        // always carries its blockquote's leading `>` — but an HTML comment on its own line (the
        // shape a suppression directive takes) makes the parser split the blockquote into separate
        // `Paragraph` nodes around it, and each node's own `.raw` no longer includes the `>` the AST
        // has already attributed to the container. Reconstructed here, for this one check only —
        // `detectAdmonition` already tolerates the marker with or without `>`, so `own` above needed
        // no such reconstruction.
        const openerCandidate =
          ctx.containerKind === 'blockquote' ? `> ${detectionRaw}` : detectionRaw;
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
        if (own !== 'none' && isAdmonitionLabelLine(detectionRaw)) {
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
        const blockQuote = child;
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
        const list = child;
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
        const listItem = child;
        yield* walkChildren(listItem.children, { ...ctx, containerKind: 'list-item' });
        break;
      }

      case 'Table': {
        const table = child;
        yield* walkChildren(table.children, ctx);
        break;
      }

      case 'TableRow': {
        const row = child;
        yield* walkChildren(row.children, ctx);
        break;
      }

      case 'TableCell': {
        const cell = child;
        const pending = ctx.pending.value;
        ctx.pending.value = 'none';
        // cell.raw carries the same trailing-\r-under-CRLF hazard as header.raw above.
        const own = detectAdmonition(stripTrailingCR(cell.raw));
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
        const codeBlock = child;
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
  // `newline` is an offset into the untouched `raw` and feeds `bodyOffset` below, so it is never
  // computed from a CR-stripped string. `firstLine` itself carries a trailing \r under CRLF (the
  // slice ends right before the \n, and CRLF's \r sits immediately before it) -- stripped only for
  // the classification checks that follow, same as every other admonition-detecting call site in
  // this file.
  const firstLine = stripTrailingCR(raw.slice(0, newline));
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
    mode:
      modeOverride ??
      (ctx.classifyMode ? detectMode(text, defaultStructureOptions) : 'descriptive'),
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
