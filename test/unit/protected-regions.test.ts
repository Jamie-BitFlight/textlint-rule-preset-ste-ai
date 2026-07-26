import { describe, expect, it } from 'vitest';
import { analyseDocument } from '../../src/core/document.js';
import {
  defaultProtectedRegionOptions,
  extractProtectedRegions,
} from '../../src/core/protected-regions.js';
import { MASK_CHAR } from '../../src/core/text.js';
import type { ProtectedRegionKind } from '../../src/core/types.js';

function kindsAt(text: string, needle: string): ProtectedRegionKind[] {
  const start = text.indexOf(needle);
  expect(start, `"${needle}" must appear in the sample`).toBeGreaterThanOrEqual(0);
  const end = start + needle.length;
  return extractProtectedRegions(text, defaultProtectedRegionOptions)
    .filter((r) => r.range.start < end && start < r.range.end)
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
    const newlinePositions = [...text].flatMap((c, i) => (c === '\n' ? [i] : []));
    for (const i of newlinePositions) {
      expect(doc.maskedText[i]).toBe('\n');
    }
    expect(doc.positionAt(text.indexOf('Prose.')).line).toBe(6);
  });

  const cases: readonly [string, string, ProtectedRegionKind][] = [
    ['fenced code', '```bash\nrm -rf /tmp/x\n```\n', 'fenced-code'],
    ['inline code', 'Set `MAX_RETRIES` now.\n', 'inline-code'],
    ['url', 'See https://example.com/x for more.\n', 'url'],
    ['email', 'Write to ops@example.com now.\n', 'email'],
    ['absolute path', 'Edit /etc/hosts first.\n', 'file-path'],
    ['windows path', 'Open C:\\Program\\app.exe now.\n', 'file-path'],
    ['identifier', 'Call requestHandler now.\n', 'identifier'],
    ['dotted api', 'Use os.path.join here.\n', 'identifier'],
    ['snake case', 'Set max_retry_count now.\n', 'identifier'],
    ['cli flag', 'Pass --verbose to it.\n', 'identifier'],
    ['quantity', 'Torque it to 25 Nm now.\n', 'numeric-expression'],
    ['version', 'Install version 1.22.3 now.\n', 'numeric-expression'],
    ['tolerance', 'Set 25 ± 2 now.\n', 'numeric-expression'],
    ['placeholder', 'Replace {{TOKEN}} now.\n', 'placeholder'],
    ['env placeholder', 'Export ${HOME} now.\n', 'placeholder'],
    ['quoted literal', 'Click "Save As" now.\n', 'quoted-literal'],
    ['front matter', '---\ntitle: x\n---\n\nProse.\n', 'front-matter'],
    ['html comment', 'A <!-- hidden --> b.\n', 'comment'],
    ['math', 'Given $x = 1$ now.\n', 'math'],
    ['heading marker', '## Title\n', 'heading-marker'],
    ['list marker', '- item one\n- item two\n', 'list-marker'],
    ['blockquote marker', '> quoted line\n', 'blockquote-marker'],
    ['reference definition', '[a]: https://example.com "T"\n', 'reference-definition'],
    ['footnote', 'Text[^1] here.\n', 'footnote-marker'],
    ['autolink', 'See <https://example.com> now.\n', 'autolink'],
    ['shell prompt line', '$ make install\n', 'shell-command'],
  ];

  for (const [label, text, kind] of cases) {
    it(`protects ${label} as ${kind}`, () => {
      const needle =
        kind === 'front-matter' ? '---\ntitle: x\n---' : (text.trim().split('\n')[0] ?? text);
      const found = extractProtectedRegions(text, defaultProtectedRegionOptions).map((r) => r.kind);
      expect(found).toContain(kind);
      void needle;
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

  it('accepts extra user patterns and ignores an invalid one without throwing', () => {
    const regions = extractProtectedRegions('Part PN12345 ships.\n', {
      ...defaultProtectedRegionOptions,
      extraPatterns: ['PN\\d+', '([unclosed'],
    });
    expect(regions.some((r) => r.kind === 'identifier')).toBe(true);
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

  it('does not protect prose that merely sits next to protected content', () => {
    const text = 'Utilise `foo` and utilise /etc/bar too.\n';
    const doc = analyse(text);
    const first = text.indexOf('Utilise');
    const second = text.indexOf('utilise', first + 1);
    expect(doc.isProtected({ start: first, end: first + 7 })).toBe(false);
    expect(doc.isProtected({ start: second, end: second + 7 })).toBe(false);
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
