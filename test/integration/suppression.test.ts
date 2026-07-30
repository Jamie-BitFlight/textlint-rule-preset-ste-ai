import { afterEach, describe, expect, it } from 'vitest';
import { analyseText, analyseTextDeterministic } from '../../src/analysis/analyse.js';
import {
  ScriptedTransport,
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

const admonitionDoc = (kind: 'WARNING' | 'NOTE'): string =>
  [
    `> [!${kind}]`,
    '> <!-- ste-ai-ignore-next-line passive-voice-candidate -- Quoted verbatim. -->',
    '> The bracket is removed by the technician.',
    '',
  ].join('\n');

const CANDIDATE_RULE = 'passive-voice-candidate';

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

describe('overlapping fixes are resolved after suppression', () => {
  const CONFLICT = 'Utilise utilise the bracket.';
  const SUPPRESSED = [
    '<!-- ste-ai-ignore-next-line no-repeated-words -- Repetition quoted verbatim. -->',
    CONFLICT,
    '',
  ].join('\n');

  it('leaves a surviving diagnostic its fix when the conflicting one was withheld', () => {
    const result = analyseTextDeterministic(SUPPRESSED);

    expect(result.suppressions.map((s) => s.ruleId)).toEqual(['no-repeated-words']);
    expect(result.diagnostics.map((d) => d.ruleId)).toEqual([
      'unapproved-vocabulary',
      'unapproved-vocabulary',
    ]);
    // A withheld finding is not a party to a fix conflict. Before this the survivor was left
    // permanently unfixable by a diagnostic that is not in the output.
    expect(result.diagnostics.filter((d) => d.fix === undefined)).toEqual([]);
    expect(result.notices.map((n) => n.code)).not.toContain('overlapping-fixes-refused');
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.message).not.toContain('No automatic fix');
    }
  });

  it('still refuses both fixes when the conflict is real', () => {
    const result = analyseTextDeterministic(`${CONFLICT}\n`);

    const refused = result.notices.find((n) => n.code === 'overlapping-fixes-refused');
    expect(refused?.detail?.['count']).toBe(2);
    expect(result.diagnostics.find((d) => d.ruleId === 'no-repeated-words')?.fix).toBeUndefined();
    expect(result.diagnostics.filter((d) => d.fix === undefined)).toHaveLength(2);
  });

  it('resolves a genuine conflict through the semantic entry point', async () => {
    service = await startFakeSemanticService({
      handler: () => ({
        content: verdictJson({
          ruleId: CANDIDATE_RULE,
          status: 'compliant',
          confidence: 0.9,
          explanation: 'ok',
          suggestedReplacements: [],
        }),
      }),
    });

    const result = await analyseText(`${CONFLICT} The cover is opened by the operator.\n`, {
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

    // Positive control: semantic diagnostics really were merged in before resolution ran.
    expect(service.requestCount()).toBe(1);
    const refused = result.notices.find((n) => n.code === 'overlapping-fixes-refused');
    expect(refused?.detail?.['count']).toBe(2);
    expect(result.diagnostics.find((d) => d.ruleId === 'no-repeated-words')?.fix).toBeUndefined();
  });
});

describe('a claim on a candidate inside a safety admonition', () => {
  it('is refused, and the candidate survives to be adjudicated', () => {
    const text = admonitionDoc('WARNING');
    const result = analyseTextDeterministic(text);

    expect(result.candidates.map((c) => c.ruleId)).toEqual([CANDIDATE_RULE]);
    expect(result.suppressions.filter((s) => s.ruleId === CANDIDATE_RULE)).toEqual([]);

    const refusal = result.notices.find((n) => n.code === 'suppression-refused-in-admonition');
    expect(refusal?.level).toBe('warning');
    expect(refusal?.detail).toEqual({ ruleId: CANDIDATE_RULE, admonition: 'warning' });

    // Filtering a candidate is the stronger silencing of the two, so the refusal must not leave the
    // passage unreported either: it still becomes a review-required diagnostic.
    expect(result.diagnostics.map((d) => d.ruleId)).toContain(CANDIDATE_RULE);
  });

  it('is honoured once the operator allows it', () => {
    const result = analyseTextDeterministic(admonitionDoc('WARNING'), {
      config: { suppressions: { allowInAdmonitions: true } },
    });

    expect(result.candidates).toEqual([]);
    expect(result.suppressions.map((s) => s.ruleId)).toEqual([CANDIDATE_RULE]);
    expect(result.notices.map((n) => n.code)).not.toContain('suppression-refused-in-admonition');
  });

  it('is honoured without the flag inside a note, which is not a safety register', () => {
    const result = analyseTextDeterministic(admonitionDoc('NOTE'));

    expect(result.candidates).toEqual([]);
    expect(result.suppressions.map((s) => s.ruleId)).toEqual([CANDIDATE_RULE]);
    expect(result.notices.map((n) => n.code)).not.toContain('suppression-refused-in-admonition');
  });
});

describe('a refused candidate reports its refusal exactly once', () => {
  const RANGE_OVER_ALERT = [
    '<!-- ste-ai-ignore-start passive-voice-candidate -- reviewed, keep as written -->',
    '',
    '> [!WARNING]',
    '> The cover is opened by the operator.',
    '',
    '<!-- ste-ai-ignore-end -->',
    '',
  ].join('\n');

  it('emits one notice through the deterministic entry point', () => {
    const result = analyseTextDeterministic(RANGE_OVER_ALERT);

    const refusals = result.notices.filter((n) => n.code === 'suppression-refused-in-admonition');
    expect(refusals).toHaveLength(1);
    // The finding is kept, not discarded — a refused claim is not a silent one.
    expect(result.diagnostics.map((d) => d.ruleId)).toContain(CANDIDATE_RULE);
  });

  it('emits one notice through the semantic entry point', async () => {
    service = await startFakeSemanticService({
      handler: () => ({
        content: verdictJson({
          ruleId: CANDIDATE_RULE,
          status: 'uncertain',
          confidence: 0.5,
          explanation: 'inconclusive',
          suggestedReplacements: [],
        }),
      }),
    });

    const result = await analyseText(RANGE_OVER_ALERT, {
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

    // Positive control: the refused candidate really did reach adjudication.
    expect(service.requestCount()).toBe(1);
    const refusals = result.notices.filter((n) => n.code === 'suppression-refused-in-admonition');
    expect(refusals).toHaveLength(1);
    expect(result.diagnostics.map((d) => d.ruleId)).toContain(CANDIDATE_RULE);
  });

  it('emits one notice even when the model reports an evidence span narrower than the candidate range', async () => {
    // A `[WARNING]` block label rather than a GFM alert, so the claimed sentence carries no
    // masked blockquote marker of its own — its offsets within the passage are exactly its
    // offsets within the plain sentence text, which keeps this test's arithmetic legible.
    const SENTENCE = 'The cover is opened by the operator.';
    const text = [
      '<!-- ste-ai-ignore-next-line passive-voice-candidate -- Quoted verbatim. -->',
      '',
      '[WARNING]',
      SENTENCE,
      '',
    ].join('\n');

    // The candidate's own span is "is opened by" (auxiliary, participle, agent marker). The model
    // is scripted to report evidence over "opened" alone instead — a real, valid, narrower span
    // that is nonetheless not identical to `candidate.range`, exactly as `resolveEvidenceRange`
    // permits.
    const evidenceStart = SENTENCE.indexOf('opened');
    const evidenceEnd = evidenceStart + 'opened'.length;
    expect(SENTENCE.indexOf('is opened by')).not.toBe(evidenceStart);

    const transport = new ScriptedTransport([
      {
        content: verdictJson({
          ruleId: CANDIDATE_RULE,
          status: 'violation',
          confidence: 0.9,
          evidenceStart,
          evidenceEnd,
          explanation: 'passive voice',
          suggestedReplacements: [],
        }),
      },
    ]);

    const result = await analyseText(text, {
      transport,
      config: {
        semantic: { enabled: true, model: 'fake', cache: false, maxRepairAttempts: 0 },
      },
    });

    const diagnostic = result.diagnostics.find((d) => d.ruleId === CANDIDATE_RULE);
    // Positive control: the remapped range really did diverge from the candidate's own span, which
    // is the exact condition this test is for.
    expect(diagnostic?.range.start).toBe(text.indexOf(SENTENCE) + evidenceStart);
    expect(diagnostic?.range.start).not.toBe(text.indexOf('is opened by'));

    const refusals = result.notices.filter((n) => n.code === 'suppression-refused-in-admonition');
    expect(refusals).toHaveLength(1);
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
    expect(record?.message).toBe('Auxiliary plus a word wink-nlp tags as a verb.');
    expect(record?.reason).toBe('Quoted verbatim from the supplier.');
    expect(result.notices.map((n) => n.code)).not.toContain('suppression-unused');
  });

  it('never dispatches the directive comment itself in a plain-text document', async () => {
    const text = [
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- The bracket is removed by the technician. -->',
      'Utilise the cover.',
      '',
      'The filter is opened by the operator.',
      '',
    ].join('\n');
    const bodies: string[] = [];
    service = await startFakeSemanticService({
      handler: (body) => {
        bodies.push(JSON.stringify(body));
        return {
          content: verdictJson({
            ruleId: CANDIDATE_RULE,
            status: 'compliant',
            confidence: 0.9,
            explanation: 'ok',
            suggestedReplacements: [],
          }),
        };
      },
    });

    const result = await analyseText(text, {
      format: 'text',
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

    // Positive control: the genuine passage is still adjudicated.
    expect(service.requestCount()).toBe(1);
    const sent = bodies.join('\n');
    expect(sent).toContain('The filter is opened by the operator');

    // The reason a person wrote to explain a suppression is not prose for a reader, and it must
    // not leave the process to be judged as though it were.
    expect(sent).not.toContain('The bracket is removed by the technician');
    expect(sent).not.toContain('ste-ai-ignore-next-line');

    // The withheld candidate is still on the record, with the reason the diagnostic path uses.
    const record = result.suppressions.find((s) => s.ruleId === CANDIDATE_RULE);
    expect(record?.reason).toBe('directive text is not prose');
    expect(record?.category).toBe('review-required');
    expect(record?.message).toBe('Auxiliary plus a word wink-nlp tags as a verb.');
  });

  it('redacts a directive comment from a surviving candidate that merely shares its sentence', async () => {
    // No blank line between the comment and the prose, so sentence-splitter does not treat the
    // directive as its own sentence: the candidate for "is opened by" is anchored in the prose,
    // outside the comment's own span, and is NOT claimed — the directive names a different rule
    // entirely. It survives to be dispatched. Its `passage`, built from the whole sentence, would
    // carry the comment's raw text without the redaction this test is for.
    const text =
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- vendor spelling fixed by contract -->' +
      ' The cover is opened by the operator.\n';
    const bodies: string[] = [];
    service = await startFakeSemanticService({
      handler: (body) => {
        bodies.push(JSON.stringify(body));
        return {
          content: verdictJson({
            ruleId: CANDIDATE_RULE,
            status: 'compliant',
            confidence: 0.9,
            explanation: 'ok',
            suggestedReplacements: [],
          }),
        };
      },
    });

    await analyseText(text, {
      format: 'text',
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

    // Positive control: the candidate this test is about really was dispatched.
    expect(service.requestCount()).toBe(1);
    const sent = bodies.join('\n');
    expect(sent).toContain('is opened by the operator');

    // The leak this test guards against: an unrelated directive's syntax, rule id and reason must
    // not travel to the model just because it shares a sentence with a genuine candidate.
    expect(sent).not.toContain('ste-ai-ignore-next-line');
    expect(sent).not.toContain('unapproved-vocabulary');
    expect(sent).not.toContain('vendor spelling fixed by contract');
  });

  it('dispatches a candidate whose claim was refused inside a safety admonition', async () => {
    const bodies: string[] = [];
    service = await startFakeSemanticService({
      handler: (body) => {
        bodies.push(JSON.stringify(body));
        return {
          content: verdictJson({
            ruleId: CANDIDATE_RULE,
            status: 'compliant',
            confidence: 0.9,
            explanation: 'ok',
            suggestedReplacements: [],
          }),
        };
      },
    });

    await analyseText(admonitionDoc('WARNING'), {
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

    // The refusal has to reach the wire. A refused claim that still kept the passage out of the
    // model would be the refusal in name only.
    expect(service.requestCount()).toBe(1);
    expect(bodies.join('\n')).toContain('The bracket is removed by the technician');
  });
});
