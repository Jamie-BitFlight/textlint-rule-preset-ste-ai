import { afterEach, describe, expect, it } from 'vitest';
import { analyseText, analyseTextDeterministic } from '../../src/analysis/analyse.js';
import {
  startFakeSemanticService,
  verdictJson,
  type FakeService,
} from '../helpers/fake-semantic-service.js';

/**
 * Inline suppression through the real pipeline.
 *
 * The unit tests prove the scanner and the applier in isolation. What is proved here is the wiring:
 * that a directive written in a real document reaches real rule output, that turning the feature off
 * restores the finding, and — the case a unit test cannot reach — that a suppressed candidate never
 * becomes an HTTP request. A suppression that withheld the diagnostic but still shipped the passage
 * to a model would satisfy every assertion in the unit suite and still leak the text.
 */

let service: FakeService | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
});

const MARKDOWN_DOC = [
  '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling fixed by contract. -->',
  'Utilise the bracket.',
  '',
  'Utilise the filter.',
  '',
].join('\n');

const TEXT_DOC = [
  '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Utilise is the vendor spelling. -->',
  'Utilise the bracket.',
  '',
].join('\n');

const CANDIDATE_DOC = [
  '<!-- ste-ai-ignore-next-line passive-voice-candidate -- Quoted verbatim from the supplier. -->',
  'The bracket is removed by the technician.',
  '',
  'The cover is opened by the operator.',
  '',
].join('\n');

/** Only the vocabulary findings: the fixtures also raise candidates the assertions do not concern. */
function vocabulary(findings: readonly { readonly ruleId: string }[]): string[] {
  return findings.filter((d) => d.ruleId === 'unapproved-vocabulary').map((d) => d.ruleId);
}

describe('inline suppression in a deterministic run', () => {
  it('withholds the claimed diagnostic and records it', () => {
    const result = analyseTextDeterministic(MARKDOWN_DOC);

    // Positive control: the unclaimed occurrence on the later line is still reported.
    expect(vocabulary(result.diagnostics)).toEqual(['unapproved-vocabulary']);
    expect(result.diagnostics[0]?.range.start).toBe(MARKDOWN_DOC.indexOf('Utilise the filter'));

    expect(result.suppressions).toHaveLength(1);
    const record = result.suppressions[0];
    expect(record?.ruleId).toBe('unapproved-vocabulary');
    expect(record?.range.start).toBe(MARKDOWN_DOC.indexOf('Utilise the bracket'));
    expect(record?.reason).toBe('Vendor spelling fixed by contract.');
    expect(record?.message).toContain('Utilise');

    const applied = result.notices.find((n) => n.code === 'suppressions-applied');
    expect(applied?.level).toBe('info');
    expect(applied?.detail?.['count']).toBe(1);
  });

  it('makes every directive inert when suppressions are disabled', () => {
    const result = analyseTextDeterministic(MARKDOWN_DOC, {
      config: { suppressions: { enabled: false } },
    });

    expect(vocabulary(result.diagnostics)).toEqual([
      'unapproved-vocabulary',
      'unapproved-vocabulary',
    ]);
    expect(result.suppressions).toEqual([]);
    expect(result.notices.filter((n) => n.code.startsWith('suppression'))).toEqual([]);
  });

  it('honours a directive in a plain-text document and reports nothing on the directive line', () => {
    const result = analyseTextDeterministic(TEXT_DOC, { format: 'text' });

    // In `format: 'text'` the comment is ordinary prose, so "Utilise" inside the directive is a
    // vocabulary violation until the applier withholds it as directive text.
    expect(vocabulary(result.diagnostics)).toEqual([]);
    expect(
      result.suppressions.filter((s) => s.ruleId === 'unapproved-vocabulary').map((s) => s.reason),
    ).toEqual(['directive text is not prose', 'Utilise is the vendor spelling.']);

    // Nothing at all is reported on the directive line, whichever rule looked at it.
    const onDirectiveLine = result.diagnostics.filter(
      (d) => result.document.positionAt(d.range.start).line === 1,
    );
    expect(onDirectiveLine).toEqual([]);
  });
});

describe('a suppressed candidate is never sent to the model', () => {
  it('dispatches the unclaimed passage and not the claimed one', async () => {
    const bodies: string[] = [];
    service = await startFakeSemanticService({
      handler: (body) => {
        bodies.push(JSON.stringify(body));
        return {
          content: verdictJson({
            ruleId: 'passive-voice-candidate',
            status: 'compliant',
            confidence: 0.9,
            explanation: 'ok',
            suggestedReplacements: [],
          }),
        };
      },
    });

    const result = await analyseText(CANDIDATE_DOC, {
      config: {
        semantic: {
          enabled: true,
          endpoint: service.url,
          model: 'fake',
          cache: false,
          maxRepairAttempts: 0,
        },
      },
    });

    // Positive control: the run really did contact the service, so the negative below is meaningful.
    expect(service.requestCount()).toBe(1);
    const sent = bodies.join('\n');
    expect(sent).toContain('The cover is opened by the operator');
    expect(sent).not.toContain('The bracket is removed by the technician');

    expect(result.candidates.map((c) => c.range.start)).toEqual([
      CANDIDATE_DOC.indexOf('is opened by'),
    ]);
    const record = result.suppressions.find((s) => s.ruleId === 'passive-voice-candidate');
    expect(record?.category).toBe('review-required');
    expect(record?.message).toBe('Auxiliary plus past participle.');
    expect(record?.reason).toBe('Quoted verbatim from the supplier.');
    expect(result.notices.map((n) => n.code)).not.toContain('suppression-unused');
  });
});
