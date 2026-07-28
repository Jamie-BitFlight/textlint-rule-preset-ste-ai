# Implementation plan — `textlint-rule-preset-ste-ai`

Status: executing. This document is an implementation aid, not the deliverable.

## Phase 1 findings (repository discovery)

Observed by `git log`, `git status`, and a full file listing at `HEAD` (`1379788 Initial commit`):

| Question                                           | Finding                                                                                                  | Evidence                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Existing code?                                     | No. Repo contains `README.md` (17 bytes), `LICENSE`, `.gitignore` only.                                  | `find . -type f` → 3 files                        |
| Language / package manager                         | None established. `.gitignore` is the standard Node/npm template (mentions npm, yarn, pnpm, bun caches). | `.gitignore` contents                             |
| TypeScript config                                  | Absent.                                                                                                  | no `tsconfig*.json`                               |
| Test framework                                     | Absent.                                                                                                  | no test config                                    |
| Lint/format conventions                            | Absent.                                                                                                  | no eslint/prettier config                         |
| CI                                                 | Absent.                                                                                                  | no `.github/`                                     |
| Architectural rules (CLAUDE.md / AGENTS.md / ADRs) | Absent.                                                                                                  | no such files                                     |
| Authorised ASD-STE100 source or dictionary         | **Absent.**                                                                                              | see below                                         |
| llama.cpp client / model client                    | Absent.                                                                                                  | no source files                                   |
| Repo licence                                       | MIT, © 2026 Jamie Nelson                                                                                 | `LICENSE`                                         |
| Toolchain available                                | Node v22.22.2, npm 10.9.7, pnpm, yarn, bun; npm registry reachable                                       | `node --version`, `curl registry.npmjs.org` → 200 |

### Source-authority determination

`https://asd-ste100.org/` states verbatim:

> Simplified Technical English, ASD-STE100, is a Copyright and a Trademark of ASD, Brussels,
> Belgium. All rights reserved. European Union Trade Mark No. 017966390.

Retrieved 2026-07-26. No open licence, redistribution grant, or machine-readable rule pack is
offered. Therefore:

- **No normative ASD-STE100 material is available to this repository.**
- Writing Rules and the Dictionary are **not** reconstructed from memory or secondary summaries.
- Every shipped rule is classified `provisional` and carries that status in its metadata,
  in diagnostics, and in the docs.
- A **rule-pack import boundary** (`src/core/rule-pack/`) is the single supported route by
  which an authorised, licensed pack can later supply normative rule data and a controlled
  dictionary. Nothing else in the codebase hard-codes vocabulary.

Consequence for claims: the project must never assert ASD-STE100 conformance or certification.
See `docs/DISCLAIMER.md`.

## Chosen conventions (decisions)

| Decision          | Choice                                                            | Rationale                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language          | TypeScript, `strict` + `noUncheckedIndexedAccess`, ESM, NodeNext  | Spec default; nothing in repo says otherwise                                                                                                                                                                                |
| Package manager   | npm (lockfile committed)                                          | `.gitignore` is npm-flavoured; npm is present                                                                                                                                                                               |
| Layout            | **Single package**, enforced internal module boundaries           | Repo has no monorepo justification. Boundary direction is enforced by an automated test (`test/architecture/module-boundaries.test.ts`) rather than by package.json topology — this is verifiable, not merely conventional. |
| Test runner       | Vitest 4                                                          | native ESM + TS, fast, snapshot support                                                                                                                                                                                     |
| Rule validation   | `textlint-tester` for the textlint adapter; Vitest for core       | textlint's own harness is the contract test for adapter behaviour                                                                                                                                                           |
| Schema validation | Zod 4                                                             | model-response and rule-pack validation with typed output                                                                                                                                                                   |
| Segmentation      | `sentence-splitter` (textlint org) + own protected-region masking | reuse ecosystem tooling; masking keeps offsets exact                                                                                                                                                                        |

### Module boundary rules (enforced by test)

```
core            → (no internal deps)
rule-pack       → core
deterministic   → core, rule-pack
model-client    → core                (transport only; no rule logic)
semantic        → core, rule-pack, model-client
textlint        → core, deterministic, semantic, rule-pack   (adapter only; no rule logic)
fixture-tools   → core, rule-pack
```

`model-client` and `textlint` must contain no rule logic: the boundary test asserts they do
not import `deterministic/rules/*` internals and that `model-client` never imports `semantic`.

## Work breakdown

1. Scaffolding: package.json, tsconfig, vitest, eslint, prettier, CI. ✔
2. `core`: domain types, source document + offset map, protected-region extractor, segmenter,
   diagnostics, fix planner, rule registry. ✔
3. `rule-pack`: Zod schema, loader, provisional non-proprietary pack. ✔
4. `deterministic`: 14 rules, each with id, status, config schema, exact ranges, tests. ✔
5. `textlint`: adapter (node ↔ core), preset, per-rule modules. ✔
6. `model-client`: llama.cpp-compatible transport, content-hash cache, timeout/cancel, retry
   policy for transport-only failures. ✔
7. `semantic`: broker (concurrency, ordering, batching, tracing), 8 evaluators, versioned
   prompt assets, response schema. ✔
8. Fixtures: fetch script with provenance capture, 18 originals, manifest. ✔
9. Adjudication: compliant counterparts + annotation records + corpus-integrity tests. ✔
10. Tests: unit, offsets, protected regions, contract, malformed response, timeout,
    cancellation, cache, fake-server integration, fixture expectations, e2e textlint. ✔
11. Eval tooling: confusion matrix, precision/recall/F1, uncertain rate, latency percentiles;
    train/dev/heldout split enforcement. ✔
12. Docs: architecture, rule authoring, semantic evaluators, rule-pack import, llama.cpp setup,
    diagnostic + autofix policy, disclaimer, implementation report. ✔
13. Fresh-context verifier subagent, then defect correction and gate re-run. ✔

## Non-goals

- No ASD-STE100 dictionary reconstruction.
- No conformance claim.
- No autofix for safety-sensitive, negated, ordered, quantitative, or identifier content.
