import { describe, expect, it } from 'vite-plus/test';
import {
  resolveConfig,
  SteAiConfigError,
  steAiConfigSchema,
  type SteAiConfigInput,
} from '../../src/core/config.js';
import { analyseDocument } from '../../src/core/document.js';
import { runDeterministicRules } from '../../src/core/runner.js';
import { deterministicRules } from '../../src/deterministic/index.js';
import { provisionalRulePack } from '../../src/rule-pack/provisional-pack.js';

/**
 * A dropped configuration key is the worst outcome a policy file has: it parses, it applies nothing,
 * and the operator's own file reads as proof of a setting that was discarded. Before these tests the
 * whole schema was permissive, so `diagnostics.severity` keyed on a category that does not exist
 * validated cleanly and returned the untouched defaults.
 *
 * Two behaviours are locked here, and they pull in opposite directions:
 * - every object in the configuration rejects an unrecognised key, naming it;
 * - `rules.<id>` does *not*, because a rule's own `optionsSchema` is the only thing that knows which
 *   of its options are real. That catch-all is why rule *ids* have to be checked by the runner
 *   instead, which is the third block below.
 */

/** The issue paths a rejected configuration reports, so a failure names the key and not just "invalid". */
function issuesFor(input: unknown): string[] {
  try {
    resolveConfig(input);
    return [];
  } catch (error) {
    if (!(error instanceof SteAiConfigError)) throw error;
    return error.issues.map((issue) => `${issue.path}: ${issue.message}`);
  }
}

describe('unrecognised configuration keys are rejected', () => {
  it('rejects a misspelt diagnostic category, naming the key and its path', () => {
    // The reported repro: `style-preference` is not one of the five diagnostic categories. This
    // previously parsed and silently returned the default severity map.
    const issues = issuesFor({ diagnostics: { severity: { 'style-preference': 'info' } } });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('diagnostics.severity');
    expect(issues[0]).toContain('style-preference');
  });

  it('rejects a mistyped semantic key rather than leaving the timeout unset', () => {
    // `requestTimeoutMS` (wrong case) silently left `requestTimeoutMs` at its 20s default, so the
    // operator believed a 5s timeout was in force.
    const issues = issuesFor({ semantic: { requestTimeoutMS: 5000 } });

    expect(issues).toEqual(['semantic: Unrecognized key: "requestTimeoutMS"']);
  });

  it('rejects a mistyped top-level key', () => {
    expect(issuesFor({ aprovedTerms: ['Node.js'] })).toEqual([
      '<root>: Unrecognized key: "aprovedTerms"',
    ]);
  });

  it('rejects unrecognised keys in every policy object, not only the top level', () => {
    // Deliberately typed `unknown`: these are the shapes a hand-written JSON file produces, which
    // never went through the compiler in the first place.
    const cases: readonly [string, unknown][] = [
      ['autofix', { autofix: { enabled: true, allowSemantic: true } }],
      ['suppressions', { suppressions: { allowInAdmonition: true } }],
      ['diagnostics', { diagnostics: { reportReviewRequird: true } }],
      ['semantic', { semantic: { evaluator: [] } }],
    ];

    for (const [label, input] of cases) {
      expect(issuesFor(input), `${label} should reject its unrecognised key`).toHaveLength(1);
    }
  });

  it('still accepts a fully-specified valid configuration', () => {
    const resolved = resolveConfig({
      approvedTerms: ['Node.js'],
      autofix: { enabled: false },
      suppressions: { allowInAdmonitions: true },
      diagnostics: { severity: { 'review-required': 'warning' } },
      semantic: { requestTimeoutMs: 5000, confidenceThresholds: { 'passive-voice': 0.8 } },
    });

    expect(resolved.diagnostics.severity['review-required']).toBe('warning');
    expect(resolved.semantic.requestTimeoutMs).toBe(5000);
    // `confidenceThresholds` is keyed by evaluator id and stays a free-form record.
    expect(resolved.semantic.confidenceThresholds).toEqual({ 'passive-voice': 0.8 });
  });
});

/** One run over a trivial document, so only the notices produced by `config.rules` keys differ. */
function runWith(config: SteAiConfigInput) {
  const resolved = resolveConfig(config);
  const doc = analyseDocument({ id: 't', format: 'markdown', text: 'Press the green button.\n' });
  return runDeterministicRules({
    doc,
    rules: deterministicRules,
    config: resolved,
    pack: provisionalRulePack,
  });
}

describe('rules.<id> keeps its catch-all', () => {
  it('accepts arbitrary rule-specific options and passes them through untouched', () => {
    // Strictness must stop at the rule boundary: only `unapproved-vocabulary`'s own `optionsSchema`
    // knows what `adjudicateSense` is, and the runner validates against it.
    const resolved = resolveConfig({
      rules: {
        'unapproved-vocabulary': {
          enabled: true,
          severity: 'warning',
          allow: ['terminate'],
          adjudicateSense: true,
        },
      },
    });

    expect(resolved.rules['unapproved-vocabulary']).toEqual({
      enabled: true,
      severity: 'warning',
      allow: ['terminate'],
      adjudicateSense: true,
    });
  });

  it('accepts options no rule declares, because only the rule can judge them', () => {
    const result = steAiConfigSchema.safeParse({
      rules: { 'noun-cluster-candidate': { somethingOnlyThisRuleKnows: 42 } },
    });

    expect(result.success).toBe(true);
  });
});

describe('unknown rule ids are a notice, not a failure', () => {
  it('reports a mistyped rule id and completes the run', () => {
    // A mistyped id cannot be caught by the schema — the entry is well formed, it simply configures
    // nothing. Without this notice the operator got no rule configured and no complaint.
    const run = runWith({ rules: { 'sentance-length-procedural': { enabled: false } } });
    const unknown = run.notices.filter((notice) => notice.code === 'unknown-rule-id');

    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.level).toBe('warning');
    expect(unknown[0]?.message).toContain('sentance-length-procedural');
    expect(unknown[0]?.detail).toEqual({ ruleId: 'sentance-length-procedural' });
    // Degraded, not failed: every other rule still ran.
    expect(run.notices.some((notice) => notice.level === 'error')).toBe(false);
  });

  it('reports each unknown id once, in a deterministic order', () => {
    const run = runWith({ rules: { 'zzz-unknown': {}, 'aaa-unknown': {} } });

    expect(
      run.notices.filter((n) => n.code === 'unknown-rule-id').map((n) => n.detail?.['ruleId']),
    ).toEqual(['aaa-unknown', 'zzz-unknown']);
  });

  it('says nothing when every configured id is real', () => {
    const run = runWith({ rules: { 'no-contractions': { enabled: false } } });

    expect(run.notices.filter((notice) => notice.code === 'unknown-rule-id')).toEqual([]);
  });
});
