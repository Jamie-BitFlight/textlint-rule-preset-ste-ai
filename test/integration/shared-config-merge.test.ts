import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { clearAnalysisCache, getAnalysis } from '../../src/textlint/adapter.js';
import { clearSharedConfigCache } from '../../src/textlint/shared-config.js';

/**
 * Regression: `getAnalysis` merges `sharedFile.config` (the `.ste-ai.json` on disk) with `shared`
 * (a rule's own inline `shared` textlint option) via a shallow, top-level-key spread — the last
 * write for a given top-level key (`diagnostics`, `autofix`, …) wins, the same way a plain
 * `{ ...a, ...b }` always does. `steAiConfigSchema`'s fields carry defaults
 * (`.default()`/`.prefault()`, see `src/core/config.ts`), so a `shared` value that has already been
 * validated through that schema — even one the caller never explicitly set most fields on — carries
 * every field, each either the caller's real value or the schema's own default. Merged on top of
 * `sharedFile.config` that way, an unrelated field the shared-config *file* set to something
 * non-default would be silently overwritten by the schema's default the moment `shared` merely
 * *omitted* that field, even though the inline rule option never meant to touch it at all.
 *
 * `getAnalysis`'s `shared` parameter is therefore deliberately typed and treated as an
 * *unvalidated* plain object, never parsed through `steAiConfigSchema` before this merge — only the
 * merge's own result is validated, once, downstream. This test proves that discipline holds: a
 * `.ste-ai.json` file's non-default setting for one field survives an inline `shared` option that
 * sets a completely different field and never mentions the first.
 */
describe('getAnalysis merges a shared-config file with an inline shared option', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'ste-ai-shared-config-'));
    clearSharedConfigCache();
    clearAnalysisCache();
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    clearSharedConfigCache();
    clearAnalysisCache();
  });

  it('keeps the config file’s setting for a field the inline shared option never mentions', async () => {
    // The file sets a non-default value for one field, `diagnostics.reportSuppressed`.
    writeFileSync(
      join(baseDir, '.ste-ai.json'),
      JSON.stringify({ diagnostics: { reportSuppressed: true } }),
    );

    // The inline `shared` option (what a rule receives from its own textlint options) sets a
    // different field, `approvedTerms`, and says nothing about `diagnostics` at all.
    const result = await getAnalysis(
      'Utilise the bracket.\n',
      undefined,
      baseDir,
      { approvedTerms: ['Utilise'] },
      new Map(),
    );

    // Both settings must hold: the inline option's own field, and the file's field it never
    // mentioned. Losing the second to the schema's own default (`reportSuppressed: false`) is
    // exactly the regression this test guards against.
    expect(result.config.approvedTerms).toContain('Utilise');
    expect(result.config.diagnostics.reportSuppressed).toBe(true);
  });

  /**
   * Regression (`chatgpt-codex-connector`, P2, `discussion_r3707793537`): `shared.rules` is merged
   * per rule id, but an earlier version validated the *whole* `shared.rules` map at once and
   * dropped it entirely — `{}` — the moment any single entry's value was not itself a plain
   * object. A malformed sibling entry therefore silently discarded every valid entry alongside it,
   * including an explicit `enabled: false` the user had set for an unrelated rule.
   */
  it('keeps a valid shared.rules entry when a sibling entry is malformed', async () => {
    // `getAnalysis`'s `shared` parameter is typed `SteAiConfigInput` for its public contract (see
    // its own doc comment), but the value behind it is never actually validated against that type
    // before this point — this simulates a real external caller (or a malformed `.textlintrc.json`)
    // whose `rules` entry does not match the type at runtime, which is exactly the case this test
    // exists to prove `getAnalysis` handles without discarding valid sibling entries.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const shared = {
      rules: {
        'no-contractions': { enabled: false },
        'misspelled-rule': false,
      },
    } as unknown as Parameters<typeof getAnalysis>[3];

    const result = await getAnalysis(
      'Utilise the bracket.\n',
      undefined,
      baseDir,
      shared,
      new Map(),
    );

    // The valid sibling entry must survive the malformed one, not be wiped out alongside it.
    expect(result.config.rules['no-contractions']?.['enabled']).toBe(false);
  });

  /**
   * Regression: `getAnalysis` is called once per enabled rule, each with only its own
   * `perRuleOptions` entry (see this function's own doc comment on `reportedRunNoticesFor` in
   * `adapter.ts`). An earlier version folded that entry's *key* into `mergedRules` unconditionally,
   * even when its value was `{}` -- no rule-specific options beyond being enabled, the common case.
   * `cacheKey` hashes the whole merged config, so two rules that both carry empty options still
   * produced different cache entries purely because they were keyed under different rule ids, even
   * though neither call's `mergedRules` differed in any way that could change the analysis.
   * Reproduced directly against this repo's own real preset (14 rules): instrumenting the cache with
   * a trace showed 14 misses, 0 hits, for one document -- confirmed here at the `getAnalysis` level,
   * not just observed as a slow corpus run.
   */
  it('shares one cache entry across rules whose own options are empty', () => {
    const text = 'Utilise the bracket.\n';
    const promiseA = getAnalysis(
      text,
      undefined,
      baseDir,
      undefined,
      new Map([['no-contractions', {}]]),
    );
    const promiseB = getAnalysis(
      text,
      undefined,
      baseDir,
      undefined,
      new Map([['punctuation-constraints', {}]]),
    );
    expect(promiseA).toBe(promiseB);
  });

  /** The narrower fix must not reopen what it replaced: a rule with genuinely distinct own options
   * still gets its own cache entry, not folded into the shared one. */
  it('still gives a rule with genuinely distinct own options its own cache entry', () => {
    const text = 'Utilise the bracket.\n';
    const promiseA = getAnalysis(
      text,
      undefined,
      baseDir,
      undefined,
      new Map([['no-contractions', {}]]),
    );
    const promiseB = getAnalysis(
      text,
      undefined,
      baseDir,
      undefined,
      new Map([['abbreviation-introduction', { additionalWellKnown: ['FOO'] }]]),
    );
    expect(promiseA).not.toBe(promiseB);
  });
});
