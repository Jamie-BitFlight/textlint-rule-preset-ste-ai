# Layered rule packs — migration, impact and verification

> **Read [`00-decisions.md`](./00-decisions.md) first.** This spec is one of three produced
> independently. The decision record adopts its config-key proposal over `01`'s, and moves several
> things it takes as given from the other two specs. Nothing below has been rewritten to match, on
> purpose — the specs are the reasoning, `00` is the conclusion.

**Scope owner:** landing safety. Merge algorithm, merge keys, retraction syntax, conflict semantics,
config zod shape, and the authority/provenance model are specified by other agents and are taken as
given here. This document answers: what breaks, what must not silently change meaning, what tests
must exist before merge, what documentation goes stale, and in what order the PRs ship.

**Stage 0 precondition — not yet dischargeable.** The staged rollout below assumes the tree is
green before the first characterisation tests land. At `9d78a8b` the suite was green (545 tests).
At `ebcc623`, which is what this branch was actually cut from, one corpus assertion was failing
(`test/fixtures/corpus.test.ts`, `abbreviation-introduction` not firing on `VACUUM`) — a
pre-existing failure from #56, not caused by anything here. It was fixed by #58 and the merged base
is green again. Re-run `npm ci && npm run verify` on the tree an implementation actually starts
from; do not take a figure from this document as the check.

**Baseline commit:** authored against `9d78a8b` (detached). That commit turned out to be a
**sibling** of this branch rather than an ancestor of it, so every line reference below was
re-checked against the branch after `main` was merged in, and the ones that had drifted were
corrected. Each reference was opened, not inferred, in both passes.

**Verification environment caveat:** `node_modules` is **not** installed in this worktree, so
`npm test`, `npm run typecheck` and coverage were **not** run. Zod behaviour claims below were
executed against `/home/user/textlint-rule-preset-ste-ai/node_modules/zod` (v4.4.3) directly and are
marked as executed. Everything else is static reading.

---

## Summary

The single-pack assumption is narrower than it looks in the type system and wider than it looks in
the test suite.

- **Narrow in code.** Exactly **three** call sites resolve a pack (`src/analysis/analyse.ts:244`,
  `src/evaluation/evaluate.ts:227`, `scripts/build-candidate-packets.mjs:77`), and **eleven**
  places across seven files read pack _content_ — the measurement is
  `grep -rn 'pack\.\(rules\|dictionary\|contractions\|approvedTechnicalTerms\|limits\)' src/`
  (`runner.ts:51`, `analyse.ts:255`, `evaluate.ts:244`, and the four rule files: `vocabulary.ts` ×3,
  `sentence-length.ts` ×3, `structure-rules.ts`, `candidate-rules.ts`). `cli/main.ts:190-196` reads
  pack _metadata_, which is a separate surface and is treated as one in `02`. A composite `RulePack` that satisfies the existing `RulePack` interface
  (`src/core/types.ts:474-486`) would require **no change at all** to the rule layer.
- **Wide in the test suite — dangerously so.** **Zero** tests import
  `src/rule-pack/loader.ts`. `resolveRulePack`, `loadRulePackFromFile`, `parseRulePack`,
  `verifiedAuthority` and `packPermitsConformanceClaim` have no direct test anywhere in `test/`
  (verified by grep across the whole `test/` tree; the only rule-pack imports are three
  `provisionalRulePack` imports and the module-boundary allow-list). **The back-compatibility path
  this change must preserve is currently unpinned.** Stage 0 of the rollout exists solely to fix
  that before anything is refactored.
- **The dangerous silent-change class is real and it is naming.** `steAiConfigSchema`
  (`src/core/config.ts:119`) is a plain `z.object` with no `.strict()`; zod 4.4.3 **strips** unknown
  keys silently (executed). A _new_ config key (`rulePacks`, `packs`, `layers`…) is therefore
  silently discarded by every already-released version, and by any half-upgraded consumer — a
  config that says "lint against the Acme normative pack" degrades to "lint against the bundled
  provisional pack" with no error. By contrast, `rulePack: [...]` (an array under the **existing**
  key) is **rejected** by the current union (`z.union([z.string(), z.record(...)])`,
  `config.ts:124`) — executed: `Invalid input`. **Recommendation: widen the existing `rulePack` key
  rather than introduce a new one.** Old versions then fail loud instead of failing quiet.
- **Corpus numbers are safer than they look.** The corpus's adjudication assertions in
  `test/fixtures/corpus.test.ts` — the class balance and per-rule tally when this was written, a
  record-by-record comparison against `fixtures/verdicts/` since — are computed from
  `annotation.candidateAdjudications`, static JSON in `fixtures/annotations/`, **not** from linter
  output. Layering cannot move them. What layering _can_ break is
  `corpus.test.ts:327-341` and `scripts/ci/check-candidate-ground-truth.sh`, which do run the
  linter. Both are safe iff the no-config default path still resolves to exactly
  `provisionalRulePack` (`loader.ts:53`).
- **`check-rules-provisional.sh 14` is not at risk** from layering as such: `listRules`
  (`src/cli/main.ts:277-296`) enumerates the `deterministicRules` code registry and reports
  `r.meta.status`, never the pack. It becomes at risk only if the layering work makes the `rules`
  command pack-aware — which it should not, in this change.

---

## Blast radius inventory

Every row cites a file and line opened at the baseline commit.

### A. Pack resolution (the boundary itself)

| #   | File:line                                                                       | What it assumes                                                                                                                               | What has to change                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `src/rule-pack/loader.ts:49-56` `resolveRulePack(spec, baseDir): RulePack`      | Config carries **one** spec (`string \| Record \| undefined`) and the function returns **one** pack. `:53` `undefined → provisionalRulePack`. | Becomes the composition entry point. Must accept an ordered layer list, resolve each, and hand the sequence to the merge module. Must keep `undefined → provisionalRulePack` byte-identical (see back-compat).                                                                                                                                                                  |
| A2  | `src/rule-pack/loader.ts:15-24` `parseRulePack(value, origin)`                  | Validates a **whole** pack: `metadata`, `limits`, `dictionary` all required (`schema.ts:93-104`).                                             | A non-base layer that only adds vocabulary cannot satisfy `metadata`/`limits` today. Either every layer ships full metadata+limits, or a second "fragment" parse path is needed. This is the merge agent's schema call; the _impact_ is that `parseRulePack`'s single error shape (`RulePackError`, `:21`) currently names one origin and must now name **which layer** failed. |
| A3  | `src/rule-pack/loader.ts:26-41` `loadRulePackFromFile(path, baseDir)`           | One file, one `baseDir`, relative resolution against `resolve(baseDir, path)` (`:27`).                                                        | Called N times. Two hazards: (a) a layer path relative to _which_ base — the config file's directory or the caller's `baseDir`; (b) cycle/self-reference if a layer may itself declare layers. Neither exists today.                                                                                                                                                            |
| A4  | `src/rule-pack/loader.ts:76-83` `packPermitsConformanceClaim(pack, trustedIds)` | Reads `pack.metadata.authority` / `.conformanceClaim` / `.id` — **a single identity**.                                                        | A merged pack has N identities and N licences. Authority agent owns the semantics; this call site must be updated in lockstep with `cli/main.ts:193-197`.                                                                                                                                                                                                                       |
| A5  | `src/rule-pack/loader.ts:92-98` `verifiedAuthority(pack, trustedIds)`           | Same single-identity assumption; `:97` `trustedIds.includes(pack.metadata.id)`.                                                               | Same. Called from `analyse.ts:292`, `analyse.ts:607`, `cli/main.ts:190`.                                                                                                                                                                                                                                                                                                        |
| A6  | `src/rule-pack/index.ts:1-3` + `package.json:22-25` (`"./rule-pack"` export)    | `export * from './loader.js'` makes `resolveRulePack`'s **signature a public API**.                                                           | Any signature change is a semver-visible break for external consumers, not just an internal refactor. Additive overload or a new `resolveRulePacks` beside the old one is the low-risk shape.                                                                                                                                                                                   |
| A7  | `src/rule-pack/provisional-pack.ts:22` `provisionalRulePack`                    | The one bundled pack; `metadata.id: 'ste-ai-provisional'` (`:24`), `authority: 'provisional'`, `conformanceClaim: 'none'` (`:27`,`:31`).      | Becomes layer 0 (bundled) in the layer order. Its identity must survive merge in a form `assert-corpus-report.mjs:36` can still see as `provisional`.                                                                                                                                                                                                                           |

### B. Config

| #   | File:line                                                                                                | What it assumes                                                                                                   | What has to change                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | `src/core/config.ts:124` `rulePack: z.union([z.string(), z.record(z.string(), z.unknown())]).optional()` | Exactly one spec, string-or-object.                                                                               | Owned by the config-shape agent. **Impact note (executed):** the union currently _rejects_ an array — widening this key gives old versions a loud failure; a brand-new sibling key gives them a silent one.             |
| B2  | `src/core/config.ts:119` `steAiConfigSchema = z.object({...})` — **no `.strict()`**                      | Unknown keys are silently stripped (executed against zod 4.4.3: `parse({a:'x', rulePacks:[...]})` → `{"a":"x"}`). | The single largest silent-meaning-change vector. Either widen `rulePack` (B1) or add `.strict()`/`.catchall(z.never())` — but note `.strict()` is itself a breaking change for any config carrying editor-comment keys. |
| B3  | `src/core/config.ts:133` `trustedRulePackIds: z.array(z.string())`                                       | One id list matched against **one** `metadata.id`.                                                                | Authority agent's call; the _impact_ is that trust becomes per-layer and the CLI/analysis call sites (A4, A5) change together.                                                                                          |
| B4  | `src/core/index.ts:7` `export * from './config.js'` + `package.json` `"./core"` export                   | `SteAiConfig`/`SteAiConfigInput` are public types.                                                                | A type widening on `rulePack` is source-visible to typed consumers.                                                                                                                                                     |

### C. Composition roots

| #   | File:line                                                                                                | What it assumes                                                             | What has to change                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `src/analysis/analyse.ts:244` `resolveRulePack(config.rulePack, options.baseDir ?? process.cwd())`       | Single spec, single baseDir.                                                | Primary migration point.                                                                                                                                                                                                                                        |
| C2  | `src/analysis/analyse.ts:190` doc comment: "Base directory used to resolve a relative `rulePack` path."  | Singular.                                                                   | Reword for N layers.                                                                                                                                                                                                                                            |
| C3  | `src/analysis/analyse.ts:219`, `:238` `readonly pack: RulePack` on `AnalysisResult`                      | One pack is the public result surface.                                      | If layering is to be auditable, the result needs the layer list/provenance too. Adding a field is additive; **changing** `pack` is a public break (`package.json` `"./analysis"` export). Keep `pack` as the merged effective pack; add `packLayers` beside it. |
| C4  | `src/analysis/analyse.ts:255` `approvedTerms: [...config.approvedTerms, ...pack.approvedTechnicalTerms]` | One flat list from one pack.                                                | Reads the merged pack; correct as long as merge produces a deduplicated `approvedTechnicalTerms`. A duplicated term here is harmless (it feeds a protected-region matcher) — worth confirming, not assuming.                                                    |
| C5  | `src/analysis/analyse.ts:292`, `:607` `verifiedAuthority(pack, config.trustedRulePackIds)`               | Single-pack authority stamps every semantic and review-required diagnostic. | Follows A5.                                                                                                                                                                                                                                                     |
| C6  | `src/evaluation/evaluate.ts:227` `resolveRulePack(config.rulePack)` — **no `baseDir`**                   | Relative layer paths resolve against `process.cwd()`.                       | Already a latent inconsistency with C1; N layers multiplies it. Either thread a baseDir or document cwd-relative explicitly.                                                                                                                                    |
| C7  | `src/evaluation/evaluate.ts:244` `[...config.approvedTerms, ...pack.approvedTechnicalTerms]`             | As C4.                                                                      | As C4.                                                                                                                                                                                                                                                          |

### D. Rule execution (reads pack _content_)

| #   | File:line                                                                                                                                               | What it assumes                                                                                                                             | What has to change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `src/core/runner.ts:24` `readonly pack: RulePack` on `RunOptions`                                                                                       | One pack per run.                                                                                                                           | **Nothing**, if the merge yields a value satisfying `RulePack` (`types.ts:474-486`). This is the change's biggest piece of luck and should be defended deliberately.                                                                                                                                                                                                                                                                                                                                                                                                    |
| D2  | `src/core/runner.ts:51` `new Map(pack.rules.map(r => [r.ruleId, r]))`                                                                                   | `pack.rules` has at most one spec per `ruleId`.                                                                                             | **Silent last-wins on duplicates** (executed: `new Map([['a',1],['a',2]]).get('a') === 2`). If merge concatenates `rules` arrays instead of keying them, the effective spec is whichever layer happens to be later — no error, no notice. Merge must key `rules` by `ruleId`; this line is the reason.                                                                                                                                                                                                                                                                  |
| D3  | `src/core/runner.ts:57-65` `packSpec?.enabled`, `{...packSpec?.options, ...userConfig}`                                                                 | One spec supplies `enabled` and `options`.                                                                                                  | Consumes D2's output. Retraction semantics (`enabled:false` from a higher layer) land here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D4  | `src/core/runner.ts:79` `userConfig.severity ?? packSpec?.severity`                                                                                     | One pack severity.                                                                                                                          | As D3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D5  | `src/core/runner.ts:96-99`, `:139-146` `verifiedRuleStatus(packSpec.status, pack, trustedIds)`                                                          | The rule's status is verified against **the** pack's `metadata.id`.                                                                         | With layers, the rule spec and the identity that vouches for it come from _different_ layers. This function must take the **contributing layer's** identity, not the merged pack's. This is the sharpest coupling between my scope and the authority agent's.                                                                                                                                                                                                                                                                                                           |
| D6  | `src/core/runner.ts:110` `sourceRef: packSpec?.sourceRef ?? ''`                                                                                         | The citation travels with the spec.                                                                                                         | Must travel with the winning layer's spec, per D5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D7  | `src/core/rule.ts:18` `readonly pack: RulePack` on `RuleInput`                                                                                          | Rules see one pack.                                                                                                                         | Unchanged if merge yields a `RulePack`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D8  | `src/deterministic/rules/vocabulary.ts:54`, `:63`, `:68-70`                                                                                             | `pack.dictionary.unapproved` is deduplicated; entries sorted longest-first; `claimed` makes the **first** entry in sorted order win a span. | Duplicate `term` across layers → the survivor is decided by array order after a length sort (ties unspecified). The _other_ layer's `alternatives`/`safeSubstitution` are silently dropped. Merge must dedupe by term.                                                                                                                                                                                                                                                                                                                                                  |
| D9  | `src/deterministic/rules/vocabulary.ts:165`, `:172`                                                                                                     | Same, for `dictionary.preferred` keyed on `from`.                                                                                           | Same.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D10 | `src/deterministic/rules/vocabulary.ts:236-275` `noContractionsRule`                                                                                    | `pack.contractions` is deduplicated — **there is no `claimed` guard in this rule**.                                                         | **Duplicate `from` across layers emits duplicate diagnostics on the same span.** Both fixes then hit `resolveOverlappingFixes` (`runner.ts:256-262`): identical range+text is "not a conflict" but the second is still added to `conflicting`, so one diagnostic keeps its fix and the other gets `" (No automatic fix: another rule proposes an overlapping edit.)"` appended. Visible, wrong, and it will break the exact-message assertions in `test/e2e/textlint-tester.test.ts:88-108`. This is the most concrete merge-correctness requirement my scope produces. |
| D11 | `src/deterministic/rules/sentence-length.ts:28-30` `pack.limits.proceduralMaxGradeLevel` / `descriptiveMaxGradeLevel` / `sentenceReadabilityFloorWords` | Scalars — exactly one value each.                                                                                                           | Scalars cannot "merge"; they are last-layer-wins by construction. The spec must say so, and a test must pin which layer wins.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D12 | `src/deterministic/rules/structure-rules.ts:43` `pack.limits.maxSentencesPerProceduralStep`                                                             | As D11.                                                                                                                                     | As D11.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D13 | `src/deterministic/rules/candidate-rules.ts:331` `pack.limits.maxNounClusterLength`                                                                     | As D11.                                                                                                                                     | As D11.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### E. textlint adapter

| #   | File:line                                                                                           | What it assumes                                                                     | What has to change                                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | `src/textlint/adapter.ts:154-161` `{...sharedFile.config, ...shared, rules: mergedRules}`           | A **shallow** top-level spread; `rules` is the only key merged deeply.              | If the layered field is a **new** key, a `.ste-ai.json` setting `rulePack` and an inline `shared` setting `rulePacks` produce a config carrying **both**, with precedence decided by `resolveRulePack`, not by this merge — a config whose meaning depends on a resolution order nobody wrote down. Widening `rulePack` (B1) makes this a plain last-wins spread with no ambiguity. |
| E2  | `src/textlint/adapter.ts:48-51` `cacheKey(text, '*', config, baseDir)`                              | The cache keys on config **text**, not on the _contents_ of the pack file it names. | Already true for one pack; N layers multiplies the staleness surface (edit a layer file, get a cached analysis). Not introduced by this change, but it gets N times more likely. Call it out; do not fix it in this change.                                                                                                                                                         |
| E3  | `src/textlint/shared-config.ts:52-65` `loadSharedConfig` memoised by `baseDir`                      | One config file per baseDir, cached process-wide.                                   | Unchanged, but the same staleness note as E2 applies to layer files it references.                                                                                                                                                                                                                                                                                                  |
| E4  | `src/textlint/adapter.ts:192` `diagnostic.ruleStatus === 'normative' ? ... : diagnostic.ruleStatus` | The `[provisional]` message tag comes straight from `ruleStatus`.                   | Unchanged if D5 keeps producing a correct per-diagnostic status. This line is what `test/e2e/textlint-tester.test.ts` asserts on.                                                                                                                                                                                                                                                   |

### F. CLI

| #   | File:line                                                                                                                  | What it assumes                                                                           | What has to change                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `src/cli/main.ts:190-197` per-file `packAuthority` / `declaredAuthority` / `conformanceClaim`                              | One pack → one authority, one declared authority, one claim.                              | Follows A4/A5. `declaredAuthority` (`:191`, `analysis.pack.metadata.authority`) has no meaning for a merged pack without a provenance model.                                                                                |
| F2  | `src/cli/main.ts:218-220` `conformance: { claim: results[0]?.conformanceClaim, packAuthority: results[0]?.packAuthority }` | **The whole run's conformance block is taken from the first file.**                       | Latent single-pack reporting bug today (all files share one config so it happens to be right). With layers it stays right only by accident. `scripts/ci/assert-corpus-report.mjs:32-45` asserts against exactly this block. |
| F3  | `src/cli/main.ts:277-296` `listRules`                                                                                      | Enumerates `deterministicRules` and reports `r.meta.status` — **never touches the pack**. | **No change required.** This is why `check-rules-provisional.sh`'s hard-coded `14` is not at risk (see Fixture & corpus impact). Do not make `rules` pack-aware in this change.                                             |

### G. Scripts and CI

| #   | File:line                                                                                                                                                            | What it assumes                                                                                               | What has to change                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | `scripts/build-candidate-packets.mjs:51`, `:77` `const {resolveRulePack} = await distImport('rule-pack','loader.js'); const pack = resolveRulePack(config.rulePack)` | The exact `resolveRulePack` name and its `(spec)` positional signature, imported from **`dist/`** at runtime. | **This is `.mjs`, and `tsconfig.json:25` includes `scripts` but sets no `allowJs` — so it is not typechecked.** A signature change here fails at CI runtime (`scripts/ci/check-candidate-ground-truth.sh`), never at `npm run typecheck`. Highest-surprise row in the inventory. |
| G2  | `scripts/ci/check-candidate-ground-truth.sh` (runs G1, then `merge-candidate-verdicts.mjs --check`)                                                                  | Every candidate the linter emits under the default config still has a bound reviewer verdict.                 | Safe iff the default path is byte-identical. This script is the tripwire that proves it.                                                                                                                                                                                         |
| G3  | `scripts/ci/check-rules-provisional.sh:20` `node scripts/ci/assert-rules-provisional.mjs "$rules" 14`                                                                | Exactly 14 rules, all reporting `provisional`.                                                                | **Unchanged by layering** (see F3). Would only need reconciling if a rule is added/removed — which this change must not do.                                                                                                                                                      |
| G4  | `scripts/ci/assert-rules-provisional.mjs:34` `rules.filter(r => r.status !== 'provisional')`                                                                         | `status` is the rule's own `meta.status`.                                                                     | As G3.                                                                                                                                                                                                                                                                           |
| G5  | `scripts/ci/assert-corpus-report.mjs:32-45` `report.conformance.claim === 'none'` and `report.conformance.packAuthority === 'provisional'`                           | The default run reports the bundled pack's identity.                                                          | Safe iff default path unchanged **and** F1/F2 keep emitting the same two strings for a bundled-only run. If the authority model renames or restructures the conformance block, this script must be reconciled in the same PR.                                                    |
| G6  | `scripts/ci/check-exit-codes.sh` (0/1/2 contract over `fixtures/original/*.md`)                                                                                      | Default config produces ≥1 error-severity diagnostic on the corpus and none on `Remove the cover.`            | Safe iff default path unchanged. A merge bug that duplicates diagnostics (D10) does not flip an exit code, so this script will **not** catch it — `corpus.test.ts` and the e2e message assertions will.                                                                          |
| G7  | `.github/workflows/ci.yml:29-56` step order: typecheck → lint → `build:clean` → `test:coverage` → validate-fixtures → exit-codes → rules-provisional → ground-truth  | `dist/` freshness matters (G1 and `check-candidate-ground-truth.sh` refuse a stale build).                    | No change, but note every new `scripts/ci` assertion must be added here or it does not run.                                                                                                                                                                                      |

### H. Tests that encode the current shape

| #   | File:line                                                                                                                          | What it assumes                                                                                              | What has to change                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H1  | `test/architecture/module-boundaries.test.ts:16-34` `ALLOWED` map; `:82-87` "every top-level module is declared in the allow list" | The set of `src/` top-level directories is fixed, and `rule-pack: ['core']` (`:23`).                         | If merge code lands in a **new** top-level module, this test fails until `ALLOWED` gains a row — and every consumer module (`deterministic`, `analysis`, `textlint`, `cli`, `evaluation`, `fixture-tools`, `semantic`) needs the new name added. **Strong argument for keeping merge inside `src/rule-pack/`**, which also keeps it restricted to importing `core` only. |
| H2  | `test/unit/rules.test.ts:36`, `:658` `pack: provisionalRulePack`                                                                   | Tests construct `RunOptions` with a literal pack, bypassing resolution entirely.                             | No change needed — and this is exactly the seam that lets a merged pack be tested by handing `runDeterministicRules` a merge result.                                                                                                                                                                                                                                     |
| H3  | `test/unit/rules.test.ts:678-679` "every shipped rule declares provisional status"                                                 | Rule `meta.status`, not pack status.                                                                         | No change (mirrors F3/G3).                                                                                                                                                                                                                                                                                                                                               |
| H4  | `test/unit/fix-safety.test.ts:206`, `test/unit/pipeline-smoke.test.ts:38`                                                          | As H2.                                                                                                       | As H2.                                                                                                                                                                                                                                                                                                                                                                   |
| H5  | `test/e2e/textlint-tester.test.ts:88-213`                                                                                          | Exact diagnostic message strings including the `[provisional]` tag and the `(No automatic fix: …)` suffixes. | **No change expected — and that is the point.** These are the highest-value regression net for D10 (duplicate contraction entries) and E4 (status tag). Any diff here during the rollout is a merge bug, not a test that needs updating.                                                                                                                                 |
| H6  | `test/e2e/textlint-run.test.ts:104` `toContain('[deterministic-violation][provisional]')`                                          | As H5.                                                                                                       | As H5.                                                                                                                                                                                                                                                                                                                                                                   |
| H7  | `test/e2e/example-config.test.ts:66-73` `steAiConfigSchema.safeParse(examples/.ste-ai.json)`                                       | The shipped example validates.                                                                               | Because the schema strips unknown keys (B2), this test would **pass** on an example using a mistyped layered key. If the example gains a layered config, this test must be strengthened to assert the parsed value actually _contains_ the layers, not merely that parsing succeeded.                                                                                    |
| H8  | `test/integration/shared-config-merge.test.ts:39-63`                                                                               | Pins that `getAnalysis`'s shallow spread preserves a file-set field the inline `shared` never mentions.      | Directly relevant to E1. Gains a case: a file-set pack layer list must survive an inline `shared` that never mentions packs.                                                                                                                                                                                                                                             |
| H9  | `test/fixtures/corpus.test.ts` (see Fixture & corpus impact)                                                                       | Default-config linter behaviour over 18 fixtures.                                                            | No change expected; it is the tripwire.                                                                                                                                                                                                                                                                                                                                  |

---

## Back-compatibility analysis

### What each existing config does after the change

| Existing config                                                                          | Today                                                                                                   | Required after                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `rulePack` key at all (this is `examples/.ste-ai.json` — it has none)                 | `loader.ts:53` returns `provisionalRulePack` by identity                                                | **Byte-identical.** Must return `provisionalRulePack` itself, not a one-element merge of it. A merge that clones/normalises could reorder `dictionary.unapproved` and change which term wins a span at `vocabulary.ts:68-70`. Identity return is the safe contract.        |
| `"rulePack": "./pack.json"` (`docs/configuration.md:78`, `docs/rule-pack-import.md:116`) | `loader.ts:54` → `loadRulePackFromFile(spec, baseDir)`; the file **replaces** the bundled pack entirely | Must remain a **replace**, not become "bundled + this". Turning the historical single-pack meaning into an implicit extend would change behaviour for every existing user: bundled unapproved terms would come back for someone who deliberately supplied a narrower pack. |
| `{ rulePack: myPackObject }` programmatically (`docs/rule-pack-import.md:122`)           | `loader.ts:55` → `parseRulePack(spec, 'inline configuration')`                                          | Same: replace.                                                                                                                                                                                                                                                             |
| `rulePack` with an invalid pack                                                          | `RulePackError` naming the origin and field paths (`loader.ts:21`)                                      | Must still throw, still name the origin. With layers the message must additionally name the layer.                                                                                                                                                                         |
| `rulePack: ["a.json","b.json"]`                                                          | **Rejected** by the union (`config.ts:124`) — executed against zod 4.4.3: `Invalid input`               | This is the free lunch: an array under the existing key is already a loud error, so old versions reject a new-style config instead of misinterpreting it.                                                                                                                  |
| `trustedRulePackIds: ["acme-ste-2026"]` with a single normative pack                     | `verifiedAuthority` → `normative` (`loader.ts:97`); diagnostics tagged `[normative]` (`adapter.ts:192`) | Must still reach `normative`. A one-layer config must not be capped at `supplementary` by a stricter multi-layer trust rule. This is the authority agent's contract; my requirement on them is: **single-layer trust behaviour is a fixed point.**                         |

### The tests that currently pin this — and the hole

**They do not exist.** Verified by grepping the entire `test/` tree for `resolveRulePack`,
`loadRulePackFromFile`, `parseRulePack`, `RulePackError`, `rulePackSchema`, `verifiedAuthority`,
`packPermitsConformanceClaim`: **no matches**. The only `rule-pack` references in `test/` are three
`provisionalRulePack` imports (`rules.test.ts:7`, `fix-safety.test.ts:8`, `pipeline-smoke.test.ts:6`)
and the module-boundary allow-list.

What _indirectly_ pins the `undefined → provisionalRulePack` default:

- `test/e2e/textlint-tester.test.ts:88-213` — exact messages that depend on the bundled pack's
  `contractions`, `dictionary.unapproved` and `safeSubstitution` flags.
- `test/fixtures/corpus.test.ts:124-177, 187-283, 327-341` — every call is
  `analyseTextDeterministic(text)` with no config, i.e. the default pack.
- `scripts/ci/check-exit-codes.sh` + `assert-corpus-report.mjs:36` — asserts the emitted
  `packAuthority` is `provisional`.

What pins **nothing**: the `string` branch (`loader.ts:54`), the object branch (`:55`), the JSON
parse failure (`:38`), the read failure (`:32`), the schema failure (`:21`), and both trust
functions (`:76-98`). Those six behaviours are what a refactor of `resolveRulePack` is most likely
to break, and today nothing would notice.

> **This is the single hardest prerequisite in this document.** Stage 0 below exists only to close
> it, and no layering code should merge before it does.

---

## Silent-meaning-change risks

Configs whose meaning changes _without an error_. This is the class the task asks me to find or to
state clearly I did not.

**Found — four. Ordered by severity.**

1. **A new config key is silently discarded by older versions.** `steAiConfigSchema`
   (`config.ts:119`) is a bare `z.object` with no `.strict()`; zod 4.4.3 strips unknown keys —
   executed: `z.object({a:z.string().optional()}).parse({a:'x', rulePacks:[1,2]})` →
   `{"a":"x"}`. So a config authored for the layered version, run against any older installed
   version (a pinned CI image, a `npx` cache, a monorepo package that hasn't bumped), silently
   resolves to the **bundled provisional pack** and lints clean-ish against nothing the operator
   intended. The operator sees diagnostics, sees a `[provisional]` tag they may already be used to,
   and has no signal. _Mitigation:_ widen the existing `rulePack` key instead of adding a sibling —
   the existing union rejects arrays (executed), so old versions fail loud. If a new key is
   unavoidable, ship a `.strict()`-equivalent or an explicit unknown-key notice **one release
   before** the key exists, so the version that must reject it already can.

2. **`rulePack` reinterpreted from "replace" to "extend".** No error, no diff in config text, a
   different effective vocabulary. Every existing single-pack user who deliberately supplied a
   _narrower_ pack silently gets the bundled unapproved list back. _Mitigation:_ the legacy
   singular form is defined as `[{ pack: <spec>, mode: 'replace' }]`, pinned by test, and stated in
   `docs/rule-pack-import.md`.

3. **Both keys present after a shallow adapter merge.** `adapter.ts:154-161` spreads
   `{...sharedFile.config, ...shared}` at the top level only. With a new sibling key, a
   `.ste-ai.json` carrying `rulePack` and an inline textlint `shared` carrying the layered key
   produce a config with **both** — and precedence is then decided inside `resolveRulePack`, not by
   the documented option-precedence rule in `docs/configuration.md:151-159`. Nothing errors.
   _Mitigation:_ same as (1) — one key. If two keys must coexist, `resolveRulePack` must throw when
   both are set rather than pick.

4. **Duplicate entries across layers changing which entry wins, silently.** Three distinct shapes,
   all verified in the rule code: `pack.rules` duplicates are last-wins via `Map`
   (`runner.ts:51`, executed: `new Map([['a',1],['a',2]]).get('a') === 2`); `dictionary.unapproved`
   and `.preferred` duplicates are decided by post-sort array order plus the `claimed` first-wins
   guard (`vocabulary.ts:64,68-70,172`); `contractions` duplicates are **not** deduplicated at all
   and produce two diagnostics on one span (`vocabulary.ts:236-275` — no `claimed` guard).
   Only the third is loud (it changes visible output and will break `textlint-tester.test.ts`); the
   first two are silent. _Mitigation:_ merge must key `rules` by `ruleId`, `unapproved`/`approved`
   by `term`, `preferred`/`contractions` by `from`, and must emit a `RunNotice` when a later layer
   overrides an earlier one's entry. The notice is what turns a silent override into an auditable
   one.

**How I searched.** (a) Full-repo grep for `rulePack|RulePack|rule-pack|resolveRulePack|
provisionalRulePack|parseRulePack|loadRulePackFromFile|trustedRulePackIds` across `*.ts/*.mjs/*.js/
*.md/*.sh/*.yml/*.json`, excluding `node_modules`, `dist/`, `package-lock.json` — 86 hits, all
triaged into the inventory above. (b) Full-repo grep for `pack.` field reads outside
`src/rule-pack/` to find every content consumer (13 sites, rows D1-D13, C4, C7, F1). (c) Read every
consumer function body rather than the grep line. (d) Executed zod 4.4.3 to check unknown-key
stripping and array rejection rather than trusting documented defaults.

**Where I stop.** I did **not** run the test suite or coverage (`node_modules` absent in this
worktree), so I cannot state which loader branches v8 currently counts as covered — only that no
test _names_ them. I also did not enumerate downstream consumers outside this repository; the
`package.json` `exports` map (`./rule-pack`, `./core`, `./analysis`) means such consumers exist in
principle and any signature change is semver-visible to them.

---

## Test strategy

Conventions observed in `test/`: vitest with `globals: true` (`vitest.config.ts:10`), explicit
`import { describe, expect, it } from 'vitest'` in project-owned tests, `mkdtempSync(join(tmpdir(),
...))` + `afterEach` cleanup for filesystem cases (`shared-config-merge.test.ts:29-37`), long
`/** … */` block comments stating _why_ a test exists and what regression it guards
(`shared-config-merge.test.ts:7-24`), and cache-clearing seams called in `beforeEach`
(`clearSharedConfigCache`, `clearAnalysisCache`).

Coverage thresholds are enforced only under `--coverage` (`vitest.config.ts:15-35`: statements 91,
branches 81, functions 91, lines 94) and CI runs `test:coverage` (`ci.yml:45`). New unreached
branches in `src/rule-pack/` will pull these down, so tests are not optional for the thresholds
either.

### Must exist before ANY layering code merges (Stage 0)

**New file: `test/unit/rule-pack-loader.test.ts`** — characterisation of today's behaviour, written
against the current implementation and expected to pass unchanged at the baseline commit.

1. no `rulePack` → `resolveRulePack(undefined)` **is** `provisionalRulePack` (identity, `toBe`, not
   `toEqual`) — pins `loader.ts:53`.
2. string spec → loads and validates a temp-dir JSON file; relative path resolves against the
   supplied `baseDir`, absolute path ignores it — pins `loader.ts:26-27,54`.
3. object spec → `parseRulePack(spec, 'inline configuration')`, defaults applied
   (`alternatives: []`, `safeSubstitution: false`, `enabled: true` from `schema.ts:41,47,88`).
4. missing file → `RulePackError` mentioning the resolved path (`loader.ts:32`).
5. invalid JSON → `RulePackError` mentioning "not valid JSON" (`loader.ts:38`).
6. schema failure → `RulePackError` listing the failing field path (`loader.ts:21`).
7. **a supplied pack replaces the bundled one** — a pack with an empty `contractions` array produces
   no `no-contractions` diagnostics on text the bundled pack flags. This is the test that makes
   "replace, not extend" a pinned fact rather than a convention.
8. `verifiedAuthority` / `packPermitsConformanceClaim` truth table: normative+untrusted →
   `supplementary`/`false`; normative+trusted → `normative`/`true`; normative+trusted+claim `none`
   → `packPermitsConformanceClaim` `false`; provisional → unchanged (`loader.ts:80-98`).

**Also Stage 0:** a case in `test/e2e/example-config.test.ts` asserting the _parsed_ example config
retains its pack configuration, not merely that `safeParse` succeeded — closing H7.

### Required for the layering change itself

**`test/unit/rule-pack-layers.test.ts`** (new) — pure merge behaviour, constructing packs as
literals (the `provisionalRulePack`-as-literal convention of `rules.test.ts:36`):

| Case                          | Asserts                                                                                                                                                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **two-layer extend**          | union of `dictionary.unapproved`; both layers' terms fire; neither layer's `safeSubstitution` is coerced                                                                                                                                                         |
| **three-layer ordering**      | a term defined in layers 1 and 3 resolves to layer 3's `alternatives`; a scalar `limits.proceduralMaxGradeLevel` set in all three resolves to the last (pins D11-D13's last-wins)                                                                                |
| **replace-then-extend**       | layer 2 `replace` discards layer 1 entirely; layer 3 `extend` adds only to layer 2's result — proves `replace` is not "clear then re-add bundled"                                                                                                                |
| **retraction**                | a higher layer's retraction of a lower layer's term removes it from `pack.dictionary.unapproved` **and** from linter output; retracting a term that does not exist is an explicit error or an explicit notice, never a silent no-op (syntax per the merge agent) |
| **conflict detection**        | two layers disagreeing on the same key produce the designed conflict outcome, and the _notice_ naming both layers is asserted — a silent winner is a failing test                                                                                                |
| **`rules[]` keyed by ruleId** | two layers each declaring `sentence-length-procedural` yield exactly **one** spec in the merged `rules` array (guards D2's `Map` last-wins from ever being reached)                                                                                              |
| **contractions dedup**        | two layers each declaring `don't` produce exactly **one** diagnostic on `Don't do that.` — the direct regression test for D10                                                                                                                                    |
| **back-compat equivalence**   | `resolveRulePack(undefined)` and `resolveRulePack(<single-layer form naming only the bundled pack>)` produce deep-equal packs                                                                                                                                    |

**`test/integration/rule-pack-layering.test.ts`** (new) — resolution through real files:

- layers given as relative paths resolve against `baseDir` (mirrors C1); one layer relative and one
  absolute in the same list;
- a broken layer at position 2 of 3 throws a `RulePackError` naming **which** layer and does not
  silently fall back (defends `docs/rule-pack-import.md:29-30`);
- the same layer listed twice is either idempotent or an error — pinned either way, not left open;
- deep-equal output for the same layer list resolved twice (determinism, matching the runner's own
  determinism promise at `runner.ts:38-43`).

**`test/integration/shared-config-merge.test.ts`** (existing, gains cases):

- a layer list set in `.ste-ai.json` survives an inline `shared` option that never mentions packs
  (the exact shape of the existing test at `:39-63`);
- an inline `shared` layer list replaces the file's, and the _effective_ pack proves it — closing
  the E1 ambiguity by making the precedence a tested fact.

**`test/unit/rules.test.ts`** (existing): one case constructing `RunOptions` with a **merged** pack
containing duplicate-keyed inputs, asserting the winning `severity`/`sourceRef`/`status` reach the
diagnostic (D4-D6).

**`test/architecture/module-boundaries.test.ts`** (existing): if merge lands outside
`src/rule-pack/`, `ALLOWED` (`:16-34`) must gain the module and every consumer row must be updated
in the same PR — the test at `:82-87` fails loudly otherwise. Preferred: land it inside
`src/rule-pack/` and touch nothing.

**`test/e2e/textlint-tester.test.ts` and `test/e2e/textlint-run.test.ts`: expected to be
byte-unchanged.** Any diff to these during the rollout is evidence of a merge defect, not a test in
need of updating. State that in the PR description so a reviewer does not "fix" them.

### CI assertion scripts

- If the layered config becomes the shipped example, add a `scripts/ci/` check that a
  layered example resolves and produces the expected pack identity — CI scripts are assertions
  separate from `npm test` (`ci.yml:50-56`), and a layering regression that only shows through the
  CLI would otherwise go unnoticed.
- Any new script must be added to `.github/workflows/ci.yml` explicitly; nothing globs
  `scripts/ci/*`.

---

## Fixture and corpus impact

**Read:** `docs/fixtures.md` (esp. `:145-196`) and `test/fixtures/corpus.test.ts` in full.

### What is NOT affected (and why, precisely)

- **The exact class balance.** Since this analysis was written, the two asserted aggregates
  (`{violation: 5, 'non-violation': 100, undecidable: 0}` and `noun-cluster-candidate` →
  `{violation: 0, total: 24}`) have been replaced by a record-by-record comparison of
  `annotation.candidateAdjudications` against `fixtures/verdicts/`. The conclusion is unchanged and
  applies to the replacement: both sides are static JSON, **the linter is not consulted**, and
  layering cannot move them. Same for the 105/5/100 table in `docs/provisional-rules.md`.
- **`scripts/ci/check-rules-provisional.sh:20`'s hard-coded `14`.** It lints the output of
  `ste-ai rules --json`, which `listRules` (`cli/main.ts:277-296`) builds from the
  `deterministicRules` registry and `r.meta.status` — **never from the pack**.
  `assert-rules-provisional.mjs:34` checks that same `meta.status`. Layering adds no rule and
  changes no `meta.status`, so **neither the count nor the provisional assertion needs
  reconciling**, provided the change does not make `rules` pack-aware. It should not.

### What IS at risk — all of it conditional on the default path

Every one of the following calls `analyseTextDeterministic(text)` **with no config**, i.e. the
`loader.ts:53` default:

| Assertion                                                     | Line                     | Breaks if                                                                              |
| ------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| every candidate the linter emits has a bound reviewer verdict | `corpus.test.ts:327-341` | the default pack changes at all — new/moved candidates orphan the ground truth         |
| at least half the originals produce ≥1 diagnostic             | `:124-132`               | the default pack loses entries                                                         |
| no diagnostic inside a code fence                             | `:134-151`               | (structural; pack-insensitive, but runs the linter)                                    |
| every diagnostic points at non-empty source                   | `:153-161`               | duplicate/zero-width entries from a merge                                              |
| no fix inside an admonition                                   | `:163-177`               | a merge changes `safeSubstitution`                                                     |
| violations never increase after a rewrite                     | `:187-197`               | duplicate diagnostics (D10) inflate the _original_ and the _compliant_ count unequally |
| accepted changes reduce the specific `(ruleId, quote)` count  | `:240-256`               | duplicates change counts on both sides                                                 |
| annotated expected diagnostics actually fire                  | `:258-277`               | a merge drops an entry                                                                 |
| `scripts/ci/check-candidate-ground-truth.sh`                  | (whole script)           | same as `:327-341`, via `dist/`                                                        |

**Conclusion:** the corpus needs **no reconciliation** if the default path returns
`provisionalRulePack` by identity. If a merge defect changes it, `corpus.test.ts:327-341` and
`check-candidate-ground-truth.sh` fail — which is the design intent of both
(`docs/fixtures.md:179-180`). The correct posture is therefore _not_ to update the fixture
expectations, but to treat any movement in them as a stop-the-line signal.

**One documentation dependency:** the "Corpus tests" table in `docs/fixtures.md` ("violation count
never increases after a rewrite", `:159-171`) describes corpus assertions accurately today. They stay accurate. No fixture, manifest, annotation or verdict file needs to change.

---

## Documentation reconciliation list

Per `CLAUDE.md`, this list is part of the work, not a follow-up. Quoted text is verbatim at the
baseline commit.

### Must change

**`docs/configuration.md`**

- `:70` — "4. built-in defaults — bundled provisional pack, semantic analysis **off**."
  → still true, but must say the bundled pack is _layer 0_, not _the_ pack.
- `:76-78` —

  > `// Path to an authorised rule pack, or an inline pack object.`
  > `// Omit to use the bundled provisional pack. See docs/rule-pack-import.md.`
  > `"rulePack": "./ste-rule-pack.json",`

  The whole shipped snippet is single-pack. Needs a layered example plus an explicit statement that
  the singular string form still means _replace_.

- `:151-159` — the "Option precedence" section lists three layers for _rule options_ and says
  "Layers are merged key by key". Pack layering is a **different** layering with a **different**
  order (bundled → organisation → department → product → tech stack → industry → locale). Two
  unrelated things called "layers" one page apart is a documentation defect waiting to happen; the
  new section must be explicitly distinguished, exactly as `:161` already distinguishes suppression
  ("Inline suppression is not one of these layers").
- `:249` — "`console.log(full.pack.metadata.conformanceClaim); // 'none' for the bundled pack`" —
  needs updating if `AnalysisResult` gains a layer list (C3).

**`docs/rule-pack-import.md`**

- `:3-5` —

  > "This is the **only** supported route by which normative controlled-language data enters the
  > package. No rule hard-codes vocabulary: every word list, term mapping and numeric limit is read
  > from the active pack"

  "the active pack" (singular) is the exact phrase that goes stale.

- `:29-30` — "A pack that fails validation throws `RulePackError` with the failing field paths. The
  linter never falls back to the provisional pack silently." — must be restated per **layer**: a
  failing layer must not be silently skipped either, which is a stronger promise than the current
  sentence makes.
- `:113-126` — the entire "Wiring it in" section:

  > `{ "rulePack": "/etc/acme/ste-rule-pack.json" }`
  > … `await analyseText(source, { config: { rulePack: myPackObject } });`
  > "Relative paths resolve against the textlint config base directory, or against `baseDir` for the
  > programmatic API."

  Needs the layered form beside the legacy form, and must say per-layer relative resolution.

- `:129-137` — the "What changes when you supply a normative pack" table. Two problems.
  (a) It is binary (bundled vs normative) and layering makes it a spectrum.
  (b) **It is already stale**: the row

  > `| `packPermitsConformanceClaim()` |`false`|`true`if`conformanceClaim !== 'none'` |`

  omits the `trustedRulePackIds` requirement that `src/rule-pack/loader.ts:82` actually enforces.
  Same defect at `:51`: "`// `packPermitsConformanceClaim()` returns true only for 'normative' + not
'none'.`" Fix both while the table is open.

- `:151-155` — "Extending the schema … extend `src/rule-pack/schema.ts` and the consuming rule
  together, and add a test that the new field actually changes behaviour." — still correct, and it
  is the standing instruction the layering change itself must satisfy.

**`README.md`**

- `:74-77` —

  > "`rulePack` (a path to a JSON file, or an inline object) and `approvedTerms` in the shared config
  > let a repository supply its own vocabulary on top of the bundled provisional pack"

  "on top of" is **already misleading** at the baseline commit — `loader.ts:54-55` _replaces_ the
  bundled pack; only `approvedTerms` is additive (`analyse.ts:255`). Layering is the moment to make
  this sentence honest instead of merely updated.

- `:247-249` —

  > "`src/rule-pack/` is the single import boundary. No rule hard-codes vocabulary: limits, word
  > lists, term mappings, contractions and per-rule authority all come from the active pack."

  "the active pack" again.

- `:251-252` — "A pack cannot add a rule, cannot bypass the autofix gate, and cannot make the linter
  print a conformance claim." — still true for a _layer_; restate in layer terms so it is not read
  as applying only to a single pack.
- `:104-107` — the roadmap paragraph about "Resolving a rule pack from a package name or a URL with
  a required integrity digest, so an organisation shares one vocabulary across repositories"
  (issue #3) — this change partly delivers the _intent_; the paragraph must say what is now real and
  what is still proposed, or it becomes a false roadmap.

**`docs/architecture.md`**

- `:10` — "`rule-pack       → core                    schema, loader, bundled provisional pack  [IMPORT BOUNDARY]`"
  → add the merge component to the description if it lands here (and it should — see H1).
- `:231-235` —

  > "Per-document configuration that textlint cannot express per rule (rule pack, semantic service,
  > autofix policy, protected terminology) is read from a shared file … Option layers are merged key
  > by key, lowest first: shared file, `shared` override, the rule's own textlint options."

  Same "two meanings of layer" collision as `configuration.md:151-159`; disambiguate here too.

**`docs/DISCLAIMER.md`**

- `:37-38` — "the active rule pack's `metadata.authority` and `metadata.conformanceClaim`, which the
  bundled pack sets to `provisional` and `none` respectively." — "the active rule pack's" is
  singular, and this is the _disclaimer_, where imprecision costs most. Must state what authority a
  layered stack reports.
- `:40` — "`packPermitsConformanceClaim()` returns `false` for the bundled pack, and the CLI prints
  …" — follows the authority model.
- `:62-66` — "an authorised rule pack can supply normative limits … Doing so changes the
  `ruleStatus` on diagnostics to whatever the pack declares." — "whatever the pack declares" is
  already loose (`runner.ts:139-146` caps an untrusted pack at `supplementary`) and gets looser with
  layers.

### Should be checked, likely a one-line touch

- `docs/rule-authoring.md:94` — "| a limit or a word list | `pack.limits`, `pack.dictionary` | never
  hard-code vocabulary |" — still correct (rules see the merged pack), but worth a sentence saying a
  rule never sees layers, only the merged result. That is a useful invariant to write down.
- `docs/extension-roadmap.md:92-95` — "ship such a pack **separately, under its own licence, loaded
  via `rulePack`**, never bundled" — layering makes this _easier_ and the wording should say so.
- `docs/implementation-report.md:45` — "| Rule pack | Zod schema, loader, bundled provisional pack —
  the single import boundary for licensed data |" — historical record; check whether this document
  is maintained as current or as a dated report before editing (`docs/architecture.md:238-240` shows
  this repo does keep deliberately-historical sections, marked as such).

### Explicitly **not** stale

- `docs/fixtures.md` — no pack-dependent claim (verified by grep: the only "pack" hits are
  unrelated). No change.
- `docs/provisional-rules.md:262-268` (the 105/5/100 table) — annotation-derived, not linter-derived.
  No change.
- `docs/diagnostic-policy.md`, `docs/suppression.md`, `docs/semantic-evaluators.md`,
  `docs/llama-cpp-setup.md` — no single-pack claim.

---

## Staged rollout plan

Design constraints: main green at every step; each stage independently reviewable and revertible;
no stage both changes behaviour _and_ changes public API. Per `CLAUDE.md`, each PR opens as a draft,
is un-drafted for `chatgpt-codex-connector` review, and waits a real interval before merge — never
un-draft and merge in one action.

### Stage 0 — Characterisation tests only. **Ships first.**

`test/unit/rule-pack-loader.test.ts` (8 cases above) + the strengthened
`example-config.test.ts` case. **No `src/` change.**

_Why first:_ the back-compat surface is currently unpinned (nothing in `test/` imports the loader).
Every later stage's safety argument is "the characterisation tests still pass" — that sentence is
worthless until they exist. This stage is also the only one that is trivially correct to review: if
it passes at the baseline commit, it describes today's behaviour truthfully.

_Green because:_ additive tests over unchanged code. Also lifts `src/rule-pack/loader.ts` branch
coverage, giving headroom under `vitest.config.ts:15-35`.

### Stage 1 — Merge module, unreachable from production.

Add the merge implementation inside `src/rule-pack/` (deliberately, to avoid the
`module-boundaries.test.ts:82-87` allow-list change and to keep the `rule-pack → core` restriction
at `:23`). Add `test/unit/rule-pack-layers.test.ts` in full. **Nothing calls it.**

_Why second:_ the merge algorithm is the other agent's design and the part most likely to need
iteration. Landing it inert means its review is about correctness, not about blast radius, and a
revert is a file deletion.

_Green because:_ new code, new tests, zero production call sites. `resolveRulePack` untouched.

### Stage 2 — Config shape, accepted and ignored.

Widen `rulePack` in `src/core/config.ts:124` to accept the layered form **in addition to**
string/object. Parse it. Do **not** consume it yet — or consume it only when it names exactly one
layer, which is provably identical to today. Update `test/e2e/example-config.test.ts`.

_Why third and why separate:_ this is the semver-visible surface (`package.json` `"./core"` export)
and the silent-meaning-change epicentre. It deserves a review of its own. Splitting it from Stage 3
also means the version that _rejects_ a malformed layered config ships before the version that
_acts_ on a valid one — which is what protects a half-upgraded fleet.

_Green because:_ a widened union accepts a strict superset of today's inputs; every existing config
parses identically.

### Stage 3 — Wire it up. **The only behaviour-changing stage.**

`resolveRulePack` consumes layers; `src/analysis/analyse.ts:244` and `src/evaluation/evaluate.ts:227`
pass them; `scripts/build-candidate-packets.mjs:51,77` updated in the **same PR** (it is `.mjs` and
not typechecked — `tsconfig.json:25` has no `allowJs` — so nothing else will catch it);
`test/integration/rule-pack-layering.test.ts` and the `shared-config-merge.test.ts` additions land
here.

_Green because:_ Stage 0's characterisation tests prove the legacy paths are unmoved; `corpus.test.ts`
and `check-candidate-ground-truth.sh` prove the default path is unmoved; `textlint-tester.test.ts`
proves the message surface is unmoved. **Reviewer instruction to state in the PR body:** a diff in
`test/e2e/textlint-tester.test.ts` or in `test/fixtures/corpus.test.ts` expectations means a merge
defect, not a test needing an update.

_Revert:_ one PR revert restores single-pack resolution; Stages 1 and 2 remain harmlessly in place.

### Stage 4 — Authority and provenance across layers.

The other agent's model applied to `loader.ts:76-98`, `runner.ts:96-99,139-146`,
`analyse.ts:292,607`, `cli/main.ts:190-197,217-219`. Reconcile
`scripts/ci/assert-corpus-report.mjs:32-45` **in this PR** if the conformance block's shape changes.

_Why after Stage 3:_ authority is where "which layer vouches for this rule" (D5) becomes unavoidable,
and it is much easier to reason about once merged packs actually exist and are tested. Splitting it
also keeps the highest-stakes change (what the tool is allowed to _claim_) in a PR that changes
nothing else.

### Stage 5 — Documentation reconciliation.

Every item in the list above, including the two **already-stale** items found during this analysis
(`rule-pack-import.md:51,135` omitting `trustedRulePackIds`; `README.md:74-75` saying "on top of"
where the code replaces).

_Why last, and why it is still in scope:_ `CLAUDE.md` requires docs to be reconciled as part of the
work, not as a follow-up. Landing them as a final PR — rather than smearing them across Stages 2-4 —
keeps each behaviour PR small and lets the docs be written once against the finished behaviour
rather than three times against moving targets. This stage is **not optional** and the work is not
done until it merges.

_Risk of putting it last:_ main is briefly correct-but-under-documented between Stage 3 and Stage 5.
Acceptable only if Stage 5 is opened as a draft at the same time as Stage 3, so it cannot be
forgotten. If that discipline is doubted, fold Stage 5's `rule-pack-import.md` and `configuration.md`
edits into Stage 3 instead and keep only the roadmap/README prose for last.

---

## Residual risks

Things that could go wrong which the tests above would **not** catch.

1. **Merge is correct but non-deterministic across platforms.** The merge output feeds
   `vocabulary.ts:64` (`sort((a,b) => b.term.length - a.term.length)`) — a comparator with ties, and
   `Array.prototype.sort` stability preserves _input_ order for ties. If the merge builds its output
   from a `Map`/`Set` whose insertion order varies with layer file read order (e.g. a
   `Promise.all` over layer loads), two runs can differ in which of two equal-length terms claims a
   span at `:68-70`. The corpus tests would only catch this if a fixture happens to contain such a
   tie. **Mitigation:** merge must sort its outputs by a total order (term, then source layer index)
   before returning, and a test must assert deep equality across two independent resolutions.

2. **Cache staleness multiplied.** `adapter.ts:48-51` keys the analysis cache on config _text_, not
   on the _contents_ of the pack files it names. Editing a layer file in an editor's long-lived
   textlint server yields stale diagnostics with no signal. True today for one file; N times more
   likely with N layers, and much harder for a user to diagnose ("I edited the department pack and
   nothing changed"). No test can catch it — the tests each start a fresh process. **Mitigation:**
   document it; consider hashing resolved pack content into the cache key in a later change. Do not
   fix it in this rollout.

3. **`baseDir` divergence becomes a correctness bug.** `analyse.ts:244` passes
   `options.baseDir ?? process.cwd()`; `evaluate.ts:227` passes **nothing**, so it uses
   `process.cwd()`. With one pack an operator notices immediately ("file not found"). With layers,
   a _partially_ resolvable list could plausibly be designed to skip or warn — at which point the
   evaluation harness silently measures against a different pack stack than the linter uses, and
   every number it reports is wrong in a way no assertion checks. **Mitigation:** a failing layer
   must be fatal, never skipped (this is the strengthened reading of
   `docs/rule-pack-import.md:29-30`), and `evaluate.ts` should take an explicit baseDir.

4. **Licence and trust aggregation across layers.** Each `RulePack` carries one `licence` and one
   `notice` (`schema.ts:26,30`). A merged pack has N. Nothing in the codebase currently surfaces
   `licence` or `notice` in output at all (grep: no consumer outside the schema/type), so a merge
   that drops them loses an audit trail **without any test failing** — the field is validated on the
   way in and never read on the way out. Given this repo's posture on provenance
   (`docs/DISCLAIMER.md`, and the "How the adjudication was run" section `docs/fixtures.md` gains with
   #59), silently losing per-layer licence text is a real harm that the test suite is structurally incapable of detecting. **Mitigation:** the
   provenance model must retain per-layer `licence`/`notice`, and a test must assert they survive
   the merge even though nothing consumes them yet.

5. **Performance and the `readFileSync` path.** `loadRulePackFromFile:30` is synchronous, and
   `analyseTextDeterministic` is documented as "Never performs I/O beyond reading the rule pack"
   (`analyse.ts:279`). Seven layers means seven synchronous reads plus seven zod parses per
   resolution — and `resolveRulePack` is called **per `analyseText` invocation** (`analyse.ts:244`),
   not once per process. The adapter's analysis cache hides this for textlint, but the CLI resolves
   per file (`cli/main.ts:161-183` loops files, each calling `analyseText`). A 500-file lint would
   do 3500 file reads and 3500 schema validations. No test measures this; `testTimeout: 20_000`
   (`vitest.config.ts:11`) is generous enough to hide it. **Mitigation:** memoise resolved layers by
   (absolute path, mtime/size) inside the loader, and say so in the docs.

6. **Zod default application on every layer.** `schema.ts:41,47,54,88,97-103` apply `.default()` to
   `alternatives`, `safeSubstitution`, `enabled` and every array. A layer that _omits_ a field gets
   the default **as if it had stated it**. A merge that treats "present" as "wins" therefore lets a
   higher layer silently reset a lower layer's `safeSubstitution: true` to `false` merely by
   mentioning the term. Post-parse, "omitted" and "explicitly default" are indistinguishable. This
   is a genuine information loss at the schema boundary that a merge test written against
   _post-parse_ objects cannot detect, because both inputs look identical. **Mitigation:** the merge
   must operate on pre-default input where it matters, or the schema must drop defaults for
   layer-fragment parsing. Flag to the merge and config-shape agents — this is the one place where
   my scope and theirs genuinely cannot be separated.

7. **Nobody is a real multi-layer user yet.** Every layer beyond "bundled + one org pack" will be
   exercised first by tests written by the people who designed it. The corpus contains no layered
   fixture and there is no dogfooding path — this repo lints its own docs with the default config.
   The first real seven-layer stack will find things this plan did not. **Mitigation:** ship the
   layered form as documented-but-new for one release, and add a real layered example under
   `examples/` (covered by `example-config.test.ts`) so at least one non-trivial stack is executed
   by CI on every commit.

8. **An unverified claim I am deliberately flagging.** I did not execute the test suite, so
   "main is green at the baseline commit" is an assumption, not a measurement. If it is not green,
   the Stage 0 argument ("characterisation tests pass unchanged") is unsound and the whole plan
   needs re-basing. **First action for whoever implements this: run `npm ci && npm run verify` at
   `9d78a8b` and confirm.**
