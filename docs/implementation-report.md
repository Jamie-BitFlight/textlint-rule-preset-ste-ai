# Implementation report

## Outcome

A working textlint extension: 14 deterministic rules, an optional semantic-adjudication subsystem
for a local llama.cpp server, an 18-document fixture corpus with machine-checkable provenance and
adjudication records, and 339 passing tests that need no model.

## Was authorised ASD-STE100 material available?

**No.** `https://asd-ste100.org/` states verbatim, retrieved 2026-07-26:

> Simplified Technical English, ASD-STE100, is a Copyright and a Trademark of ASD, Brussels,
> Belgium. All rights reserved. European Union Trade Mark No. 017966390.

No open licence, redistribution grant or machine-readable rule pack is offered. Consequently no
Writing Rule text and no part of the controlled Dictionary is reproduced, paraphrased, summarised or
reconstructed anywhere in this repository, and the project makes no conformance claim. See
[`DISCLAIMER.md`](./DISCLAIMER.md).

## Which rules are normative, which are provisional

**All 14 shipped rules are provisional.** None is normative, because no normative source existed to
derive one from. `provisional` is carried mechanically, not just in prose:

- `meta.status` and `meta.sourceRef` on every rule (`provisional:docs/provisional-rules.md#…`);
- the `[provisional]` tag in every diagnostic message and the `ruleStatus` field in JSON output;
- the bundled pack's `metadata.authority: 'provisional'` and `conformanceClaim: 'none'`;
- a CI step that fails if any rule reports a status other than `provisional`.

Verified: `node dist/cli/main.js rules --json` → 14 rules, every `status` is `provisional`;
`node dist/cli/main.js lint … --json` → `conformance.claim: "none"`,
`conformance.packAuthority: "provisional"`.

The bundled word lists are ordinary plain-English editing guidance authored for this package
(`utilise`→`use`, `whilst`→`while`, `prior to`→`before`, contraction expansions, and similar). They
are deliberately small — about 60 vocabulary entries and 36 contractions — precisely so they cannot
be mistaken for, and do not function as, a controlled dictionary.

## What was implemented

| Area                     | Implementation                                                                                                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core (framework-neutral) | domain types; protected-region extraction (28 passes); structural + full masking; block scanning with mode and admonition classification; sentence segmentation; word tokenisation; rule contract; autofix gate; runner                                                 |
| Rule pack                | Zod schema, loader, bundled provisional pack — the single import boundary for licensed data                                                                                                                                                                             |
| Deterministic rules      | 11 deciding rules + 3 candidate-only rules                                                                                                                                                                                                                              |
| Model client             | llama.cpp-compatible transport over `POST /v1/chat/completions`; LRU content-hash cache; typed retryable/non-retryable transport errors                                                                                                                                 |
| Semantic                 | broker (concurrency, ordering, de-duplication, caching, timeout, cancellation, retry policy, bounded repair, tracing); 8 evaluators; versioned prompt assets; response schema with contradiction rejection; evidence-span mapping; independent rewrite-equivalence gate |
| textlint                 | one analysis per document shared by all rules; preset of 14 independent rule modules; shared-config resolution with key-by-key option layering                                                                                                                          |
| CLI                      | `lint` (`--json`, `--deterministic-only`, `--semantic`, `--trace`, `--fail-on-review`), `rules`, `evaluators`                                                                                                                                                           |
| Fixture tools            | manifest and annotation schemas; protected-literal extraction; corpus validator                                                                                                                                                                                         |
| Evaluation               | confusion matrix, precision/recall/F1, uncertain rate, failure rate, latency percentiles, split enforcement                                                                                                                                                             |

### Rules

Deciding (emit `deterministic-violation`): `sentence-length-procedural`,
`sentence-length-descriptive`, `unapproved-vocabulary`, `preferred-terminology`, `no-contractions`,
`punctuation-constraints`, `no-repeated-words`, `abbreviation-introduction`, `number-unit-format`,
`list-instruction-structure`, `one-instruction-per-sentence` (unambiguous shape only).

Candidate-only (never assert a violation): `passive-voice-candidate`, `noun-cluster-candidate`,
`ambiguous-pronoun-candidate`. Each detects a shape that cannot be decided lexically, hands it to a
named evaluator, and degrades to `review-required` when adjudication is off. This is the line between
"deterministic rules stay deterministic" and "the model adjudicates meaning".

Four rules attach fixes: `no-contractions`, `unapproved-vocabulary`, `preferred-terminology`,
`no-repeated-words` — and only for closed substitutions the pack marks meaning-preserving, and only
after the central gate passes. `number-unit-format` deliberately never offers a fix.

## Verification

Every command below was run in this session; the output is what it printed.

| Gate                           | Command                                                                         | Result                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependencies install           | `npm install`                                                                   | `added 395 packages in 19s`                                                                                                                          |
| Clean build                    | `npm run clean && npm run build`                                                | exit 0, no output                                                                                                                                    |
| Type check (strict)            | `npx tsc -p tsconfig.json --noEmit`                                             | exit 0, no diagnostics                                                                                                                               |
| Lint                           | `npx eslint .`                                                                  | exit 0, no problems                                                                                                                                  |
| Format                         | `npx prettier --check .`                                                        | `All matched files use Prettier code style!`                                                                                                         |
| Full test suite                | `npx vitest run`                                                                | **14 files, 339 tests, 339 passed**                                                                                                                  |
| Coverage                       | `npx vitest run --coverage`                                                     | statements 90.99% (1819/1999), branches 79.28% (980/1236), functions 86.53% (225/260), lines 93.74% (1634/1743)                                      |
| Fixture provenance             | `node scripts/validate-fixtures.mjs`                                            | `OK: 18 fixtures, 18 with a rewritten counterpart, 12 dev / 6 heldout, 9 categories. Provenance, licences, digests and protected literals verified.` |
| End-to-end textlint            | `npx vitest run test/e2e`                                                       | 16 kernel tests + 29 `textlint-tester` cases, all passed                                                                                             |
| Deterministic-only, no service | `test/integration/semantic-service.test.ts`                                     | fake server received **0** requests; run notice `semantic-disabled` emitted                                                                          |
| Semantic mode vs fake server   | same file                                                                       | 22 integration tests passed over real HTTP                                                                                                           |
| CLI on the corpus              | `node dist/cli/main.js lint fixtures/original/*.md --deterministic-only --json` | 18 files, **111 diagnostics**, `conformance.claim: "none"`                                                                                           |

Test suite composition: 14 files — unit (rules, protected regions, offsets, fix safety, broker,
response schema, prompts, evaluation, pipeline smoke), architecture (module boundaries), integration
(fake HTTP semantic service), fixtures (corpus integrity), e2e (textlint kernel, textlint-tester).

### Deterministic findings, original vs rewritten

```
node dist/cli/main.js lint fixtures/original/*.md   --deterministic-only --json
node dist/cli/main.js lint fixtures/compliant/*.md  --deterministic-only --json
→ deterministic violations: original 111 → compliant 60
```

By rule on the originals: `punctuation-constraints` 30, `abbreviation-introduction` 20,
`number-unit-format` 20, `sentence-length-descriptive` 15, `no-contractions` 11,
`unapproved-vocabulary` 6, `one-instruction-per-sentence` 4, `sentence-length-procedural` 3,
`list-instruction-structure` 1, `no-repeated-words` 1.

The 60 remaining on the rewritten corpus are overwhelmingly the findings reviewers **refused** — see
false-positive risk below. They are not oversights; they are recorded as `disputed`.

### Fixture provenance, independently verified

The corpus was collected by one worker and checked by a validator written separately. Beyond the
validator I re-derived the provenance myself:

- **Committed-file digests**: 18/18 `originalSha256` values recomputed from disk match the manifest.
- **Live re-fetch**: 6 sources sampled across distinct organisations; 5 byte-identical to the
  committed `provenance.lock.json` digest, 1 (an OSHA page) differed by 8 bytes — a live CMS page, not
  a fabricated record. All returned HTTP 200, matching the recorded status.
- **Verbatim check**: every excerpt's sentences were matched against the cached upstream bytes in
  `.cache/sources/`. **194 of 194 sampled sentences across all 18 fixtures were found verbatim.**

An earlier pass of my own checker reported one PostgreSQL sentence as missing; that was a false
negative in my checker (the source breaks the phrase across lines and my tag-stripper left a stray
space inside `(without FULL)`). The sentence is present in the source. Corrected.

Licences: 4 SQLite public domain, 2 US-Government public domain (OSHA), 4 Apache-2.0, 2 Apache-2.0
WITH LLVM-exception, 2 CC-BY-4.0, 1 PostgreSQL, 1 BSD-3-Clause, 1 curl, 1 MIT. No share-alike or
copyleft source is present; the validator rejects them, and CC-BY sources propagate attribution into
`derivativeLicence`.

### Adjudication

70 change records across 18 fixtures: **32 accepted, 36 disputed, 2 deferred**. Mean reviewer
confidence 0.893. 107 semantic invariants and 22 unresolved findings recorded.

That 36 disputed exceeds 32 accepted is the most useful number in this report: **on real technical
documentation, more than half of what these provisional rules flag was judged wrong by a reviewer.**
Two independent reviewers worked on disjoint halves of the corpus and reached the same conclusion
about the same classes of false positive, which is corroboration rather than a single opinion.

## Defects found and fixed during implementation

Six real defects, all caught by tests or by the corpus rather than by inspection:

1. **Protected-region containment was overlap-based.** Any diagnostic whose span merely _overlapped_
   a protected region was dropped, so every sentence-length finding on a sentence containing a
   quantity, an identifier or an inline code span was silently discarded. Replaced with
   `pointsOnlyAtProtectedContent()`: a diagnostic is rejected only when its span contains no prose at
   all. Regression test in `test/unit/rules.test.ts`.
2. **The autofix gate refused correct fixes.** `prior to` → `before` was rejected as "changes an
   ordering word" because the check compared ordering _spellings_. Register variants
   (`whilst`/`while`, `prior to`/`before`, `subsequent to`/`after`) are now normalised, alongside the
   existing negative-contraction normalisation, so the gate compares relations.
3. **Link masking broke sentence segmentation.** Masking `](destination)` as one span removed the
   closing `]`, leaving `[` unpaired; sentence-splitter then treated the remainder of the block as
   bracketed and merged every following sentence into one. This inflated sentence-length findings on
   any paragraph containing a link. Found by a fixture reviewer who reproduced it against the raw
   splitter rather than working around it. Fixed with a lookbehind so brackets stay balanced.
4. **CRLF documents lost structure detection.** A stray `\r` sat between the content and the `$` of
   every line-anchored pattern, so tables, shell-command lines, reference definitions and HTML blocks
   were not detected at all in Windows-authored files. Fixed with a length-preserving
   `normalizeLineEndings()` applied to detection text only, so offsets remain valid.
5. **Option layers replaced instead of merging.** A rule's own textlint options replaced the shared
   per-rule object wholesale, discarding an `enabled: false` set by a lower layer.
6. **User terminology lost to heuristics.** The approved-term pass ran after the CamelCase identifier
   pass, so a multi-word approved term such as `Acme WidgetPro` could not match — half of it was
   already masked. User-declared terminology now runs before every heuristic pass.

Defects 3 and 4 are exactly what the fixture corpus was for: neither would have been found on
synthetic examples.

## What could not be implemented, and why

- **Normative ASD-STE100 rules.** No lawfully usable source. Built the import boundary instead.
- **A controlled dictionary.** Same reason. The `approved-word-sense` and `permitted-part-of-speech`
  evaluators are implemented and tested, but with the bundled pack they have only six approved terms
  to work with, so their practical value depends on a supplied pack.
- **Measured semantic-evaluator quality.** The evaluation tooling computes TP/FP/TN/FN, precision,
  recall, F1, uncertain rate, failure rate and latency percentiles, and is exercised by 14 tests
  against a scripted transport — but **no real model was run**, so this report contains no
  precision or recall figures. Producing them requires
  `npm run eval:semantic -- --split heldout --endpoint …` against a llama.cpp server.
- **Part-of-speech-accurate mode detection.** `detectMode()` is a closed verb list, not a tagger.
  Documented, with its misclassifications, in
  [`provisional-rules.md`](./provisional-rules.md#the-proceduraldescriptive-classifier).

## Remaining false-positive and false-negative risks

### False positives (observed, not hypothetical)

| Rule                                         | Fires on                                                                  | Why it is wrong                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `abbreviation-introduction`                  | `VACUUM`, `FULL`, `ANALYZE`, `PRAGMA`, `WAL`, `LLVM`, `FIPS`, `RFC`, `ON` | Command names, keywords, product names and CMake literals are not abbreviations of a longer phrase |
| `number-unit-format`                         | `3.20.5`, `2.4.64`, `140-2`, `1910.132`                                   | Version strings, standard designations and regulatory citations are not quantity+unit pairs        |
| `punctuation-constraints`                    | `SSL/TLS`; semicolons in an `(i)/(ii)/(iii)` legal list                   | A compound protocol name; legal list separators                                                    |
| `punctuation-constraints`, `no-contractions` | `'hello!'` in an **unfenced** terminal transcript                         | If the source does not mark a transcript as code, the linter cannot know it is not prose           |
| `sentence-length-descriptive`                | a flat HTML index of `PRAGMA` names                                       | Not a sentence; no punctuation for the segmenter                                                   |

The dominant class is **an identifier that looks like an abbreviation or a quantity**.
`approvedTerms`, `approvedTechnicalTerms` and `additionalWellKnown` are the mitigation and are the
first thing to configure on a real corpus. This is why the abbreviation and number rules default to
`warning` in `examples/.textlintrc.json`.

`ambiguous-pronoun-candidate` over-triggers in dense technical prose: its antecedent count is a crude
content-word count over two sentences. It is `info` severity and candidate-only for that reason.

### False negatives

- Sentence-length limits skip headings and table cells by default, so an over-long heading is missed.
- `one-instruction-per-sentence` only asserts on a conjunction-joined shape; comma-joined and
  colon-joined instructions become candidates, so with semantic analysis off they are
  `review-required` rather than violations.
- `abbreviation-introduction` reports only the first use of each abbreviation.
- The vocabulary list is small by design: absence of a finding says almost nothing about vocabulary.
- Mode misclassification can route a sentence to the descriptive limit (25 words) instead of the
  procedural one (20), letting a long instruction through.
- Protected-region masking is deliberately aggressive. Any prose that resembles an identifier,
  a quantity or a path is not judged as prose at all.

### Risk in the semantic path

No calibration data exists. `defaultConfidenceThreshold` is 0.7 — a placeholder, not a measured
operating point, and it is documented as such. Until the evaluation suite has been run against the
model you intend to use, semantic findings should be read as leads for a reviewer. The subsystem is
off by default for this reason.

## Next highest-value work

1. **Run the evaluation suite against a real llama.cpp model and calibrate the thresholds.** The
   tooling, the ground truth and the split discipline are in place; the numbers are the gap. Without
   them the confidence thresholds are guesses.
2. **Cut the abbreviation and quantity false positives.** Together they are 40 of the 111 findings on
   the corpus, and nearly all are identifiers. An identifier-shape pre-filter — a token appearing in a
   code span or table cell elsewhere in the document is probably not prose — would remove most of them
   without a rule-pack change.
3. **Obtain a licensed rule pack and exercise the import boundary end to end.** The path is
   implemented and unit-tested, but it has never carried real normative data. That is the difference
   between a useful plain-English linter and the tool this was meant to be.
4. **Replace `detectMode()` with a real part-of-speech tagger.** It is the shared root of several
   documented failure modes, and it currently forces rules to hedge to `review-required` where a
   tagger would let them decide.
