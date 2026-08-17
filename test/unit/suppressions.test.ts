import { describe, expect, it } from 'vite-plus/test';
import { analyseDocument } from '../../src/core/document.js';
import { applySuppressions, directiveFor, scanSuppressions } from '../../src/core/suppressions.js';
import type {
  Diagnostic,
  DocumentFormat,
  RunNotice,
  SuppressionDirective,
  SuppressionRecord,
} from '../../src/core/types.js';

const KNOWN_RULE_IDS = ['unapproved-vocabulary', 'sentence-length-procedural'];

function diagnosticFor(
  text: string,
  quote: string,
  ruleId = 'unapproved-vocabulary',
  endQuote?: string,
): Diagnostic {
  const start = text.indexOf(quote);
  expect(start, `fixture does not contain "${quote}"`).toBeGreaterThanOrEqual(0);
  const end =
    endQuote === undefined ? start + quote.length : text.indexOf(endQuote) + endQuote.length;
  return {
    ruleId,
    ruleStatus: 'provisional',
    category: 'deterministic-violation',
    severity: 'error',
    message: `"${quote}" is not an approved term.`,
    range: { start, end },
    producedBy: 'deterministic',
  };
}

interface RunOptions {
  readonly format?: DocumentFormat;
  readonly allowInAdmonitions?: boolean;
  readonly knownRuleIds?: readonly string[];
}

interface RunResult {
  readonly directives: readonly SuppressionDirective[];
  readonly diagnostics: readonly Diagnostic[];
  readonly suppressions: readonly SuppressionRecord[];
  readonly notices: readonly RunNotice[];
  readonly codes: readonly string[];
}

function run(
  text: string,
  diagnostics: readonly Diagnostic[],
  options: RunOptions = {},
): RunResult {
  const doc = analyseDocument({ id: 't', format: options.format ?? 'markdown', text });
  const scan = scanSuppressions(doc);
  const applied = applySuppressions({
    doc,
    diagnostics,
    directives: scan.directives,
    allowInAdmonitions: options.allowInAdmonitions ?? false,
    knownRuleIds: options.knownRuleIds ?? KNOWN_RULE_IDS,
  });
  const notices = [...scan.notices, ...applied.notices];
  return {
    directives: scan.directives,
    diagnostics: applied.diagnostics,
    suppressions: applied.suppressions,
    notices,
    codes: notices.map((notice) => notice.code),
  };
}

function noticeWith(result: RunResult, code: string): RunNotice | undefined {
  return result.notices.find((notice) => notice.code === code);
}

const NEXT_LINE = [
  '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling fixed by contract. -->',
  'Utilise the bracket.',
  '',
  'Utilise the filter.',
  '',
].join('\n');

/** The same sentence, written as one long line and as three soft-wrapped ones. */
const UNWRAPPED =
  'The technician must inspect the assembly and then utilise the bracket to hold the sensor.';
const WRAPPED = [
  'The technician must inspect the assembly and then',
  'utilise the bracket to hold',
  'the sensor.',
].join('\n');

const SCOPED = [
  '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling fixed by contract. -->',
  'Utilise the bracket assembly to hold the sensor in position.',
  '',
].join('\n');

const UNSCOPED = [
  '<!-- ste-ai-ignore-next-line -- Vendor spelling fixed by contract. -->',
  'Utilise the bracket assembly to hold the sensor in position.',
  '',
].join('\n');

const RANGE = [
  'Utilise the tool before the block.',
  '<!-- ste-ai-ignore-start -- Legacy chapter frozen for the 2026 revision. -->',
  'Utilise the bracket.',
  'Utilise the filter.',
  '<!-- ste-ai-ignore-end -->',
  'Utilise the cover.',
  '',
].join('\n');

const WARNING_DOC = [
  'WARNING: Do not touch the live conductor.',
  '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling fixed by contract. -->',
  'Utilise the bracket.',
  '',
].join('\n');

const NOTE_DOC = [
  '> [!NOTE]',
  '> Background information follows.',
  '> <!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling by contract. -->',
  '> Utilise the bracket.',
  '',
].join('\n');

const SAMPLES = [
  '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Live directive. -->',
  'Utilise the bracket.',
  '',
  '```markdown',
  '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Fenced sample. -->',
  'Utilise the fenced example.',
  '```',
  '',
  'Write `<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Inline sample. -->` in the file.',
  '',
  'Indented sample:',
  '',
  '    <!-- ste-ai-ignore-next-line unapproved-vocabulary -- Indented sample. -->',
  '',
].join('\n');

const QUOTED_STACK = [
  '> [!NOTE]',
  "> <!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor's API verb. -->",
  '> <!-- ste-ai-ignore-next-line sentence-length-procedural -- Quoted verbatim. -->',
  '> Terminate the session before you remove the module.',
  '',
].join('\n');

describe('scanSuppressions', () => {
  it('parses a next-line directive with its rule ids and reason', () => {
    const doc = analyseDocument({ id: 't', format: 'markdown', text: NEXT_LINE });
    const { directives, notices } = scanSuppressions(doc);
    expect(notices).toEqual([]);
    expect(directives).toHaveLength(1);
    const directive = directives[0];
    expect(directive?.kind).toBe('next-line');
    expect(directive?.ruleIds).toEqual(['unapproved-vocabulary']);
    expect(directive?.reason).toBe('Vendor spelling fixed by contract.');
    expect(directive?.directiveRange).toEqual({
      start: 0,
      end: NEXT_LINE.indexOf('-->') + 3,
    });
    // The span runs from the end of the directive to the end of the block beneath it.
    expect(directive?.range).toEqual({
      start: NEXT_LINE.indexOf('-->') + 3,
      end: NEXT_LINE.indexOf('Utilise the bracket.') + 'Utilise the bracket.'.length,
    });
  });

  it('returns directives in source order', () => {
    const doc = analyseDocument({ id: 't', format: 'markdown', text: RANGE });
    const { directives } = scanSuppressions(doc);
    expect(directives.map((d) => d.kind)).toEqual(['range']);
    expect(directives[0]?.range).toEqual({
      start: RANGE.indexOf('-->') + 3,
      end: RANGE.indexOf('<!-- ste-ai-ignore-end'),
    });
  });

  it('ignores a directive that a markdown document only shows as a sample', () => {
    const doc = analyseDocument({ id: 't', format: 'markdown', text: SAMPLES });
    const { directives } = scanSuppressions(doc);
    // Documentation about this feature has to be able to quote it. A fenced, inline-code or
    // indented sample is a picture of a directive, not one.
    expect(directives.map((d) => d.reason)).toEqual(['Live directive.']);
  });

  it('reads every comment in a plain-text document, which has no code regions', () => {
    const doc = analyseDocument({ id: 't', format: 'text', text: SAMPLES });
    const { directives } = scanSuppressions(doc);
    expect(directives.map((d) => d.reason)).toEqual([
      'Live directive.',
      'Fenced sample.',
      'Inline sample.',
      'Indented sample.',
    ]);
  });

  it('reports a comment that starts with the keyword but parses as no known form', () => {
    const text =
      '<!-- ste-ai-ignore-everything -- Reason recorded for the audit. -->\nUtilise it.\n';
    const doc = analyseDocument({ id: 't', format: 'markdown', text });
    const { directives, notices } = scanSuppressions(doc);
    expect(directives).toEqual([]);
    expect(notices.map((n) => n.code)).toEqual(['suppression-malformed']);
    expect(notices[0]?.detail?.['line']).toBe(1);
  });
});

describe('directiveFor', () => {
  it('returns the claiming directive for an offset inside its span and nothing outside', () => {
    const doc = analyseDocument({ id: 't', format: 'markdown', text: RANGE });
    const { directives } = scanSuppressions(doc);
    const inside = RANGE.indexOf('Utilise the bracket.');
    const outside = RANGE.indexOf('Utilise the cover.');
    expect(directiveFor(directives, 'unapproved-vocabulary', inside)).toBe(directives[0]);
    expect(directiveFor(directives, 'unapproved-vocabulary', outside)).toBeUndefined();
  });
});

describe('applySuppressions', () => {
  it('claims the same findings whether the paragraph is soft-wrapped or not', () => {
    // The property that motivates claiming a block rather than a line. Rewrapping a paragraph is
    // not an edit to its wording, so it must not change what a suppression covers — under
    // line-claiming, moving the offending word to the second line silently revoked the suppression.
    for (const [shape, prose] of [
      ['unwrapped', UNWRAPPED],
      ['wrapped', WRAPPED],
    ] as const) {
      const text = [
        '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling by contract. -->',
        prose,
        '',
      ].join('\n');
      const result = run(text, [diagnosticFor(text, 'utilise')]);
      expect(result.diagnostics, shape).toEqual([]);
      expect(
        result.suppressions.map((s) => s.reason),
        shape,
      ).toEqual(['Vendor spelling by contract.']);
      expect(result.codes, shape).not.toContain('suppression-unused');
    }
  });

  it('claims every sentence of the block it names, and not the block after it', () => {
    const text = [
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling by contract. -->',
      'Utilise the bracket. Utilise the filter to remove the particles.',
      '',
      'Utilise the cover.',
      '',
    ].join('\n');
    const result = run(text, [
      diagnosticFor(text, 'Utilise the bracket'),
      diagnosticFor(text, 'Utilise the filter'),
      diagnosticFor(text, 'Utilise the cover'),
    ]);
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      '"Utilise the cover" is not an approved term.',
    ]);
    expect(result.suppressions).toHaveLength(2);
  });

  it('claims nothing when unclaimable content lies between it and the next block', () => {
    // An indented sample is entirely protected, so it produces no block of its own. Stepping over
    // it silently would withhold a finding in a paragraph the author never pointed at.
    const text = [
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling by contract. -->',
      '',
      '    <!-- ste-ai-ignore-next-line unapproved-vocabulary -- Sample only. -->',
      '',
      'Utilise the bracket.',
      '',
    ].join('\n');
    const result = run(text, [diagnosticFor(text, 'Utilise the bracket')]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.suppressions).toEqual([]);
    expect(result.codes).toContain('suppression-unused');
  });

  it('claims nothing across a fenced code block', () => {
    const text = [
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling by contract. -->',
      '',
      '```sh',
      'utilise --now',
      '```',
      '',
      'Utilise the bracket.',
      '',
    ].join('\n');
    const result = run(text, [diagnosticFor(text, 'Utilise the bracket')]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.suppressions).toEqual([]);
    expect(result.codes).toContain('suppression-unused');
  });

  it('still claims the first item of the list beneath it', () => {
    // A list bullet is markup introducing the claimed block, not content standing between.
    const text = [
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling by contract. -->',
      '',
      '1. Utilise the bracket.',
      '2. Utilise the filter.',
      '',
    ].join('\n');
    const result = run(text, [
      diagnosticFor(text, 'Utilise the bracket'),
      diagnosticFor(text, 'Utilise the filter'),
    ]);
    expect(result.suppressions.map((s) => s.message)).toEqual([
      '"Utilise the bracket" is not an approved term.',
    ]);
    expect(result.diagnostics).toHaveLength(1);
  });

  it('still claims the heading beneath it', () => {
    const text = [
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling by contract. -->',
      '',
      '# Utilise the bracket',
      '',
    ].join('\n');
    const result = run(text, [diagnosticFor(text, 'Utilise the bracket')]);
    expect(result.diagnostics).toEqual([]);
    expect(result.suppressions).toHaveLength(1);
  });

  it('does not treat a directive comment line as the block it claims in a text document', () => {
    // In `format: 'text'` the comment is not masked, so the directive line is a block of its own.
    const text = [
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling by contract. -->',
      '',
      'Utilise the bracket.',
      '',
    ].join('\n');
    const result = run(text, [diagnosticFor(text, 'Utilise the bracket')], { format: 'text' });
    expect(result.diagnostics).toEqual([]);
    expect(result.suppressions.map((s) => s.reason)).toEqual(['Vendor spelling by contract.']);
  });

  it('claims the block below it and not the one after that', () => {
    const result = run(NEXT_LINE, [
      diagnosticFor(NEXT_LINE, 'Utilise the bracket'),
      diagnosticFor(NEXT_LINE, 'Utilise the filter'),
    ]);
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      '"Utilise the filter" is not an approved term.',
    ]);
    expect(result.suppressions.map((s) => s.message)).toEqual([
      '"Utilise the bracket" is not an approved term.',
    ]);
  });

  it('claims only the named rule when the directive is rule-scoped', () => {
    const result = run(SCOPED, [
      diagnosticFor(SCOPED, 'Utilise'),
      diagnosticFor(
        SCOPED,
        'Utilise the bracket assembly to hold the sensor in position.',
        'sentence-length-procedural',
      ),
    ]);
    expect(result.diagnostics.map((d) => d.ruleId)).toEqual(['sentence-length-procedural']);
    expect(result.suppressions.map((s) => s.ruleId)).toEqual(['unapproved-vocabulary']);
  });

  it('claims every rule on the line when the directive names none', () => {
    const result = run(UNSCOPED, [
      diagnosticFor(UNSCOPED, 'Utilise'),
      diagnosticFor(
        UNSCOPED,
        'Utilise the bracket assembly to hold the sensor in position.',
        'sentence-length-procedural',
      ),
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.suppressions.map((s) => s.ruleId)).toEqual([
      'unapproved-vocabulary',
      'sentence-length-procedural',
    ]);
  });

  it('claims everything between start and end and nothing outside', () => {
    const result = run(RANGE, [
      diagnosticFor(RANGE, 'Utilise the tool'),
      diagnosticFor(RANGE, 'Utilise the bracket'),
      diagnosticFor(RANGE, 'Utilise the filter'),
      diagnosticFor(RANGE, 'Utilise the cover'),
    ]);
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      '"Utilise the tool" is not an approved term.',
      '"Utilise the cover" is not an approved term.',
    ]);
    expect(result.suppressions.map((s) => s.message)).toEqual([
      '"Utilise the bracket" is not an approved term.',
      '"Utilise the filter" is not an approved term.',
    ]);
  });

  it('leaves a directive with no reason inert and reports it', () => {
    const text = ['<!-- ste-ai-ignore-next-line unapproved-vocabulary -->', 'Utilise it.', ''].join(
      '\n',
    );
    const result = run(text, [diagnosticFor(text, 'Utilise it')]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.suppressions).toEqual([]);
    expect(result.codes).toContain('suppression-reason-missing');
    expect(noticeWith(result, 'suppression-reason-missing')?.detail?.['line']).toBe(1);
  });

  it('reports an unknown rule id and claims nothing for it', () => {
    const text = [
      '<!-- ste-ai-ignore-next-line no-such-rule -- Reason recorded for the audit. -->',
      'Utilise it.',
      '',
    ].join('\n');
    const result = run(text, [diagnosticFor(text, 'Utilise it')]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.suppressions).toEqual([]);
    expect(result.codes).toContain('suppression-unknown-rule');
    expect(noticeWith(result, 'suppression-unknown-rule')?.detail?.['ruleId']).toBe('no-such-rule');
  });

  it('reports a stray ignore-end', () => {
    const text = ['Utilise it.', '<!-- ste-ai-ignore-end -->', ''].join('\n');
    const result = run(text, [diagnosticFor(text, 'Utilise it')]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.codes).toContain('suppression-end-without-start');
    expect(noticeWith(result, 'suppression-end-without-start')?.detail?.['line']).toBe(2);
  });

  it('runs an unterminated ignore-start to the end of the document and reports it', () => {
    const text = [
      '<!-- ste-ai-ignore-start -- Legacy chapter frozen for the 2026 revision. -->',
      'Utilise the bracket.',
      'Utilise the filter.',
      '',
    ].join('\n');
    const result = run(text, [
      diagnosticFor(text, 'Utilise the bracket'),
      diagnosticFor(text, 'Utilise the filter'),
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.suppressions).toHaveLength(2);
    expect(result.codes).toContain('suppression-unclosed-range');
    expect(noticeWith(result, 'suppression-unclosed-range')?.detail?.['line']).toBe(1);
  });

  it('reports a directive that claims nothing', () => {
    const text = [
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Reason recorded for the audit. -->',
      'The cover is in place.',
      '',
      'Utilise the bracket.',
      '',
    ].join('\n');
    const result = run(text, [diagnosticFor(text, 'Utilise the bracket')]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.suppressions).toEqual([]);
    expect(result.codes).toContain('suppression-unused');
    expect(noticeWith(result, 'suppression-unused')?.detail?.['line']).toBe(1);
  });

  it('treats a directive named in alreadyClaimed as used', () => {
    const text = [
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Reason recorded for the audit. -->',
      'Utilise the bracket.',
      '',
    ].join('\n');
    const doc = analyseDocument({ id: 't', format: 'markdown', text });
    const { directives } = scanSuppressions(doc);
    const input = {
      doc,
      diagnostics: [] as readonly Diagnostic[],
      directives,
      allowInAdmonitions: false,
      knownRuleIds: KNOWN_RULE_IDS,
    };

    // Positive control: with nothing claimed the directive really is dead.
    expect(applySuppressions(input).notices.map((n) => n.code)).toEqual(['suppression-unused']);

    // The caller filtered a candidate against this directive before the diagnostics were built, so
    // the applier never sees the claim and would otherwise call a live directive dead.
    const claimed = applySuppressions({ ...input, alreadyClaimed: directives });
    expect(claimed.notices.map((n) => n.code)).toEqual([]);
  });

  it('refuses a claim inside a warning admonition and keeps the diagnostic', () => {
    const result = run(WARNING_DOC, [diagnosticFor(WARNING_DOC, 'Utilise the bracket')]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.suppressions).toEqual([]);
    const notice = noticeWith(result, 'suppression-refused-in-admonition');
    expect(notice?.level).toBe('warning');
    expect(notice?.detail).toEqual({ ruleId: 'unapproved-vocabulary', admonition: 'warning' });
  });

  it('honours a claim inside a warning admonition when the operator allows it', () => {
    const result = run(WARNING_DOC, [diagnosticFor(WARNING_DOC, 'Utilise the bracket')], {
      allowInAdmonitions: true,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.suppressions).toHaveLength(1);
    expect(result.codes).not.toContain('suppression-refused-in-admonition');
  });

  it('honours a claim inside a note admonition without the flag', () => {
    const result = run(NOTE_DOC, [diagnosticFor(NOTE_DOC, 'Utilise the bracket')]);
    expect(result.diagnostics).toEqual([]);
    expect(result.suppressions).toHaveLength(1);
    expect(result.codes).not.toContain('suppression-refused-in-admonition');
  });

  it('records every withheld finding with its reason and directive span', () => {
    const result = run(NEXT_LINE, [diagnosticFor(NEXT_LINE, 'Utilise the bracket')]);
    expect(result.suppressions).toEqual([
      {
        ruleId: 'unapproved-vocabulary',
        category: 'deterministic-violation',
        range: {
          start: NEXT_LINE.indexOf('Utilise the bracket'),
          end: NEXT_LINE.indexOf('Utilise the bracket') + 'Utilise the bracket'.length,
        },
        message: '"Utilise the bracket" is not an approved term.',
        reason: 'Vendor spelling fixed by contract.',
        directiveRange: { start: 0, end: NEXT_LINE.indexOf('-->') + 3 },
      },
    ]);
  });

  it('reports how many findings were withheld', () => {
    const result = run(RANGE, [
      diagnosticFor(RANGE, 'Utilise the tool'),
      diagnosticFor(RANGE, 'Utilise the bracket'),
      diagnosticFor(RANGE, 'Utilise the filter'),
    ]);
    const notice = noticeWith(result, 'suppressions-applied');
    expect(notice?.level).toBe('info');
    expect(notice?.detail).toEqual({ count: 2 });
  });

  it('emits no applied notice when nothing was withheld', () => {
    const text = 'Utilise the bracket.\n';
    const result = run(text, [diagnosticFor(text, 'Utilise the bracket')]);
    expect(result.codes).not.toContain('suppressions-applied');
  });

  it('skips a blank line between the directive and its target prose', () => {
    const text = [
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling by contract. -->',
      '',
      'Utilise the bracket.',
      '',
    ].join('\n');
    const result = run(text, [diagnosticFor(text, 'Utilise the bracket')]);
    expect(result.diagnostics).toEqual([]);
    expect(result.suppressions).toHaveLength(1);
  });

  it('lets stacked directives claim the same prose line for their own rule ids', () => {
    const text = [
      "<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor's API verb. -->",
      '<!-- ste-ai-ignore-next-line sentence-length-procedural -- Quoted verbatim. -->',
      'Terminate the session before you remove the module.',
      '',
    ].join('\n');
    const result = run(text, [
      diagnosticFor(text, 'Terminate'),
      diagnosticFor(
        text,
        'Terminate the session before you remove the module.',
        'sentence-length-procedural',
      ),
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.suppressions.map((s) => s.reason)).toEqual([
      "Vendor's API verb.",
      'Quoted verbatim.',
    ]);
  });

  it('lets stacked directives inside a blockquote each claim the paragraph', () => {
    const result = run(QUOTED_STACK, [
      diagnosticFor(QUOTED_STACK, 'Terminate'),
      diagnosticFor(
        QUOTED_STACK,
        'Terminate the session before you remove the module.',
        'sentence-length-procedural',
      ),
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.suppressions.map((s) => s.reason)).toEqual([
      "Vendor's API verb.",
      'Quoted verbatim.',
    ]);
  });

  it('does not treat a sampled directive comment as directive text', () => {
    const result = run(SAMPLES, [diagnosticFor(SAMPLES, 'Fenced sample')]);
    expect(result.suppressions).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
  });

  it('claims a multi-line diagnostic by the block it starts in', () => {
    const text = [
      '<!-- ste-ai-ignore-next-line sentence-length-procedural -- Step retained verbatim. -->',
      'Utilise the bracket to hold the sensor and then',
      'tighten the screw to the specified torque value.',
      '',
      'Utilise the filter to remove the particles and then',
      'close the cover.',
      '',
    ].join('\n');
    const claimed = diagnosticFor(
      text,
      'Utilise the bracket',
      'sentence-length-procedural',
      'torque value.',
    );
    const notClaimed = diagnosticFor(
      text,
      'Utilise the filter',
      'sentence-length-procedural',
      'close the cover.',
    );
    const result = run(text, [claimed, notClaimed]);
    expect(result.suppressions.map((s) => s.range)).toEqual([claimed.range]);
    expect(result.diagnostics.map((d) => d.range)).toEqual([notClaimed.range]);
  });

  it('withholds findings anchored inside the directive comment itself', () => {
    const text = [
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling by contract. -->',
      'Utilise the bracket.',
      '',
    ].join('\n');
    const result = run(text, [diagnosticFor(text, 'Vendor spelling')], { format: 'text' });
    expect(result.diagnostics).toEqual([]);
    expect(result.suppressions[0]?.reason).toBe('directive text is not prose');
  });

  it('does not duplicate a refusal notice already reported for the diagnostic’s underlying candidate', () => {
    // `candidateId` is set explicitly rather than reused from `diagnostic.range`: identity here is
    // the candidate's own id, precisely because adjudication is free to move a diagnostic's range
    // away from the candidate's — matching by range is the bug this dedup guards against.
    const diagnostic = {
      ...diagnosticFor(WARNING_DOC, 'Utilise the bracket'),
      candidateId: 'cand-1',
    };
    const doc = analyseDocument({ id: 't', format: 'markdown', text: WARNING_DOC });
    const scan = scanSuppressions(doc);
    const applied = applySuppressions({
      doc,
      diagnostics: [diagnostic],
      directives: scan.directives,
      allowInAdmonitions: false,
      knownRuleIds: KNOWN_RULE_IDS,
      alreadyRefused: ['cand-1'],
    });
    // Still kept: only the second, redundant notice is what has to disappear.
    expect(applied.diagnostics).toHaveLength(1);
    expect(applied.notices.map((n) => n.code)).not.toContain('suppression-refused-in-admonition');
  });

  it('does not treat a range match alone as the same candidate when the id differs', () => {
    // Two distinct candidates can legitimately share a range only in contrived cases, but the
    // inverse is the real-world one this guards: the same candidate's diagnostic can carry a
    // *different* range post-adjudication. Either way, identity must come from the id, not the
    // range — so a coincidental range match with no id at all must not suppress the notice.
    const diagnostic = diagnosticFor(WARNING_DOC, 'Utilise the bracket');
    const doc = analyseDocument({ id: 't', format: 'markdown', text: WARNING_DOC });
    const scan = scanSuppressions(doc);
    const applied = applySuppressions({
      doc,
      diagnostics: [diagnostic],
      directives: scan.directives,
      allowInAdmonitions: false,
      knownRuleIds: KNOWN_RULE_IDS,
      alreadyRefused: ['some-other-candidate-id'],
    });
    expect(applied.diagnostics).toHaveLength(1);
    expect(applied.notices.map((n) => n.code)).toContain('suppression-refused-in-admonition');
  });

  it('rejects an ignore-end that carries trailing arguments and leaves the range open', () => {
    const text = [
      '<!-- ste-ai-ignore-start unapproved-vocabulary -- vendor spelling -->',
      '',
      'Utilise the bracket.',
      '',
      '<!-- ste-ai-ignore-end unapproved-vocabulary -->',
      '',
      'Utilise the filter.',
      '',
    ].join('\n');
    const result = run(text, [
      diagnosticFor(text, 'Utilise the bracket'),
      diagnosticFor(text, 'Utilise the filter'),
    ]);
    expect(result.codes).toContain('suppression-malformed');
    expect(result.codes).toContain('suppression-unclosed-range');
    // The safer failure: the malformed comment did not close the range at all, so it is never
    // read as a stray `ignore-end` either.
    expect(result.codes).not.toContain('suppression-end-without-start');
    expect(result.diagnostics).toEqual([]);
    expect(result.suppressions).toHaveLength(2);
  });

  it('claims a note admonition introduced by a GFM alert marker on its own line', () => {
    const text = [
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling by contract. -->',
      '',
      '> [!NOTE]',
      '> Utilise the bracket.',
      '',
    ].join('\n');
    const result = run(text, [diagnosticFor(text, 'Utilise the bracket')]);
    expect(result.diagnostics).toEqual([]);
    expect(result.suppressions).toHaveLength(1);
  });

  it('reaches the refusal for a warning admonition introduced by a GFM alert marker, exactly once', () => {
    const text = [
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling by contract. -->',
      '',
      '> [!WARNING]',
      '> Utilise the bracket.',
      '',
    ].join('\n');
    const result = run(text, [diagnosticFor(text, 'Utilise the bracket')]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.codes.filter((c) => c === 'suppression-refused-in-admonition')).toHaveLength(1);
  });

  it('claims a note admonition introduced by an RST/MyST directive line', () => {
    const text = [
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling by contract. -->',
      '',
      '.. note::',
      '',
      '   Utilise the bracket.',
      '',
    ].join('\n');
    const result = run(text, [diagnosticFor(text, 'Utilise the bracket')]);
    expect(result.diagnostics).toEqual([]);
    expect(result.suppressions).toHaveLength(1);
  });

  it('claims a note admonition introduced by an mkdocs container line', () => {
    const text = [
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling by contract. -->',
      '',
      '!!! note',
      '',
      '   Utilise the bracket.',
      '',
    ].join('\n');
    const result = run(text, [diagnosticFor(text, 'Utilise the bracket')]);
    expect(result.diagnostics).toEqual([]);
    expect(result.suppressions).toHaveLength(1);
  });

  it('claims a warning admonition introduced by an AsciiDoc block label', () => {
    const text = [
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling by contract. -->',
      '',
      '[WARNING]',
      'Utilise the bracket.',
      '',
    ].join('\n');
    const result = run(text, [diagnosticFor(text, 'Utilise the bracket')]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.codes.filter((c) => c === 'suppression-refused-in-admonition')).toHaveLength(1);
  });

  it('still voids the claim across an indented sample even next to an admonition-free block', () => {
    // Regression guard for item 7: the admonition-opener allowance must not reopen the gap to
    // arbitrary skipped content.
    const text = [
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling by contract. -->',
      '',
      '    <!-- ste-ai-ignore-next-line unapproved-vocabulary -- Sample only. -->',
      '',
      'Utilise the bracket.',
      '',
    ].join('\n');
    const result = run(text, [diagnosticFor(text, 'Utilise the bracket')]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.suppressions).toEqual([]);
    expect(result.codes).toContain('suppression-unused');
  });
});
