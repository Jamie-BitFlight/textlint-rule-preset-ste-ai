# Implementation plan — `textlint-rule-preset-ste-ai`

Status: executing. This document is an implementation aid, not the deliverable.

## Phase 1 findings (repository discovery)

Observed by `git log`, `git status`, and a full file listing at `HEAD` (`1379788 Initial commit`):

| Question                                   | Finding                                                                                                             | Evidence                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Existing code?                             | No. Repo contains `README.md` (17 bytes), `LICENSE`, `.gitignore` only.                                             | `find . -type f` → 3 files                        |
| Language and package manager               | None established. `.gitignore` is the standard Node.js and npm template (mentions npm, yarn, pnpm, and bun caches). | `.gitignore` contents                             |
| TypeScript config                          | Absent.                                                                                                             | no `tsconfig*.json`                               |
| Test framework                             | Absent.                                                                                                             | no test config                                    |
| Lint and format conventions                | Absent.                                                                                                             | no ESLint or Prettier config                      |
| Continuous integration (CI)                | Absent.                                                                                                             | no `.github/`                                     |
| Architectural rules                        | Absent. No CLAUDE.md, AGENTS.md, or architecture decision records (ADRs) exist.                                     | no such files                                     |
| Authorised ASD-STE100 source or dictionary | **Absent.**                                                                                                         | see below                                         |
| llama.cpp client or model client           | Absent.                                                                                                             | no source files                                   |
| Repo licence                               | MIT, © 2026 Jamie Nelson                                                                                            | `LICENSE`                                         |
| Toolchain available                        | Node.js and npm are present, alongside pnpm, yarn, and bun. The npm registry is reachable.                          | `node --version`, `curl registry.npmjs.org` → 200 |

### Source-authority determination

`https://asd-ste100.org/` states verbatim:

<!-- ste-ai-ignore-next-line punctuation-constraints -- verbatim quotation, not our prose -->

> Simplified Technical English, ASD-STE100, is a Copyright and a Trademark of ASD, Brussels,
> Belgium. All rights reserved. European Union Trade Mark No. 017966390.

Retrieved 26 July 2026. The site offers no open licence, redistribution grant, or
machine-readable rule pack. Therefore:

- **No normative ASD-STE100 material is available to this repository**.
- Writing Rules and the Dictionary are **not** reconstructed from memory or secondary summaries.
- Every shipped rule is classified `provisional` and carries that status in its metadata,
  in diagnostics, and in the docs.
- A **rule-pack import boundary** (`src/core/rule-pack/`) is the single supported route for new
  rule data. Through it, an authorised, licensed pack can later supply normative rules and a
  controlled dictionary. Nothing else in the codebase hard-codes vocabulary.

Consequence for claims: the project must never assert ASD-STE100 conformance or certification.
See `docs/DISCLAIMER.md`.

## Chosen conventions (decisions)

| Decision          | Choice                                                                                | Rationale                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language          | TypeScript, `strict` + `noUncheckedIndexedAccess`, ECMAScript modules (ESM), NodeNext | This is the specification's default. Nothing in the repository says otherwise.                                                                                                                              |
| Package manager   | npm (lockfile committed)                                                              | npm is present. `.gitignore` is npm-flavoured.                                                                                                                                                              |
| Layout            | **Single package**, enforced internal module boundaries                               | Repo has no monorepo justification. An automated test (`test/architecture/module-boundaries.test.ts`) enforces boundary direction, not package.json topology — this is verifiable, not merely conventional. |
| Test runner       | Vitest 4                                                                              | native ESM and TypeScript support, with fast snapshots                                                                                                                                                      |
| Rule validation   | `textlint-tester` for the textlint adapter. Vitest for core.                          | textlint's own harness is the contract test for adapter behaviour                                                                                                                                           |
| Schema validation | Zod 4                                                                                 | model-response and rule-pack validation with typed output                                                                                                                                                   |
| Segmentation      | `sentence-splitter` (textlint org) + own protected-region masking                     | Reuse ecosystem tooling. Masking keeps offsets exact.                                                                                                                                                       |

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

Each phase below is complete (✔). The scope column lists that phase's delivered components.

| Phase           | Scope                                                                                                                                                                                | Status |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Scaffolding     | `package.json`<br>TypeScript config<br>Vitest config<br>ESLint and Prettier config<br>CI                                                                                             | ✔      |
| `core`          | Domain types<br>Source document and offset map<br>Protected-region extractor<br>Segmenter<br>Diagnostics<br>Fix planner<br>Rule registry                                             | ✔      |
| `rule-pack`     | Zod schema<br>Loader<br>Provisional non-proprietary pack                                                                                                                             | ✔      |
| `deterministic` | 14 rules<br>Each rule carries an id and a status<br>Each rule carries a config schema, exact ranges, and tests                                                                       | ✔      |
| `textlint`      | Adapter (node and core)<br>Preset<br>Per-rule modules                                                                                                                                | ✔      |
| `model-client`  | llama.cpp-compatible transport<br>Content-hash cache<br>Timeout and cancellation<br>Retry policy for transport-only failures                                                         | ✔      |
| `semantic`      | Broker: concurrency, ordering, batching, and tracing<br>8 evaluators<br>Versioned prompt assets<br>Response schema                                                                   | ✔      |
| Fixtures        | Fetch script with provenance capture<br>18 originals<br>Manifest                                                                                                                     | ✔      |
| Adjudication    | Compliant counterparts<br>Annotation records<br>Corpus-integrity tests                                                                                                               | ✔      |
| Tests           | Unit<br>Offsets<br>Protected regions<br>Contract<br>Malformed response<br>Timeout<br>Cancellation<br>Cache<br>Fake-server integration<br>Fixture expectations<br>End-to-end textlint | ✔      |
| Eval tooling    | Confusion matrix<br>Precision<br>Recall<br>F1<br>Uncertain rate<br>Latency percentiles<br>Train, dev, and heldout split enforcement                                                  | ✔      |
| Docs            | Architecture<br>Rule authoring<br>Semantic evaluators<br>Rule-pack import<br>llama.cpp setup<br>Diagnostic and autofix policy<br>Disclaimer<br>Implementation report                 | ✔      |
| Verification    | Fresh-context verifier subagent<br>Defect correction<br>Gate re-run                                                                                                                  | ✔      |

## Non-goals

- No ASD-STE100 dictionary reconstruction.
- No conformance claim.
- No autofix applies to safety-sensitive or negated content. None applies to ordered,
  quantitative, or identifier content either.
