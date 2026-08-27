import { describe, expect, it } from 'vite-plus/test';
import {
  findImprovements,
  findingKey,
  findRegressions,
  localContext,
  nearestHeading,
  paragraphBounds,
  regressionsToGuard,
  sentenceBounds,
  toForwardSlashes,
} from '../../scripts/ci/check-dogfood-lint.mjs';

/**
 * Pins the finding-identity guarantees `scripts/ci/check-dogfood-lint.mjs` documents in its own
 * module comment and in `findingKey`'s comment, rather than leaving them provable only by manually
 * re-running the script against a scratch fixture on review. Review has repeatedly asked for exactly
 * this: "pin this mutation case" (paragraph clamp) and "add an executable mutation test for this
 * documented guarantee" (heading anchor).
 *
 * Each guarantee is pinned by mutating the exact scenario that was reproduced against a real build
 * of the script to find the underlying defect, so reverting the fix these tests guard makes the
 * corresponding test fail -- not merely assert something that happens to already be true.
 */

describe('toForwardSlashes', () => {
  it('converts a Windows-style relative path to forward slashes', () => {
    // `path.relative()` returns backslash-separated paths on Windows, but `discoverMarkdownFiles()`
    // (via `git ls-files`) and the committed baseline both always use forward slashes -- a baseline
    // key built from the raw `relative()` result would never match either on Windows, so every
    // nested dirty file would look new and every existing nested baseline entry would look stale.
    expect(toForwardSlashes('docs\\architecture.md')).toBe('docs/architecture.md');
  });

  it('leaves an already-forward-slash path unchanged', () => {
    expect(toForwardSlashes('docs/architecture.md')).toBe('docs/architecture.md');
  });
});

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

  it('does not let an edit to an earlier, different sentence in the same paragraph change an untouched finding’s context', () => {
    // Review found the paragraph clamp alone insufficient: an earlier sentence in the same
    // paragraph can still sit within CONTEXT_RADIUS of an untouched violation later in it, so
    // fixing that earlier sentence changed the violation's key anyway -- reported as both a
    // regression (new key, count 0 -> 1) and an improvement (old key, count 1 -> 0) for a cleanup
    // that never touched the violation at all.
    const violation = 'Remove the bracket; verify it afterward.';
    const before = `## heading\n\nFix the seal now. ${violation} Then close the panel.\n`;
    const after = `## heading\n\nRepair the seal soon instead. ${violation} Then close the panel.\n`;
    const beforeIndex = before.indexOf(violation);
    const afterIndex = after.indexOf(violation);
    expect(localContext(after, afterIndex)).toBe(localContext(before, beforeIndex));
  });

  it('recognizes a CRLF blank line as a paragraph boundary', () => {
    // Review found the blank-line regex requiring a bare `\n\n`, which a CRLF checkout's
    // `\r\n\r\n` never produces (the `\r` between the two `\n` characters is not `[ \t]`) -- so on
    // CRLF the whole document read as one paragraph, widening localContext's clamp back to the
    // unbounded window it exists to prevent. Asserted against `paragraphBounds` directly, with no
    // sentence-ending punctuation in the filler text: `sentenceBounds`' own period/question/
    // exclamation-mark clamp would otherwise exclude the filler paragraph on its own and mask a
    // broken paragraph clamp entirely, the way it did on a first draft of this test.
    const source =
      'An unrelated filler paragraph with no sentence-ending punctuation\r\n\r\n' +
      'Remove the bracket\r\n';
    const index = source.indexOf('Remove');
    const { start } = paragraphBounds(source, index);
    expect(source.slice(start, index)).not.toContain('filler');
  });
});

describe('sentenceBounds', () => {
  it('excludes an earlier sentence in the same paragraph', () => {
    const source = '## heading\n\nFix the seal now. Remove the bracket; verify it afterward.\n';
    const index = source.indexOf('Remove');
    const { start } = sentenceBounds(source, index);
    expect(source.slice(start, index).trim()).toBe('');
  });

  it('excludes a later sentence in the same paragraph', () => {
    const source = '## heading\n\nRemove the bracket; verify it afterward. Then close the panel.\n';
    const index = source.indexOf('Remove');
    const { end } = sentenceBounds(source, index);
    expect(source.slice(index, end)).toBe('Remove the bracket; verify it afterward.');
  });

  it('falls back to the paragraph bounds when the paragraph has no sentence-ending punctuation', () => {
    const source = '## heading\n\nRemove the bracket now and verify it afterward too\n';
    const index = source.indexOf('Remove');
    expect(sentenceBounds(source, index)).toEqual(paragraphBounds(source, index));
  });
});

describe('regressionsToGuard', () => {
  it('does not treat a missing baseline as a regression against every current finding', () => {
    // Review found `--update` comparing the whole dirty corpus against `{}` whenever no baseline
    // file existed yet, so first-time creation always failed without `--accept-regressions` --
    // contradicting the assert-mode message that says plain `--update` creates the file.
    const byFile = new Map([['a.md', new Map([['rule\nmsg\nctx\n#h\n1', 3]])]]);
    expect(regressionsToGuard(byFile, false, {})).toEqual([]);
  });

  it('still guards against regressions once a baseline exists', () => {
    const key = 'rule\nmsg\nctx\n#h\n1';
    const byFile = new Map([['a.md', new Map([[key, 3]])]]);
    const existing = { 'a.md': { total: 1, findings: { [key]: 1 } } };
    expect(regressionsToGuard(byFile, true, existing)).not.toEqual([]);
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

  it('recognizes an ATX heading indented by up to three spaces, per CommonMark', () => {
    // Review found the regex requiring the `#` at column zero, so a heading indented by one to
    // three spaces (CommonMark's own allowance, the same one fencedCodeRanges already gives a
    // fence marker) was invisible to this function -- a finding moved under an indented heading
    // kept the fingerprint of having no enclosing heading at all.
    const source = '  ## Indented Heading\n\ntext here\n';
    expect(nearestHeading(source, source.indexOf('text here'))).toBe('## Indented Heading');
  });

  it('still does not treat a four-space-indented line as an ATX heading', () => {
    // Four or more leading spaces is CommonMark's indented-code-block threshold, not a heading --
    // this must stay excluded, not merely widen the accepted indentation without bound.
    const source = '    ## Too Indented\n\ntext here\n';
    expect(nearestHeading(source, source.indexOf('text here'))).toBe('');
  });

  it('ignores a heading-shaped line inside a fenced code block', () => {
    // Review found the raw regex treating `# example` inside a ``` fence as a real heading, so
    // editing only that unrelated code example changed an untouched finding's key -- reported as
    // both a regression and an improvement for a cleanup that never touched the finding at all.
    const source = '## Real Heading\n\n```\n# example\n```\n\nSome violation text here.\n';
    const index = source.indexOf('Some violation');
    expect(nearestHeading(source, index)).toBe('## Real Heading');
  });

  it('still finds a real heading that follows a closed fence', () => {
    const source = '```\n# not a heading\n```\n\n## Real After Fence\n\ntext here\n';
    expect(nearestHeading(source, source.indexOf('text here'))).toBe('## Real After Fence');
  });

  it('treats a fence-marker-shaped code line with trailing text as still inside the block', () => {
    // Review found the closing-fence check accepting an info string the way an opening fence does,
    // so a fenced example showing a fake closing fence (` ```not-a-closing-fence `) ended the range
    // early. A heading-shaped line between that fake closer and the real one then read as a real
    // heading instead of fenced content.
    const source =
      '## Real Heading\n\n```\nsome code\n```not-a-closing-fence\n# example\n```\n\nSome violation text here.\n';
    const index = source.indexOf('Some violation');
    expect(nearestHeading(source, index)).toBe('## Real Heading');
  });

  it('still closes a fence whose closing marker line ends with a carriage return', () => {
    // Review found the closing-fence whitespace check rejecting the trailing `\r` a CRLF checkout
    // leaves in `rest` (the raw regex captures up to `\n`, not the line-ending style), so every
    // closing fence in a CRLF file failed to close and the open range ran to end of file --
    // silently dropping every later heading from view, including this one.
    const source = '```\r\n# not a heading\r\n```\r\n\r\n## Real After Fence\r\n\r\ntext here\r\n';
    expect(nearestHeading(source, source.indexOf('text here'))).toBe('## Real After Fence');
  });

  it('does not open a fence for a backtick line whose info string itself contains a backtick', () => {
    // Per CommonMark, a backtick fence's info string may not contain a backtick -- such a line is
    // not a fence at all. Review found this unconditionally treated as an opening fence anyway, so
    // it opened a range that never legitimately closed, running to EOF and hiding every real
    // heading after it.
    const source =
      '## Real Heading\n\n```info with a ` backtick\nsome text\n\n## Should Still Be Found\n\ntext here\n';
    expect(nearestHeading(source, source.indexOf('text here'))).toBe('## Should Still Be Found');
  });

  it('still fences a tilde block whose info string contains a backtick', () => {
    // The backtick-in-info-string restriction is specific to backtick fences -- a tilde fence's
    // info string may contain backticks freely, per CommonMark, and must still fence normally.
    const source =
      '## Real Heading\n\n~~~info with a ` backtick\n# not a heading\n~~~\n\ntext here\n';
    expect(nearestHeading(source, source.indexOf('text here'))).toBe('## Real Heading');
  });

  it('recognizes a Setext heading, not only ATX ones', () => {
    // Review found this recognizing only ATX headings (`# Text`); CommonMark also permits a Setext
    // heading -- a text line followed by an `=`- or `-`-only underline. A finding moved between two
    // differently named Setext sections kept the same enclosing-heading component regardless,
    // silently defeating the cross-heading regression guard `findingKey` relies on this for.
    const source = 'Section Title\n=============\n\ntext here\n';
    expect(nearestHeading(source, source.indexOf('text here'))).toBe('Section Title');
  });

  it('does not treat a thematic break as a Setext heading when nothing precedes it', () => {
    // A `---` line not preceded by a non-blank text line is a thematic break, not a Setext heading
    // underline -- there is no heading text for it to belong to.
    const source = '## Real Heading\n\n---\n\ntext here\n';
    expect(nearestHeading(source, source.indexOf('text here'))).toBe('## Real Heading');
  });

  it('does not treat an ATX heading followed by a dashes line as a Setext pair', () => {
    // The ATX heading line is already a complete heading; the `---` right after it must not be
    // reinterpreted as a Setext underline turning the ATX line's own text into a duplicate heading.
    const source = '## Real Heading\n---\n\ntext here\n';
    expect(nearestHeading(source, source.indexOf('text here'))).toBe('## Real Heading');
  });

  it('ignores a Setext-heading-shaped pair inside a fenced code block', () => {
    const source = '## Real Heading\n\n```\nFake Title\n----------\n```\n\ntext here\n';
    expect(nearestHeading(source, source.indexOf('text here'))).toBe('## Real Heading');
  });

  it('recognizes an ATX heading inside a block quote', () => {
    // Review found the ATX pattern requiring the leading spaces to reach the `#` directly, so a
    // heading inside a block quote (`> # Alpha`) was invisible to this function. A finding moved
    // from one blockquoted heading's section to a differently named one kept the same empty-heading
    // key regardless, silently defeating the cross-heading regression guard.
    const source = '> # Alpha\n\ntext here\n';
    expect(nearestHeading(source, source.indexOf('text here'))).toBe('# Alpha');
  });

  it('recognizes an ATX heading inside a nested block quote', () => {
    const source = '> > # Nested\n\ntext here\n';
    expect(nearestHeading(source, source.indexOf('text here'))).toBe('# Nested');
  });

  it('does not treat ordinary quoted prose as a heading', () => {
    const source = '## Real Heading\n\n> just a quote, not a heading\n\ntext here\n';
    expect(nearestHeading(source, source.indexOf('text here'))).toBe('## Real Heading');
  });

  it('ignores a blockquoted-heading-shaped line inside a fenced code block', () => {
    const source = '## Real Heading\n\n```\n> # Fake\n```\n\ntext here\n';
    expect(nearestHeading(source, source.indexOf('text here'))).toBe('## Real Heading');
  });

  it('ignores a heading-shaped line inside a block-quoted fenced code block', () => {
    // Review found `fencedCodeRanges` blind to a fence inside a block quote (`> ``` `, used
    // throughout docs/design/64-layered-rule-packs/02-authority-trust.md) -- once the ATX pattern
    // learned to recognize a blockquoted heading, a heading-shaped line inside a blockquoted fence
    // read as a real heading instead of fenced content.
    const source = '## Real Heading\n\n> ```\n> # example\n> ```\n\ntext here\n';
    expect(nearestHeading(source, source.indexOf('text here'))).toBe('## Real Heading');
  });

  it('recognizes a Setext heading inside a block quote', () => {
    // Review found the Setext pattern still rejecting the same leading `>` the ATX pattern had
    // just been given -- its text-line guard excluded `>` the same way it excludes `#`, so a
    // blockquoted Setext heading (`> Alpha` / `> =====`) fell all the way back to no heading at
    // all instead of the enclosing one.
    const source = '> Alpha\n> =====\n\ntext here\n';
    expect(nearestHeading(source, source.indexOf('text here'))).toBe('Alpha');
  });

  it('recognizes a Setext heading inside a nested block quote', () => {
    const source = '> > Nested Alpha\n> > ========\n\ntext here\n';
    expect(nearestHeading(source, source.indexOf('text here'))).toBe('Nested Alpha');
  });

  it('ignores a blockquoted-Setext-heading-shaped pair inside a fenced code block', () => {
    const source = '## Real Heading\n\n```\n> Fake\n> =====\n```\n\ntext here\n';
    expect(nearestHeading(source, source.indexOf('text here'))).toBe('## Real Heading');
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

describe('findRegressions', () => {
  it('flags a brand-new file with no baseline entry, the same as any other new debt', () => {
    // A prior fix treated "no entry for this path at all" as exempt, the same "no prior state to
    // regress from" principle `regressionsToGuard` applies when the *whole* baseline file is
    // missing. Review found that too broad: it let an ordinary `--update` for an unrelated cleanup
    // silently also record a brand-new dirty file's debt into a baseline that already exists, with
    // no `--accept-regressions` confirmation at all -- exactly what the module's own contract
    // ("New and renamed files cannot add debt") and this whole guard exist to prevent. Only the
    // true bootstrap case (the entire baseline file absent) gets the free pass, and that lives
    // entirely in `regressionsToGuard`'s own `baselineExists` gate, not here.
    const byFile = new Map([['new.md', new Map([['rule\nmsg\nctx\n#h\n1', 3]])]]);
    expect(findRegressions(byFile, {})).toEqual([
      { path: 'new.md', ruleId: 'rule', message: 'msg', before: 0, after: 3 },
    ]);
  });

  it('still flags a new finding in a file that already has a baseline entry', () => {
    const baseline = { 'tracked.md': { total: 1, findings: { 'rule\nmsg\nctx\n#h\n1': 1 } } };
    const byFile = new Map([
      [
        'tracked.md',
        new Map([
          ['rule\nmsg\nctx\n#h\n1', 1],
          ['rule\nother\nctx\n#h\n1', 1],
        ]),
      ],
    ]);
    expect(findRegressions(byFile, baseline)).toEqual([
      { path: 'tracked.md', ruleId: 'rule', message: 'other', before: 0, after: 1 },
    ]);
  });
});

describe('findImprovements', () => {
  it('flags a file whose findings shrank but did not reach zero, not only a fully-cleaned one', () => {
    // README.md claimed only two shrink cases required `--update`: a file with no baseline entry,
    // and one that became fully clean again. Review found a third, already implemented here and
    // documented in this file's own module comment, missing from the README: a file that still has
    // findings, but fewer than the baseline allows, must be recorded too -- otherwise the baseline
    // carries slack a later change could spend back by reintroducing exactly what was fixed.
    const baseline = { 'dirty.md': { total: 3, findings: { 'rule\nmessage\nctx\n#h\n1': 3 } } };
    const byFile = new Map([['dirty.md', new Map([['rule\nmessage\nctx\n#h\n1', 1]])]]);
    expect(findImprovements(byFile, baseline)).toEqual(['dirty.md']);
  });
});
