import { parse } from '@textlint/markdown-to-ast';
import type {
  AnyTxtNode,
  TxtBlockQuoteNode,
  TxtHeaderNode,
  TxtListItemNode,
  TxtListNode,
  TxtParagraphNode,
  TxtTableCellNode,
  TxtTableNode,
  TxtTableRowNode,
} from '@textlint/ast-node-types';
import {
  defaultStructureOptions,
  detectAdmonition,
  detectMode,
  isAdmonitionLabelLine,
  isBareAdmonitionOpener,
} from '../core/structure.js';
import type { AdmonitionKind, SourceDocument, SourceRange } from '../core/types.js';
import type { DocumentReader, TextUnit } from './types.js';

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
 */
export class MarkdownReader implements DocumentReader {
  readonly mediaType = 'markdown' as const;

  async *read(doc: SourceDocument): AsyncIterable<TextUnit> {
    const ast = parse(doc.text);
    const counter = new Counter();
    const ctx: WalkContext = { sourceText: doc.text, depth: 0, containerKind: undefined, counter };
    for (const unit of walkChildren(ast.children, ctx)) {
      yield unit;
    }
  }
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
  readonly depth: number;
  /**
   * Set while walking the children of a `ListItem` or `BlockQuote`, so a `Paragraph` found there is
   * reported as the container it actually is, not as a bare top-level paragraph.
   */
  readonly containerKind: 'list-item' | 'blockquote' | undefined;
  readonly counter: Counter;
}

/**
 * Walk one level of siblings, in source order, propagating an admonition register the way
 * `src/core/structure.ts`'s block scanner does: a paragraph that is *only* an admonition opener
 * (`!!! warning`, `.. warning::`, `[WARNING]`) carries no prose of its own, is not turned into a
 * unit, and its register applies to the sibling that follows — once, then it lapses. A combined
 * marker-and-body paragraph (a GFM alert's `> [!WARNING]` and its quoted line parse as one
 * `Paragraph` node) is not a bare opener by this test — `isBareAdmonitionOpener` requires the whole
 * line to be nothing else — so it falls through to the ordinary branch and reports its own
 * admonition directly, with nothing left to propagate.
 */
function* walkChildren(children: readonly AnyTxtNode[], ctx: WalkContext): Generator<TextUnit> {
  let pendingAdmonition: AdmonitionKind = 'none';

  for (const child of children) {
    switch (child.type) {
      case 'Header': {
        // The library's own types do not discriminate `AnyTxtNode` per tag the way a proper
        // discriminated union would — `child.type` is checked at runtime, and this cast narrows to
        // match it. Scoped to one case at a time, not a blanket escape from the type system.
        const header = child as TxtHeaderNode;
        pendingAdmonition = 'none';
        yield buildUnit(ctx, 'heading', contentRange(header), header.depth, 'none');
        break;
      }

      case 'Paragraph': {
        const paragraph = child as TxtParagraphNode;
        const pending = pendingAdmonition;
        pendingAdmonition = 'none';
        const raw = paragraph.raw;
        const own = detectAdmonition(raw);
        // An opener carries no prose: it names a register for what follows and produces no unit,
        // matching `scanBlocks`'s "a block made only of markup carries no prose" rule.
        if (own !== 'none' && (isBareAdmonitionOpener(raw) || isAdmonitionLabelLine(raw))) {
          pendingAdmonition = own;
          continue;
        }
        const kind = ctx.containerKind ?? 'paragraph';
        yield buildUnit(
          ctx,
          kind,
          contentRange(paragraph),
          ctx.depth,
          own !== 'none' ? own : pending,
        );
        break;
      }

      case 'BlockQuote': {
        const blockQuote = child as TxtBlockQuoteNode;
        yield* walkChildren(blockQuote.children, {
          ...ctx,
          depth: ctx.depth + 1,
          containerKind: 'blockquote',
        });
        break;
      }

      case 'List': {
        const list = child as TxtListNode;
        yield* walkChildren(list.children, {
          ...ctx,
          depth: ctx.depth + 1,
          containerKind: undefined,
        });
        break;
      }

      case 'ListItem': {
        const listItem = child as TxtListItemNode;
        yield* walkChildren(listItem.children, {
          ...ctx,
          containerKind: 'list-item',
        });
        break;
      }

      case 'Table': {
        const table = child as TxtTableNode;
        yield* walkChildren(table.children, ctx);
        break;
      }

      case 'TableRow': {
        const row = child as TxtTableRowNode;
        yield* walkChildren(row.children, ctx);
        break;
      }

      case 'TableCell': {
        const cell = child as TxtTableCellNode;
        yield buildUnit(ctx, 'table-cell', contentRange(cell), ctx.depth, 'none');
        break;
      }

      default:
        // Code blocks, raw HTML, front matter, reference definitions, thematic breaks, and any
        // node this reader does not yet recognise: no prose, no unit, nothing to recurse into.
        break;
    }
  }
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
): TextUnit {
  const text = ctx.sourceText.slice(range.start, range.end);
  const id = ctx.counter.next();
  return {
    id: `${kind}:${id}:${range.start}`,
    kind,
    range,
    text,
    mode: detectMode(text, defaultStructureOptions),
    admonition,
    depth,
  };
}
