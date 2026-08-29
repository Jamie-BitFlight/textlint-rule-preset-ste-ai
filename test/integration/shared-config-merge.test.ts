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
   * Reproduced directly against this repo's own real preset: instrumenting the cache with a trace
   * showed a distinct cache miss per enabled rule and no hits, for one document -- confirmed here at
   * the `getAnalysis` level, not just observed as a slow corpus run.
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

  /**
   * Regression (`chatgpt-codex-connector`, P2, on PR #117): the doc comment on `getAnalysis`
   * originally claimed every optionless rule shares one entry unconditionally. That is only true
   * when the calls also carry the same `shared` override -- `cacheKey` hashes the whole merged
   * `config`, which spreads `shared` in after `sharedFile.config`, so two rules with identical
   * (empty) own options but genuinely different `shared` values still diverge. The prior tests
   * above only ever call `getAnalysis` with `shared: undefined` for both sides, so they could not
   * have caught a doc comment overselling this. `createSteTextlintRule` reads `shared` per rule
   * from that rule's own `.textlintrc.json` options block, so two rules genuinely can be configured
   * with different `shared` values in a real project.
   */
  it('still gives an optionless rule its own cache entry when its shared override differs', () => {
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
      { approvedTerms: ['Utilise'] },
      new Map([['punctuation-constraints', {}]]),
    );
    expect(promiseA).not.toBe(promiseB);
  });

  /**
   * Regression (`chatgpt-codex-connector`, P2, on PR #117, commit `ca643c6`): a still-later round
   * reversed the recursive-key-sort fix this test originally pinned. Sorting an object's own keys
   * for the cache key assumed key order is never behaviour-significant for the config shapes this
   * function serialises -- false for `unapproved-vocabulary`/`preferred-terminology`'s `additional`
   * option, whose entries `vocabulary.ts` reads via `Object.entries` and sorts only by term length
   * (a stable sort, so same-length keys keep their insertion order); a same-length, case-variant
   * pair (`Use`/`use`) then resolves to whichever key came first. Sorting keys alphabetically gave
   * `{ Use: [...], use: [...] }` and `{ use: [...], Use: [...] }` -- two configs that genuinely
   * suggest a different alternative for the same match -- the same cache key, reproduced directly:
   * computed independently they suggest `"employ"` and `"apply"` respectively, but cached together
   * the second call wrongly reused the first's answer. `stableStringify` now preserves each object's
   * own key order instead of normalising it away, since a cache key must never collide two configs
   * with different real behaviour, even at the cost of a config that is genuinely identical but
   * built with fields in a different order no longer sharing a cache entry either -- a missed
   * cache-share opportunity, not a wrong answer.
   */
  it('does not share a cache entry between an order-significant additional map built in reverse key order', async () => {
    const text = 'Use the tool.\n';
    const optionsA = { additional: { Use: ['employ'], use: ['apply'] } };
    const optionsB = { additional: { use: ['apply'], Use: ['employ'] } };
    clearAnalysisCache();
    const resultA = await getAnalysis(
      text,
      undefined,
      baseDir,
      undefined,
      new Map([['unapproved-vocabulary', optionsA]]),
    );
    clearAnalysisCache();
    const resultB = await getAnalysis(
      text,
      undefined,
      baseDir,
      undefined,
      new Map([['unapproved-vocabulary', optionsB]]),
    );
    expect(resultA.diagnostics[0]?.suggestions).toEqual(['employ']);
    expect(resultB.diagnostics[0]?.suggestions).toEqual(['apply']);

    clearAnalysisCache();
    const promiseA = getAnalysis(
      text,
      undefined,
      baseDir,
      undefined,
      new Map([['unapproved-vocabulary', optionsA]]),
    );
    const promiseB = getAnalysis(
      text,
      undefined,
      baseDir,
      undefined,
      new Map([['unapproved-vocabulary', optionsB]]),
    );
    expect(promiseA).not.toBe(promiseB);
  });

  /**
   * A `shared` override with the same keys and values, only reordered, no longer shares a cache
   * entry -- the accepted tradeoff `stableStringify`'s own doc comment explains. This pins that the
   * tradeoff is a missed cache-share opportunity (two distinct, independently-correct analyses),
   * not a wrong answer: both calls still resolve to the same real diagnostics.
   */
  it('computes independently, but correctly, for two shared overrides differing only in key order', async () => {
    const text = 'Utilise the bracket.\n';
    const sharedA = {
      diagnostics: { reportSuppressed: true, severity: { 'review-required': 'info' as const } },
    };
    const sharedB = {
      diagnostics: { severity: { 'review-required': 'info' as const }, reportSuppressed: true },
    };
    const promiseA = getAnalysis(
      text,
      undefined,
      baseDir,
      sharedA,
      new Map([['no-contractions', {}]]),
    );
    const promiseB = getAnalysis(
      text,
      undefined,
      baseDir,
      sharedB,
      new Map([['punctuation-constraints', {}]]),
    );
    expect(promiseA).not.toBe(promiseB);
    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);
    expect(resultA.diagnostics.map((d) => d.category)).toEqual(
      resultB.diagnostics.map((d) => d.category),
    );
  });

  // Regression (`chatgpt-codex-connector`, P2, on PR #117, commit `21ebd8f`): `stableStringify`'s
  // array branch mapped `undefined` through `JSON.stringify` (which returns the bare JS `undefined`
  // value for that input, not a string) and then joined the array, so an `undefined` entry silently
  // collapsed to an empty string -- `[undefined]` and `[]` serialised identically and collided in the
  // cache. A rule config carrying `approvedTerms: [undefined]` -- a caller error -- would then
  // wrongly reuse the cached analysis of an unrelated rule whose config was `approvedTerms: []`.
  it('does not share a cache entry between an array with an undefined entry and an empty array', () => {
    const text = 'Utilise the bracket.\n';
    const promiseA = getAnalysis(
      text,
      undefined,
      baseDir,
      undefined,
      new Map([['no-contractions', { approvedTerms: [undefined] }]]),
    );
    const promiseB = getAnalysis(
      text,
      undefined,
      baseDir,
      undefined,
      new Map([['no-contractions', { approvedTerms: [] }]]),
    );
    expect(promiseA).not.toBe(promiseB);
  });

  // Regression (`chatgpt-codex-connector`, P2, on PR #117, commit `ebe9e36`): the fix above still
  // used `Array.prototype.map`, which skips a hole in a sparse array rather than visiting it, so
  // `Array(1)` (one hole, never assigned) serialised the same as `[]` -- a different collision than
  // an explicit `[undefined]` entry, which `.map` does visit.
  it('does not share a cache entry between a sparse array hole and an empty array', () => {
    const text = 'Utilise the bracket.\n';
    // eslint-disable-next-line no-sparse-arrays -- the hole itself is the point of this case.
    const sparse: unknown[] = Array(1);
    const promiseA = getAnalysis(
      text,
      undefined,
      baseDir,
      undefined,
      new Map([['no-contractions', { approvedTerms: sparse }]]),
    );
    const promiseB = getAnalysis(
      text,
      undefined,
      baseDir,
      undefined,
      new Map([['no-contractions', { approvedTerms: [] }]]),
    );
    expect(promiseA).not.toBe(promiseB);
  });
});
