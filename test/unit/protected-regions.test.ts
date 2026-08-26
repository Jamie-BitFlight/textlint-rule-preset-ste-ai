import { describe, expect, it } from 'vite-plus/test';
import { analyseDocument } from '../../src/core/document.js';
import {
  defaultProtectedRegionOptions,
  extractProtectedRegions,
  opaqueRangesOf,
} from '../../src/core/protected-regions.js';
import { MASK_CHAR, mergeRanges } from '../../src/core/text.js';
import type { ProtectedRegion, ProtectedRegionKind } from '../../src/core/types.js';

/**
 * Kinds of every region that fully encloses the needle, not merely overlaps it. Containment, not
 * overlap: a pass that returned only one character of a longer needle under the right kind used to
 * satisfy an overlap check while leaving the rest of that needle exposed to analysis. Requiring the
 * region to enclose `[start, end)` catches that -- verified directly by mutating
 * `extraPatternPass.find` in `protected-regions.ts` to return a 1-character region at the needle's
 * start: the overlap check still passed, this containment check fails.
 */
function kindsAt(text: string, needle: string, searchFrom = 0): ProtectedRegionKind[] {
  const start = text.indexOf(needle, searchFrom);
  expect(
    start,
    `"${needle}" must appear in the sample at or after ${searchFrom}`,
  ).toBeGreaterThanOrEqual(0);
  const end = start + needle.length;
  return extractProtectedRegions(text, defaultProtectedRegionOptions)
    .filter((r) => r.range.start <= start && end <= r.range.end)
    .map((r) => r.kind);
}

function analyse(text: string) {
  return analyseDocument({ id: 't', format: 'markdown', text });
}

describe('protected-region extraction', () => {
  it('masking preserves length exactly, so offsets stay valid', () => {
    const text = 'Run `make install` at /usr/local and see https://example.com/a.\n';
    const doc = analyse(text);
    expect(doc.maskedText).toHaveLength(text.length);
    for (let i = 0; i < text.length; i += 1) {
      const masked = doc.maskedText[i];
      expect(masked === text[i] || masked === MASK_CHAR).toBe(true);
    }
  });

  it('never masks newlines, so line and column arithmetic is unaffected', () => {
    const text = '```\ncode\nmore code\n```\n\nProse.\n';
    const doc = analyse(text);
    // `[...text]` iterates by Unicode code point, not UTF-16 code unit, and would silently
    // mis-index against `doc.maskedText[i]` (and every other offset in this codebase) for any
    // text containing an astral character. Index by code unit directly instead, matching the
    // offset contract everywhere else.
    const newlinePositions: number[] = [];
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '\n') newlinePositions.push(i);
    }
    for (const i of newlinePositions) {
      expect(doc.maskedText[i]).toBe('\n');
    }
    expect(doc.positionAt(text.indexOf('Prose.')).line).toBe(6);
  });

  it('finds newline positions correctly even when the text has an astral character before them', () => {
    // Regression: an earlier version of this test located newlines by spreading the string
    // (`[...text]`), which walks Unicode code points. A code point outside the BMP (like an emoji)
    // is one JS array element from `[...text]` but two UTF-16 code units in the plain string
    // `text.length`/`text[i]` indexes -- the same indexing `doc.maskedText` and `positionAt` use.
    // Past that character, a code-point index and a code-unit index diverge, so `doc.maskedText[i]`
    // (code-unit indexed) would be checked against the wrong `i` (code-point indexed). This fixture
    // puts a surrogate-pair emoji before a newline specifically to catch that class of bug again.
    const text = 'Prose with an emoji \u{1F389}\nmore prose.\n';
    const doc = analyse(text);
    const newlinePositions: number[] = [];
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '\n') newlinePositions.push(i);
    }
    // Two UTF-16 code units for the emoji push the first newline's code-unit index one past where a
    // naive code-point count would land.
    expect(newlinePositions[0]).toBe(text.indexOf('\n'));
    for (const i of newlinePositions) {
      expect(doc.maskedText[i]).toBe('\n');
    }
  });

  // Each row names the exact substring ("needle") the pass under test is expected to protect, so
  // the assertion below checks that a region of `kind` covers THAT span specifically -- not that
  // a region of `kind` exists anywhere in the document. Without a needle, a pass could emit its
  // kind for the wrong offsets (or for offsets 0-1) and every row would stay green; see `kindsAt`.
  const cases: readonly [string, string, ProtectedRegionKind, string][] = [
    ['fenced code', '```bash\nrm -rf /tmp/x\n```\n', 'fenced-code', '```bash\nrm -rf /tmp/x\n```'],
    ['inline code', 'Set `MAX_RETRIES` now.\n', 'inline-code', '`MAX_RETRIES`'],
    ['url', 'See https://example.com/x for more.\n', 'url', 'https://example.com/x'],
    ['email', 'Write to ops@example.com now.\n', 'email', 'ops@example.com'],
    ['absolute path', 'Edit /etc/hosts first.\n', 'file-path', '/etc/hosts'],
    ['windows path', 'Open C:\\Program\\app.exe now.\n', 'file-path', 'C:\\Program\\app.exe'],
    ['identifier', 'Call requestHandler now.\n', 'identifier', 'requestHandler'],
    ['dotted api', 'Use os.path.join here.\n', 'identifier', 'os.path.join'],
    ['snake case', 'Set max_retry_count now.\n', 'identifier', 'max_retry_count'],
    ['cli flag', 'Pass --verbose to it.\n', 'identifier', '--verbose'],
    ['quantity', 'Torque it to 25 Nm now.\n', 'numeric-expression', '25 Nm'],
    ['version', 'Install version 1.22.3 now.\n', 'numeric-expression', '1.22.3'],
    ['tolerance', 'Set 25 ± 2 now.\n', 'numeric-expression', '25 ± 2'],
    ['placeholder', 'Replace {{TOKEN}} now.\n', 'placeholder', '{{TOKEN}}'],
    ['env placeholder', 'Export ${HOME} now.\n', 'placeholder', '${HOME}'],
    ['quoted literal', 'Click "Save As" now.\n', 'quoted-literal', '"Save As"'],
    ['front matter', '---\ntitle: x\n---\n\nProse.\n', 'front-matter', '---\ntitle: x\n---'],
    ['html comment', 'A <!-- hidden --> b.\n', 'comment', '<!-- hidden -->'],
    ['math', 'Given $x = 1$ now.\n', 'math', '$x = 1$'],
    ['heading marker', '## Title\n', 'heading-marker', '##'],
    ['list marker', '- item one\n- item two\n', 'list-marker', '-'],
    ['blockquote marker', '> quoted line\n', 'blockquote-marker', '>'],
    [
      'reference definition',
      '[a]: https://example.com "T"\n',
      'reference-definition',
      '[a]: https://example.com "T"',
    ],
    ['footnote', 'Text[^1] here.\n', 'footnote-marker', '[^1]'],
    ['autolink', 'See <https://example.com> now.\n', 'autolink', '<https://example.com>'],
    ['shell prompt line', '$ make install\n', 'shell-command', '$ make install'],
  ];

  for (const [label, text, kind, needle] of cases) {
    it(`protects ${label} as ${kind}`, () => {
      expect(kindsAt(text, needle)).toContain(kind);
    });
  }

  it('keeps the language tag of a fence inside the protected span', () => {
    expect(kindsAt('```python\nprint(1)\n```\n', 'python')).toContain('fenced-code');
  });

  it('protects a link destination but leaves the link text as prose', () => {
    const text = 'Read the [utilise guide](https://example.com/utilise) now.\n';
    const doc = analyse(text);
    const linkTextStart = text.indexOf('utilise guide');
    expect(doc.isProtected({ start: linkTextStart, end: linkTextStart + 7 })).toBe(false);
    const destStart = text.indexOf('https://example.com/utilise');
    expect(doc.isProtected({ start: destStart, end: destStart + 5 })).toBe(true);
  });

  it('keeps brackets balanced when masking a link, so sentence splitting still works', () => {
    // Regression: masking `](dest)` as one span removed the closing `]`, leaving `[` unpaired.
    // sentence-splitter's pair tracking then treated the rest of the block as bracketed and
    // collapsed every following sentence into one, which inflated sentence-length findings and
    // made them impossible to fix.
    const text =
      'See the [Debug Pods](https://k8s.io/docs/debug) guide. This is a second sentence. And a third one here.\n';
    const doc = analyse(text);
    expect(doc.sentences.map((s) => s.raw)).toEqual([
      'See the [Debug Pods](https://k8s.io/docs/debug) guide.',
      'This is a second sentence.',
      'And a third one here.',
    ]);
    // The destination is protected; the link text is not.
    const destStart = text.indexOf('(https://k8s.io');
    expect(doc.isProtected({ start: destStart, end: destStart + 5 })).toBe(true);
    const closingBracket = text.indexOf(']');
    expect(doc.maskedText[closingBracket]).toBe(']');
  });

  it('handles several links in one paragraph without losing sentence boundaries', () => {
    const text =
      'Read [one](https://a.example/x) first. Then read [two](https://b.example/y) next. Finally stop.\n';
    expect(analyse(text).sentences).toHaveLength(3);
  });

  it('does not treat an admonition label as a config fragment', () => {
    const text = 'WARNING: Do not touch the busbar.\n';
    const doc = analyse(text);
    expect(doc.isProtected({ start: 0, end: text.length - 1 })).toBe(false);
    expect(doc.sentences.length).toBeGreaterThan(0);
  });

  it('does treat a real assignment line as a config fragment', () => {
    const kinds = extractProtectedRegions('MAX_RETRIES=5\n', defaultProtectedRegionOptions).map(
      (r) => r.kind,
    );
    expect(kinds).toContain('config-fragment');
  });

  it('leaves `e.g.` as prose so the abbreviation rule can see it', () => {
    const text = 'Use a fastener, e.g. a bolt.\n';
    const doc = analyse(text);
    const at = text.indexOf('e.g.');
    expect(doc.isProtected({ start: at, end: at + 4 })).toBe(false);
  });

  it('keeps snake_case identifiers intact when wrapped in emphasis', () => {
    const kinds = extractProtectedRegions(
      'Set **max_retry_count** now.\n',
      defaultProtectedRegionOptions,
    );
    const identifier = kinds.find((r) => r.kind === 'identifier');
    expect(identifier).toBeDefined();
    expect(
      'Set **max_retry_count** now.\n'.slice(identifier?.range.start, identifier?.range.end),
    ).toBe('max_retry_count');
  });

  it('protects user-supplied approved terms case-sensitively on word boundaries', () => {
    const text = 'The Acme WidgetPro is ready. The widgetpro clone is not.\n';
    const regions = extractProtectedRegions(text, {
      ...defaultProtectedRegionOptions,
      approvedTerms: ['Acme WidgetPro'],
    });
    const approved = regions.filter((r) => r.kind === 'approved-term');
    expect(approved).toHaveLength(1);
    expect(text.slice(approved[0]?.range.start, approved[0]?.range.end)).toBe('Acme WidgetPro');
  });

  // Extraction returns ranges and has no channel for a notice, so refusing an unusable pattern is
  // all it can do here; `test/unit/protected-patterns.test.ts` covers the reporting side, which is
  // where the same screen runs once per analysis run and yields `invalid-protected-pattern`.
  //
  // The fixture token must NOT already be identifier-shaped on its own: `PN12345` (an earlier
  // version of this fixture) is caught by identifierPass's own bare `[A-Z]{2,}[0-9]{2,}` pattern
  // regardless of extraPatterns, so a version of this test built on it would still pass even with
  // extraPatternPass deleted outright -- the same "does a region of this kind exist anywhere"
  // false oracle as the loop above, just laundered through `extraPatterns`. `xz42` is lowercase and
  // has no built-in pattern behind it (verified: `extractProtectedRegions` on the bare sentence
  // below with no `extraPatterns` returns no regions at all), so a match here can only have come
  // from the configured `extraPatterns`.
  it.each([
    ['an invalid one', '([unclosed'],
    ['one whose match time is unbounded', '(\\d+)+'],
  ])('applies the usable extra user patterns and skips %s without throwing', (_label, unusable) => {
    const text = 'Part xz42 ships.\n';
    expect(extractProtectedRegions(text, defaultProtectedRegionOptions)).toHaveLength(0);
    const regions = extractProtectedRegions(text, {
      ...defaultProtectedRegionOptions,
      extraPatterns: ['xz\\d+', unusable],
    });
    const xz42 = regions.filter((r) => text.slice(r.range.start, r.range.end) === 'xz42');
    expect(xz42.map((r) => r.kind)).toEqual(['identifier']);
  });

  it('protects table pipes but keeps cell prose visible', () => {
    const text = '| Step | Action |\n| --- | --- |\n| 1 | Utilise the tool |\n';
    const doc = analyse(text);
    const cellStart = text.indexOf('Utilise');
    expect(doc.isProtected({ start: cellStart, end: cellStart + 7 })).toBe(false);
    const pipe = text.indexOf('|');
    expect(doc.isProtected({ start: pipe, end: pipe + 1 })).toBe(true);
    expect(doc.blocks.filter((b) => b.kind === 'table-cell').length).toBeGreaterThan(0);
  });

  it('handles an unterminated fence by protecting to the end of the document', () => {
    const text = 'Prose here.\n\n```\nunclosed code utilise\n';
    const doc = analyse(text);
    const at = text.indexOf('unclosed');
    expect(doc.isProtected({ start: at, end: at + 8 })).toBe(true);
  });

  it.each([
    ['aws access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['github token', 'ghp_16C7e42F292c6912E7710c838347Ae1781234'],
    ['hex digest', 'a3f5c9d2e8b1074c6f2a9e5d3b8c1f70'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N'],
  ])('protects a bare %s in prose as a credential', (_what, token) => {
    const text = `The service uses ${token} for the request.\n`;
    // `credential` must be among the kinds: another pass may also claim part of the span (a JWT is
    // dotted like an API path), but the credential classification is what the trace has to show.
    expect(kindsAt(text, token)).toContain('credential');
    expect(analyse(text).maskedText).not.toContain(token);
  });

  it('protects a password bound in prose but not the sentence around it', () => {
    const text = 'The default password is hunter2 and it must be changed.\n';
    const doc = analyse(text);
    expect(doc.maskedText).not.toContain('hunter2');
    expect(doc.maskedText).toContain('The default password is ');
    expect(doc.maskedText).toContain(' and it must be changed.');
  });

  it('leaves prose that merely mentions a credential alone', () => {
    const text = 'The password is set by the installer and the key is stored in the vault.\n';
    expect(analyse(text).maskedText).toBe(text);
  });

  it('does not protect prose that merely sits next to protected content', () => {
    const text = 'Utilise `foo` and utilise /etc/bar too.\n';
    const doc = analyse(text);
    const first = text.indexOf('Utilise');
    const second = text.indexOf('utilise', first + 1);
    expect(doc.isProtected({ start: first, end: first + 7 })).toBe(false);
    expect(doc.isProtected({ start: second, end: second + 7 })).toBe(false);
  });
});

describe('configFragmentPass mid-sentence alternative, identifierPass citations, and corroboratedConstantPass', () => {
  it('protects a mid-sentence quoted config literal via configFragmentPass, not the wrapping quotes', () => {
    const text = 'Unless running in "auto_vacuum=FULL" mode, verify the setting.\n';
    expect(kindsAt(text, 'auto_vacuum=FULL')).toContain('config-fragment');
    // Boundary check: the mid-sentence alternative is not anchored to line start/end (unlike the
    // other two configFragmentPass alternatives), so nothing here stops its match from also
    // swallowing the wrapping quote characters. Pinning the quotes as unprotected catches a
    // mutation that widens the pattern to consume `"auto_vacuum=FULL"` (quotes included): the
    // `kindsAt` overlap check above would still pass -- it only proves SOME config-fragment region
    // touches the 16-char span, not that the span stops exactly there.
    const doc = analyse(text);
    const openQuote = text.indexOf('"');
    const closeQuote = text.indexOf('"', openQuote + 1);
    expect(doc.isProtected({ start: openQuote, end: openQuote + 1 })).toBe(false);
    expect(doc.isProtected({ start: closeQuote, end: closeQuote + 1 })).toBe(false);
  });

  it('protects a mid-sentence bare-keyword assignment, leaving the sentence-final period as prose', () => {
    const text = 'Set PRAGMA secure_delete=ON.\n';
    expect(kindsAt(text, 'PRAGMA secure_delete=ON')).toContain('config-fragment');
    const doc = analyse(text);
    const periodIndex = text.indexOf('.');
    expect(doc.maskedText[periodIndex]).toBe('.');
  });

  it('rejects a single-word label before "=" as a config fragment (second admonition-shaped regression)', () => {
    const text = 'Note = see section 4 for details.\n';
    const kinds = extractProtectedRegions(text, defaultProtectedRegionOptions).map((r) => r.kind);
    expect(kinds).not.toContain('config-fragment');
  });

  it('protects standards-body citation numbers as identifiers', () => {
    expect(kindsAt('as described in RFC 3986 for details', 'RFC 3986')).toContain('identifier');
    expect(kindsAt('enable FIPS 140-2 mode', 'FIPS 140-2')).toContain('identifier');
  });

  it('corroborates a bare constant via an exact-match config-fragment value', () => {
    // corroboratedConstantPass protects only the bare all-caps token itself, not the sentence
    // around it -- the needle below must match that exactly, or the containment check in
    // `kindsAt` fails even though the pass is working. `searchFrom` skips past the corroborating
    // `secure_delete=ON` occurrence to the standalone token the pass actually protects.
    const text = 'Enable secure_delete=ON now. ON is the recommended value for most systems.\n';
    expect(kindsAt(text, 'secure_delete=ON')).toContain('config-fragment');
    expect(kindsAt(text, 'ON', text.indexOf(' now.'))).toContain('constant');
  });

  it('corroborates a bare constant via a segment of an identifier region', () => {
    const text =
      'Set LLVM_ENABLE_PROJECTS to clang. LLVM is the compiler infrastructure used here.\n';
    expect(kindsAt(text, 'LLVM_ENABLE_PROJECTS')).toContain('identifier');
    expect(kindsAt(text, 'LLVM', text.indexOf(' to clang'))).toContain('constant');
  });

  it('corroborates a bare constant via a config-fragment occurrence of WAL', () => {
    const text = 'Set journal_mode=WAL for better concurrency. WAL is the write-ahead log mode.\n';
    expect(kindsAt(text, 'journal_mode=WAL')).toContain('config-fragment');
    expect(kindsAt(text, 'WAL', text.indexOf(' for better'))).toContain('constant');
  });

  it('does not protect an uncorroborated bare all-caps token as a constant', () => {
    const text = 'The XYZ approach was discussed today.\n';
    const doc = analyse(text);
    const at = text.indexOf('XYZ');
    expect(doc.isProtected({ start: at, end: at + 3 })).toBe(false);
  });

  it('protects the mid-sentence config-fragment span under the plain-text format too', () => {
    const text = 'Unless running in "auto_vacuum=FULL" mode, verify the setting.\n';
    const regions = extractProtectedRegions(text, {
      ...defaultProtectedRegionOptions,
      format: 'text',
    });
    const start = text.indexOf('auto_vacuum=FULL');
    const end = start + 'auto_vacuum=FULL'.length;
    const kinds = regions
      .filter((r) => r.range.start < end && start < r.range.end)
      .map((r) => r.kind);
    expect(kinds).toContain('config-fragment');
  });
});

describe('mergeRanges: overlapping-span determinism', () => {
  // extractProtectedRegions runs each pass against progressively-masked text (every found range
  // is masked before the next pass runs), and several passes additionally skip a match that
  // already contains MASK_CHAR (see `containsMask` call sites in protected-regions.ts). Together
  // those two things mean a real document essentially never gets two *different* passes to claim
  // a genuinely partial (crossing) overlap of the same text -- a wide, unguarded pattern (e.g.
  // `configFragmentPass`'s `\S+` value, or `shellCommandPass`'s `\S.*$`) can still match across an
  // already-masked span, but only ever as a strict *containment* (the later, wider region swallows
  // the earlier, narrower one whole), never a crossing overlap where each range has territory the
  // other lacks. So the scenario this section covers -- two independent regions whose spans
  // partially overlap, as in the task's `https://example.com/path` (url) vs. an overlapping
  // `example.com`-shaped span (an identifier-like pass) -- is exercised directly against
  // `mergeRanges` (and, one level up, `opaqueRangesOf`, its real production caller from
  // `protected-regions.ts` and `document.ts`) with synthetic ranges, rather than manufactured from
  // real input text that the current pass set cannot actually produce.
  it('merges two partially-overlapping ranges into their union, not the larger or the first', () => {
    // Neither range contains the other: [0,10) ends before [8,30) does, and [8,30) starts after
    // [0,10) does. A "keep the larger" or "keep the first" merge would drop the [0,8) prefix that
    // only the first range covers; a correct union keeps it.
    expect(
      mergeRanges([
        { start: 0, end: 10 },
        { start: 8, end: 30 },
      ]),
    ).toEqual([{ start: 0, end: 30 }]);
    // Order in the input must not matter.
    expect(
      mergeRanges([
        { start: 8, end: 30 },
        { start: 0, end: 10 },
      ]),
    ).toEqual([{ start: 0, end: 30 }]);
  });

  it('merges ranges that only touch at a shared boundary point', () => {
    // Catches a `<=` -> `<` mutation on the adjacency test in mergeRanges: with `<`, two ranges
    // that share exactly one boundary point (`end === start`) would stay separate spans instead of
    // collapsing into one, which would leave a zero-width masking gap at the seam.
    expect(
      mergeRanges([
        { start: 0, end: 5 },
        { start: 5, end: 10 },
      ]),
    ).toEqual([{ start: 0, end: 10 }]);
  });

  it('leaves genuinely disjoint ranges as separate spans', () => {
    expect(
      mergeRanges([
        { start: 0, end: 5 },
        { start: 10, end: 15 },
      ]),
    ).toEqual([
      { start: 0, end: 5 },
      { start: 10, end: 15 },
    ]);
  });

  it('opaqueRangesOf unions overlapping regions from two independently-kinded passes for masking, without dropping either region', () => {
    // The production call site: protected-regions.ts's opaqueRangesOf (and document.ts's
    // buildStructuralMask) both feed every region's range from every pass into mergeRanges. Two
    // regions of different kinds -- standing in for a `url` pass and a domain-shaped pass that
    // independently claimed an overlapping span -- must still both appear as distinct
    // ProtectedRegion entries (so the trace keeps both kinds), while the masked span they jointly
    // cover is their union.
    const regions: readonly ProtectedRegion[] = [
      { kind: 'url', range: { start: 0, end: 20 }, opaque: true },
      { kind: 'identifier', range: { start: 12, end: 28 }, opaque: true },
    ];
    expect(opaqueRangesOf(regions)).toEqual([{ start: 0, end: 28 }]);
  });
});

describe('approvedTerms: regex-special characters', () => {
  // approvedTermPass (protected-regions.ts) escapes each configured term before building its
  // matcher (`term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`), so a term that happens to look like
  // regex syntax is still matched as the literal string the operator configured. These tests pin
  // that behaviour for the three shapes most likely to appear in real STE terminology lists.
  it('matches "C++" literally instead of crashing on a doubled quantifier', () => {
    // Unescaped, `C++` is not a valid regex fragment on its own (`+` needs something to repeat, and
    // a second `+` has nothing left to repeat) -- `new RegExp` throws. Confirms both that
    // extraction does not crash and that it protects exactly the literal term.
    const text = 'The driver is written in C++ for this platform.\n';
    const regions = extractProtectedRegions(text, {
      ...defaultProtectedRegionOptions,
      approvedTerms: ['C++'],
    });
    const approved = regions.filter((r) => r.kind === 'approved-term');
    expect(approved).toHaveLength(1);
    expect(text.slice(approved[0]?.range.start, approved[0]?.range.end)).toBe('C++');
  });

  it('matches ".NET" literally, not "any-character then NET"', () => {
    // Unescaped, the leading `.` in `.NET` is the regex wildcard, so it would also match
    // "xNET" (any single character in place of the dot). `xNET` here must stay unprotected while
    // the real ".NET" occurrence is protected, which only holds if the `.` is escaped.
    const text = 'Do not confuse xNET with the .NET runtime.\n';
    const regions = extractProtectedRegions(text, {
      ...defaultProtectedRegionOptions,
      approvedTerms: ['.NET'],
    });
    const approved = regions.filter((r) => r.kind === 'approved-term');
    expect(approved).toHaveLength(1);
    expect(text.slice(approved[0]?.range.start, approved[0]?.range.end)).toBe('.NET');
    const bogus = text.indexOf('xNET');
    expect(approved.some((r) => r.range.start <= bogus && bogus + 4 <= r.range.end)).toBe(false);
  });

  it('matches "A|B" literally, not as alternation between bare "A" and "B"', () => {
    // Unescaped, `|` is regex alternation: an unescaped `A|B` matcher would protect every bare "A"
    // and every bare "B" in the document, not just the combined token. Only the three-character
    // "A|B" span may come back as an approved-term region.
    const text = 'The A rating and the B rating combine into an A|B composite rating.\n';
    const regions = extractProtectedRegions(text, {
      ...defaultProtectedRegionOptions,
      approvedTerms: ['A|B'],
    });
    const approved = regions.filter((r) => r.kind === 'approved-term');
    expect(approved).toHaveLength(1);
    expect(text.slice(approved[0]?.range.start, approved[0]?.range.end)).toBe('A|B');
  });
});

describe('word tokenisation', () => {
  it('counts a content-bearing protected region as exactly one word', () => {
    const doc = analyse('Torque the bolt to 25 Nm now.\n');
    const sentence = doc.sentences[0];
    expect(sentence).toBeDefined();
    const quantity = sentence?.words.find((w) => w.protectedKind === 'numeric-expression');
    expect(quantity?.text).toBe('25 Nm');
    expect(sentence?.words.map((w) => w.text)).toEqual([
      'Torque',
      'the',
      'bolt',
      'to',
      '25 Nm',
      'now',
    ]);
  });

  it('produces no word for structural markers', () => {
    const doc = analyse('1. Install the unit.\n');
    const sentence = doc.sentences[0];
    expect(sentence?.words.map((w) => w.text)).toEqual(['Install', 'the', 'unit']);
  });

  it('keeps every word range pointing at the word it names', () => {
    const text = 'Remove the M6 bolt and the `cover` plate.\n';
    const doc = analyse(text);
    for (const sentence of doc.sentences) {
      for (const word of sentence.words) {
        expect(text.slice(word.range.start, word.range.end)).toBe(word.text);
      }
    }
  });
});
