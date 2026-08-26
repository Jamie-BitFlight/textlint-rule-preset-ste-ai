import { describe, expect, it } from 'vite-plus/test';
import {
  findImprovements,
  findingKey,
  findRegressions,
  localContext,
  nearestHeading,
} from '../../scripts/ci/check-dogfood-lint.mjs';

/**
 * Pins the finding-identity guarantees `scripts/ci/check-dogfood-lint.mjs` documents in its own
 * module comment and in `findingKey`'s comment, rather than leaving them provable only by manually
 * re-running the script against a scratch fixture on review. Two rounds of review asked for exactly
 * this: "pin this mutation case" (paragraph clamp) and "add an executable mutation test for this
 * documented guarantee" (heading anchor).
 *
 * Each guarantee is pinned by mutating the exact scenario that was reproduced against a real build
 * of the script to find the underlying defect, so reverting the fix these tests guard makes the
 * corresponding test fail -- not merely assert something that happens to already be true.
 */

describe('paragraphBounds / localContext', () => {
  it('excludes a preceding heading from a finding under it', () => {
    const source = '# Torque Procedure\n\nRemove the bracket; verify it afterward.\n';
    const index = source.indexOf('Remove');
    const context = localContext(source, index);
    expect(context).not.toContain('Torque Procedure');
    expect(context).toContain('Remove the bracket');
  });

  it('does not let an edit to a neighbouring paragraph change an untouched finding’s context', () => {
    const before =
      '# Torque Procedure\n\n' +
      'An unrelated filler sentence sits here.\n\n' +
      'Remove the bracket; verify it afterward.\n';
    const after =
      '# Torque Procedure\n\n' +
      'A completely reworded filler sentence sits here instead.\n\n' +
      'Remove the bracket; verify it afterward.\n';
    const beforeIndex = before.indexOf('Remove');
    const afterIndex = after.indexOf('Remove');
    expect(localContext(after, afterIndex)).toBe(localContext(before, beforeIndex));
  });

  it('does let an edit inside the same paragraph change the context, since it travels with the finding', () => {
    const before = '# Heading\n\nRemove the bracket; verify it afterward.\n';
    const after = '# Heading\n\nPlease remove the bracket; verify it afterward.\n';
    const beforeIndex = before.indexOf('Remove');
    const afterIndex = after.indexOf('remove');
    expect(localContext(after, afterIndex)).not.toBe(localContext(before, beforeIndex));
  });
});

describe('nearestHeading', () => {
  it('returns the nearest ATX heading at or before the index', () => {
    const source = '# One\n\ntext one\n\n## Two\n\ntext two\n';
    expect(nearestHeading(source, source.indexOf('text one'))).toBe('# One');
    expect(nearestHeading(source, source.indexOf('text two'))).toBe('## Two');
  });

  it('returns the empty string before the first heading', () => {
    const source = 'preamble text\n\n# One\n\ntext one\n';
    expect(nearestHeading(source, source.indexOf('preamble'))).toBe('');
  });
});

/** Builds the same per-finding key `lint()` builds, for a hand-built list of (index) occurrences. */
function keysFor(
  source: string,
  ruleId: string,
  message: string,
  indices: readonly number[],
): string[] {
  const groupOrdinal = new Map<string, number>();
  const keys: string[] = [];
  for (const index of indices) {
    const context = localContext(source, index);
    const heading = nearestHeading(source, index);
    const groupKey = [ruleId, message, context, heading].join('\n');
    const ordinal = (groupOrdinal.get(groupKey) ?? 0) + 1;
    groupOrdinal.set(groupKey, ordinal);
    keys.push(findingKey(ruleId, message, context, heading, ordinal));
  }
  return keys;
}

describe('cross-heading swap detection (the defect review found in the ordinal-only scheme)', () => {
  const ruleId = 'ste-ai/punctuation-constraints';
  const message = 'A semicolon joins two statements.';
  const violation = 'Remove the bracket; verify it afterward.';

  it('gives two identical occurrences under different headings distinct keys', () => {
    const source =
      `## heading-a\n\n${violation}\n\n` +
      `## heading-b\n\n${violation}\n\n` +
      `## heading-c\n\nclean.\n`;
    const indices = [source.indexOf(violation), source.lastIndexOf(violation)];
    const [keyA, keyB] = keysFor(source, ruleId, message, indices);
    expect(keyA).not.toBe(keyB);
  });

  it('catches removing the occurrence under one heading while an identical one appears under another', () => {
    const before =
      `## heading-a\n\n${violation}\n\n` +
      `## heading-b\n\n${violation}\n\n` +
      `## heading-c\n\nclean.\n`;
    const beforeIndices = [before.indexOf(violation), before.lastIndexOf(violation)];
    const beforeKeys = keysFor(before, ruleId, message, beforeIndices);
    const baseline = {
      'swap.md': {
        total: beforeKeys.length,
        findings: Object.fromEntries(beforeKeys.map((key) => [key, 1])),
      },
    };

    // heading-a's occurrence is gone; heading-c now has an identical one instead.
    const after =
      `## heading-a\n\nclean now.\n\n` +
      `## heading-b\n\n${violation}\n\n` +
      `## heading-c\n\n${violation}\n`;
    const afterIndices = [after.indexOf(violation), after.lastIndexOf(violation)];
    const afterKeys = keysFor(after, ruleId, message, afterIndices);
    const byFile = new Map([['swap.md', new Map(afterKeys.map((key) => [key, 1]))]]);

    // This is the exact defect review found: an ordinal-only identity regenerates 1..N for
    // whatever set remains, so neither side notices anything moved. With `nearestHeading` folded
    // into the key, the swap must show up as both a regression (the new heading-c occurrence) and
    // an improvement (heading-a's occurrence is gone).
    expect(findRegressions(byFile, baseline)).not.toEqual([]);
    expect(findImprovements(byFile, baseline)).not.toEqual([]);
  });
});
