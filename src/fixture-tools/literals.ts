import { analyseDocument } from '../core/document.js';
import type { ProtectedRegionKind } from '../core/types.js';

/**
 * Literals that a rewritten counterpart must reproduce byte-identically.
 *
 * This is the machine-checkable half of "the rewrite preserves technical meaning". It cannot prove
 * that meaning survived — only a reviewer and the equivalence evaluator address that — but it does
 * prove that no command, identifier, path, quantity, version, placeholder or quoted literal was
 * altered while the prose around it was simplified.
 *
 * Structural markup is excluded: a rewrite is allowed to change list markers and emphasis.
 */
const CHECKED_KINDS: ReadonlySet<ProtectedRegionKind> = new Set([
  'fenced-code',
  'indented-code',
  'inline-code',
  'url',
  'autolink',
  'email',
  'file-path',
  'shell-command',
  'config-fragment',
  'placeholder',
  'numeric-expression',
  'identifier',
  'api-name',
  'field-name',
  'constant',
  'product-identifier',
  'quoted-literal',
  'math',
  'link-destination',
]);

/** Shorter literals produce noisy false requirements, and are covered by the longer spans. */
const MIN_LENGTH = 2;

export function extractProtectedLiterals(text: string): string[] {
  const doc = analyseDocument({ id: 'literal-scan', format: 'markdown', text });
  const out = new Set<string>();
  for (const region of doc.protectedRegions) {
    if (!region.opaque || !CHECKED_KINDS.has(region.kind)) continue;
    const literal = text.slice(region.range.start, region.range.end).trim();
    if (literal.length < MIN_LENGTH) continue;
    out.add(literal);
  }
  return [...out];
}

/** Literals present in `original` but absent from `rewritten`. */
export function missingLiterals(original: string, rewritten: string): string[] {
  return extractProtectedLiterals(original).filter((literal) => !rewritten.includes(literal));
}
