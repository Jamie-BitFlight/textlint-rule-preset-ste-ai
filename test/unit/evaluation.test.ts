import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import type { CandidatePassage } from '../../src/core/types.js';
import {
  evaluateSemanticEvaluators,
  formatEvaluationReport,
  goldLabelFor,
  MIN_POSITIVES_FOR_RECALL,
  type EvaluationReport,
  type EvaluatorMetrics,
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
    // Positive control: the heldout fixtures really do produce candidates for this scripted
    // transport to fail on. Without this, an early return on an empty result (the shape this test
    // used to have) would let the fixture corpus shrink to zero heldout candidates and this test
    // would keep passing while asserting nothing.
    expect(report.cases.length).toBeGreaterThan(0);
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
    // Positive control: at least one case really was decided, so the inequality below is not
    // vacuously satisfied by every count being zero.
    expect(decided).toBeGreaterThan(0);
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

function metrics(overrides: Partial<EvaluatorMetrics> = {}): EvaluatorMetrics {
  return {
    evaluatorId: 'passive-voice-adjudication',
    truePositives: 0,
    falsePositives: 0,
    trueNegatives: 0,
    falseNegatives: 0,
    precision: 0.8,
    recall: 0.75,
    f1: 0.774,
    uncertainRate: 0,
    failureRate: 0,
    unlabelled: 0,
    labelled: 20,
    goldPositives: 20,
    goldNegatives: 0,
    latencyMs: { p50: 0, p90: 0, p99: 0, mean: 0 },
    ...overrides,
  };
}

function buildReport(perEvaluator: readonly EvaluatorMetrics[]): EvaluationReport {
  const overall = perEvaluator[0];
  if (overall === undefined) throw new Error('at least one evaluator required');
  return {
    split: 'heldout',
    model: 'm',
    promptVersion: 'v1',
    endpoint: 'http://x',
    generatedAt: new Date(0).toISOString(),
    fixtures: ['f'],
    overall,
    perEvaluator,
    cases: [],
  };
}

describe('recall/F1 withholding below the gold-positive floor', () => {
  it('withholds recall and F1 just below the threshold', () => {
    const m = metrics({ goldPositives: MIN_POSITIVES_FOR_RECALL - 1 });
    const text = formatEvaluationReport(buildReport([m]));
    expect(text).toContain(
      `recall withheld for ${m.evaluatorId}: ${MIN_POSITIVES_FOR_RECALL - 1} gold positive(s)`,
    );
    // The withheld cell reports the count, not the computed ratio -- `recall` above is a real
    // number (0.75), so its formatted form appearing here would mean the withholding never applied.
    expect(text).not.toContain('0.750');
    // f1Cell is withheld by the same condition as recallCell, but independently -- a regression
    // that withholds recall correctly while still printing F1's own number (0.774) would satisfy
    // every assertion above.
    expect(text).not.toContain('0.774');
  });

  it('reports recall and F1 as numbers exactly at the threshold', () => {
    const m = metrics({ goldPositives: MIN_POSITIVES_FOR_RECALL, recall: 0.75, f1: 0.774 });
    const text = formatEvaluationReport(buildReport([m]));
    expect(text).not.toContain(`recall withheld for ${m.evaluatorId}`);
    expect(text).toContain('0.750');
    expect(text).toContain('0.774');
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
