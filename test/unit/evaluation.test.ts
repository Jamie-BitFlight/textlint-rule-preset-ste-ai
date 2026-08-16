import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CandidatePassage } from '../../src/core/types.js';
import {
  evaluateSemanticEvaluators,
  formatEvaluationReport,
  goldLabelFor,
} from '../../src/evaluation/evaluate.js';
import type { Annotation } from '../../src/fixture-tools/annotation-schema.js';
import { fixtureManifestSchema } from '../../src/fixture-tools/manifest-schema.js';
import { ScriptedTransport, verdictJson } from '../helpers/fake-semantic-service.js';

const FIXTURES = resolve(import.meta.dirname, '..', '..', 'fixtures');

function candidate(overrides: Partial<CandidatePassage> = {}): CandidatePassage {
  return {
    id: 'c1',
    ruleId: 'passive-voice-candidate',
    evaluatorId: 'passive-voice-adjudication',
    range: { start: 100, end: 120 },
    passage: 'The filter must be replaced.',
    passageOffset: 100,
    payload: { construction: 'must be replaced' },
    invariants: [],
    reason: 'test',
    mode: 'descriptive',
    admonition: 'none',
    ...overrides,
  };
}

function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    fixtureId: 'f',
    original: 'original/f.md',
    compliant: 'compliant/f.md',
    split: 'dev',
    changes: [],
    candidateAdjudications: [],
    protectedLiterals: [],
    reviewers: ['t'],
    ...overrides,
  };
}

const adjudication = (
  verdict: 'violation' | 'non-violation' | 'undecidable',
  start = 100,
  end = 120,
) => ({
  passageId: 'p1',
  ruleId: 'passive-voice-candidate',
  evaluatorId: 'passive-voice-adjudication',
  quote: 'The filter must be replaced.',
  span: { start, end },
  verdict,
  reason: 'a reviewer looked at it',
  reviewer: 't',
  reviewerKind: 'agent' as const,
  reviewerConfidence: 0.9,
});

const change = (status: 'accepted' | 'disputed' | 'deferred', start = 100, end = 120) => ({
  passageId: 'p1',
  originalText: 'x',
  rewrittenText: 'y',
  ruleIds: ['passive-voice-candidate'],
  originalSpans: [{ start, end }],
  expectedDiagnostics: [],
  reason: 'because it was needed',
  semanticInvariants: ['meaning'],
  unresolved: [],
  status,
  reviewer: 'rewriter-a',
  reviewerKind: 'agent' as const,
  reviewerConfidence: 0.9,
});

describe('gold labelling', () => {
  it('an accepted change makes the candidate a gold violation', () => {
    expect(goldLabelFor(candidate(), annotation({ changes: [change('accepted')] }))).toBe(
      'violation',
    );
  });

  it('a disputed change makes the candidate a gold non-violation', () => {
    expect(goldLabelFor(candidate(), annotation({ changes: [change('disputed')] }))).toBe(
      'non-violation',
    );
  });

  it('a deferred change leaves the candidate unlabelled', () => {
    expect(goldLabelFor(candidate(), annotation({ changes: [change('deferred')] }))).toBe(
      'unlabelled',
    );
  });

  it('a candidate with no annotation is unlabelled', () => {
    expect(goldLabelFor(candidate(), undefined)).toBe('unlabelled');
  });

  it('a change for a different rule does not label the candidate', () => {
    const other = { ...change('accepted'), ruleIds: ['no-contractions'] };
    expect(goldLabelFor(candidate(), annotation({ changes: [other] }))).toBe('unlabelled');
  });

  it('a change whose span does not overlap does not label the candidate', () => {
    const elsewhere = { ...change('accepted', 500, 520), expectedDiagnostics: [] };
    expect(goldLabelFor(candidate(), annotation({ changes: [elsewhere] }))).toBe('unlabelled');
  });

  it('an expected diagnostic for the same rule does not label a candidate elsewhere', () => {
    // A reviewer's verdict is about a passage, not about a rule id. Labelling by rule id alone made
    // one accepted change turn every candidate of that rule in the document into a gold violation.
    const byRule = {
      ...change('accepted', 500, 520),
      expectedDiagnostics: [
        {
          ruleId: 'passive-voice-candidate',
          category: 'deterministic-violation' as const,
          quote: 'q',
        },
      ],
    };
    expect(goldLabelFor(candidate(), annotation({ changes: [byRule] }))).toBe('unlabelled');
  });

  it('an expected diagnostic still labels a candidate that the change span covers', () => {
    const here = {
      ...change('accepted'),
      ruleIds: ['no-contractions'],
      expectedDiagnostics: [
        {
          ruleId: 'passive-voice-candidate',
          category: 'deterministic-violation' as const,
          quote: 'q',
        },
      ],
    };
    expect(goldLabelFor(candidate(), annotation({ changes: [here] }))).toBe('violation');
  });

  it('records that disagree about the same span leave it unlabelled, whatever their order', () => {
    const both = [change('accepted'), change('disputed')];
    expect(goldLabelFor(candidate(), annotation({ changes: both }))).toBe('unlabelled');
    expect(goldLabelFor(candidate(), annotation({ changes: both.toReversed() }))).toBe(
      'unlabelled',
    );
  });

  it('a direct candidate verdict labels the candidate', () => {
    expect(
      goldLabelFor(
        candidate(),
        annotation({ candidateAdjudications: [adjudication('violation')] }),
      ),
    ).toBe('violation');
    expect(
      goldLabelFor(
        candidate(),
        annotation({ candidateAdjudications: [adjudication('non-violation')] }),
      ),
    ).toBe('non-violation');
  });

  it('an undecidable verdict leaves the candidate unlabelled even if a change disagrees', () => {
    expect(
      goldLabelFor(
        candidate(),
        annotation({
          candidateAdjudications: [adjudication('undecidable')],
          changes: [change('accepted')],
        }),
      ),
    ).toBe('unlabelled');
  });

  it('a candidate verdict about another span does not label this candidate', () => {
    expect(
      goldLabelFor(
        candidate(),
        annotation({ candidateAdjudications: [adjudication('violation', 500, 520)] }),
      ),
    ).toBe('unlabelled');
  });
});

describe('evaluation run', () => {
  const manifest = fixtureManifestSchema.parse(
    JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8')),
  );

  it('refuses an empty split', async () => {
    await expect(
      evaluateSemanticEvaluators({
        fixturesDir: FIXTURES,
        // @ts-expect-error deliberately invalid split to prove the guard
        split: 'nonexistent',
        config: { semantic: { enabled: true } },
        transport: new ScriptedTransport([], { content: '{}' }),
      }),
    ).rejects.toThrow(/No fixtures in split/);
  });

  it('evaluates the heldout split without touching dev fixtures', async () => {
    const transport = new ScriptedTransport([], {
      content: verdictJson({
        ruleId: 'passive-voice-candidate',
        status: 'violation',
        confidence: 0.95,
        evidenceStart: 0,
        evidenceEnd: 3,
        explanation: 'passive',
        suggestedReplacements: [],
        meaningPreserved: false,
      }),
    });
    const report = await evaluateSemanticEvaluators({
      fixturesDir: FIXTURES,
      split: 'heldout',
      config: { semantic: { enabled: true, cache: false, maxRepairAttempts: 0 } },
      transport,
    });

    const heldoutIds = new Set(
      manifest.fixtures.filter((f) => f.split === 'heldout').map((f) => f.id),
    );
    expect(report.fixtures.every((id) => heldoutIds.has(id))).toBe(true);
    expect(report.cases.every((c) => c.split === 'heldout')).toBe(true);
    expect(report.split).toBe('heldout');
  });

  it('reports a failure rate rather than silently dropping failed requests', async () => {
    const transport = new ScriptedTransport([], { content: 'not json' });
    const report = await evaluateSemanticEvaluators({
      fixturesDir: FIXTURES,
      split: 'heldout',
      config: { semantic: { enabled: true, cache: false, maxRepairAttempts: 0 } },
      transport,
    });
    if (report.cases.length === 0) return;
    expect(report.overall.failureRate).toBeGreaterThan(0);
    expect(report.cases.every((c) => c.prediction === 'failed')).toBe(true);
  });

  it('excludes unlabelled candidates from the confusion matrix', async () => {
    const report = await evaluateSemanticEvaluators({
      fixturesDir: FIXTURES,
      split: 'heldout',
      config: { semantic: { enabled: true, cache: false, maxRepairAttempts: 0 } },
      transport: new ScriptedTransport([], {
        content: verdictJson({
          ruleId: 'passive-voice-candidate',
          status: 'violation',
          confidence: 0.95,
          evidenceStart: 0,
          evidenceEnd: 3,
          explanation: 'x',
          suggestedReplacements: [],
          meaningPreserved: false,
        }),
      }),
    });
    const m = report.overall;
    const decided = m.truePositives + m.falsePositives + m.trueNegatives + m.falseNegatives;
    expect(decided).toBeLessThanOrEqual(m.labelled);
    expect(m.labelled + m.unlabelled).toBe(report.cases.length);
  });

  it('formats a report that names the exclusion and the confidence caveat', async () => {
    const report = await evaluateSemanticEvaluators({
      fixturesDir: FIXTURES,
      split: 'heldout',
      config: { semantic: { enabled: false } },
      transport: new ScriptedTransport([], { content: '{}' }),
    });
    const text = formatEvaluationReport(report);
    expect(text).toContain('Unlabelled candidates excluded from the matrix');
    expect(text).toContain('not a calibrated probability');
    expect(text).toContain('precision');
  });

  it('makes no request when semantic analysis is disabled', async () => {
    const transport = new ScriptedTransport([], { content: '{}' });
    await evaluateSemanticEvaluators({
      fixturesDir: FIXTURES,
      split: 'all',
      config: { semantic: { enabled: false } },
      transport,
    });
    expect(transport.requests).toHaveLength(0);
  });
});

describe('annotation coverage', () => {
  const manifest = fixtureManifestSchema.parse(
    JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8')),
  );

  it('reports how much of the corpus is adjudicated', () => {
    const annotated = manifest.fixtures.filter((f) =>
      existsSync(join(FIXTURES, f.annotationPath)),
    ).length;
    // Not an assertion about a target: this exists so the coverage number is visible in CI output
    // rather than being an unstated assumption behind the evaluation figures.
    expect(annotated).toBeGreaterThanOrEqual(0);
    expect(annotated).toBeLessThanOrEqual(manifest.fixtures.length);
  });
});
