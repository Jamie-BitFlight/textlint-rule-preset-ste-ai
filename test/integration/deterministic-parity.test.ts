import { describe, expect, it } from 'vite-plus/test';
import { analyseText, analyseTextDeterministic } from '../../src/analysis/analyse.js';

/**
 * Regression: `ste-ai lint` (this repository's own CLI, run without `--semantic`) calls
 * `analyseTextDeterministic`, which never touches a semantic broker at all. The real textlint plugin
 * (`createSteTextlintRule` -> `getAnalysis` in `src/textlint/adapter.ts`) always calls `analyseText`
 * instead -- even with `semantic.enabled: false` -- which routes every candidate through
 * `SemanticBroker.adjudicate()`, which declines them with `failure.kind === 'disabled'`.
 *
 * Both paths report the identical fact -- "this candidate needed semantic adjudication, and it did
 * not run" -- but each built its own hand-written message string for it, and the two had drifted:
 * `analyseTextDeterministic` said "This passage needs semantic adjudication, which did not run, so
 * it was not decided[...]"; the broker's disabled path said "Semantic adjudication did not run, so
 * this candidate was not decided[...]". A comparison of `dist/cli/main.js lint` against the real
 * `textlint --config .textlintrc.json` on the same file (`docs/implementation-report.md`) surfaced
 * dozens of findings that looked unique to one side purely because of this wording split, though the
 * same candidate was reported, undecided, on both.
 *
 * `undecidedCandidateReasonMessage`/`semanticNotRunNoticeMessage` in `src/semantic/analyse.ts` are now
 * the single source for this text; this test proves the two entry points actually render identically
 * for a real document, not just that the shared function works in isolation.
 */
describe('the deterministic-only CLI path and the semantic-disabled broker path agree', () => {
  // Produces a `passive-voice-candidate` via `src/deterministic/rules/candidate-rules.ts` -- the
  // same trigger `test/integration/candidate-payload-contract.test.ts` uses for this evaluator.
  const text = 'The valve was closed by the technician.\n';

  it('renders the same review-required message for the same undecided candidate', async () => {
    const deterministic = analyseTextDeterministic(text, {});
    const semanticDisabled = await analyseText(text, {});

    const fromDeterministic = deterministic.diagnostics.find(
      (d) => d.category === 'review-required',
    );
    const fromBroker = semanticDisabled.diagnostics.find((d) => d.category === 'review-required');

    expect(fromDeterministic?.message).toBeDefined();
    expect(fromBroker?.message).toBe(fromDeterministic?.message);
  });

  it('renders the same semantic-disabled run-notice summary for the same document', async () => {
    const deterministic = analyseTextDeterministic(text, {});
    const semanticDisabled = await analyseText(text, {});

    const fromDeterministic = deterministic.notices.find((n) => n.code === 'semantic-disabled');
    const fromBroker = semanticDisabled.notices.find((n) => n.code === 'semantic-disabled');

    expect(fromDeterministic?.message).toBeDefined();
    expect(fromBroker?.message).toBe(fromDeterministic?.message);
  });

  it('does not call semantic adjudication "disabled" when config actually enables it', () => {
    // `analyseTextDeterministic` never contacts the semantic service regardless of
    // `config.semantic.enabled` -- its own doc comment says so -- but until this fix its
    // `semantic-disabled` notice claimed "which is disabled" even when the caller's own config set
    // `semantic.enabled: true` and simply invoked this deterministic-only entry point directly (the
    // combination `ste-ai lint --semantic --deterministic-only` produces). Confirmed directly: the
    // message text was previously identical for `enabled: true` and `enabled: false`.
    const enabled = analyseTextDeterministic(text, { config: { semantic: { enabled: true } } });
    const disabled = analyseTextDeterministic(text, { config: { semantic: { enabled: false } } });

    const fromEnabled = enabled.notices.find((n) => n.code === 'semantic-disabled');
    const fromDisabled = disabled.notices.find((n) => n.code === 'semantic-disabled');

    expect(fromEnabled?.message).toBeDefined();
    expect(fromEnabled?.message).not.toContain('is disabled');
    expect(fromDisabled?.message).toContain('is disabled');
    expect(fromEnabled?.message).not.toBe(fromDisabled?.message);
  });
});
