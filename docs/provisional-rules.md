# Provisional rules

Every rule in this package is **provisional**: an ordinary controlled-language editing heuristic
authored for this project, not a reproduction of any standard. See [`DISCLAIMER.md`](./DISCLAIMER.md)
for why no normative material is present.

Each entry below is the target of the corresponding rule's `meta.sourceRef`. Each states what the
rule triggers on, why the heuristic is defensible, and — importantly — how it is known to be wrong.
The failure modes are not hypothetical; most were observed while running the rule set over the
fixture corpus.

Rules are grouped by whether they can decide on their own.

---

## Deciding rules

These have an exact, reproducible trigger and emit `deterministic-violation`.

### sentence-length-procedural

**Triggers** when a sentence classified as an instruction has more words than
`limits.proceduralSentenceMaxWords` (bundled default 20).

**Rationale** Long instructions are the single most reliable predictor of misreading in procedural
text. A word limit is objective and reproducible.

**Counting** Protected content-bearing tokens count as one word each — a reader still has to read
`25 Nm` or `--max-retries`. Structural markup (list markers, table pipes, fences) counts as nothing.

**Known failure modes**

- Depends on the procedural/descriptive classifier, which has no part-of-speech model (below).
- A sentence listing many identifiers can exceed the limit without being hard to read. The
  `hard-negative` fixtures exist to keep this visible.
- Headings and table cells are excluded by default; a genuinely over-long heading is missed.

### sentence-length-descriptive

As above with `limits.descriptiveSentenceMaxWords` (bundled default 25), applied to descriptive
sentences.

### unapproved-vocabulary

**Triggers** when a word or phrase appears in the active pack's `dictionary.unapproved`.

**Rationale** A closed list is exact. Longest-match wins so `prior to` is preferred over a
hypothetical `prior`.

**Fix** Attached only when the pack sets `safeSubstitution: true`, and then only if the central
autofix gate also passes. The bundled pack marks just six entries safe: `utilise`/`utilize` → `use`,
`whilst` → `while`, `amongst` → `among`, `prior to` → `before`, `subsequent to` → `after`,
`in order to` → `to`.

**Known failure modes**

- Word-sense blind. `terminate` in "terminate the cable" is a wiring operation, not a synonym for
  "stop". Enable `adjudicateSense` to route flagged words to the `approved-word-sense` evaluator, or
  add the term to `allow`.
- The bundled list is deliberately small. It is not a controlled vocabulary and does not pretend to
  be one.

### preferred-terminology

**Triggers** on the pack's `dictionary.preferred` mappings plus project `additional` entries.

**Rationale** One spelling per concept, enforced mechanically.

**Known failure modes** Project `additional` entries never carry a fix, because the linter cannot
know whether a project-specific swap is meaning-preserving.

### no-contractions

**Triggers** on any entry in the pack's `contractions` list, matching both `'` and `’`.

**Rationale** Contractions are harder for non-native readers and for translation memory.

**Fix** Only for unambiguous expansions. `it's`, `there's`, `that's`, `what's` and the `'d` forms are
reported without a fix because they have two expansions.

**Known failure modes** A contraction quoted from a user interface or an error message string should
not be changed; put such strings in inline code or `approvedTerms` so they are protected.

### punctuation-constraints

**Triggers** on semicolons, slashes between words, exclamation marks, ellipses, parentheses inside
an instruction, and more than `maxCommas` commas (default 3).

**Rationale** Each of these either joins two statements or hides one.

**No fix** Removing any of them requires deciding how to restructure the sentence.

**Known failure modes**

- A semicolon inside SQL or shell syntax described in prose is flagged unless it is in inline code.
  Observed on the SQLite fixtures; recorded as a disputed finding rather than "fixed".
- `and/or` is flagged, which is usually right, but so is `input/output` in a product name.

### no-repeated-words

**Triggers** on the same prose word twice in a row, separated only by whitespace.

**Fix** Deletes the duplicate — but the autofix gate refuses when deletion would change a negation
count, so `not not` is reported without a fix. `had` and `that` are allow-listed by default.

### abbreviation-introduction

**Triggers** on the _first_ use of an abbreviation-shaped token (2–6 upper-case letters) that is not
introduced as `Full Name (ABC)` or `ABC (Full Name)`, and is not in the well-known list.

**Known failure modes — significant**

- **Command and keyword names are misread as abbreviations.** `VACUUM`, `FULL`, `ANALYZE`, `WAL`,
  `PRAGMA` are flagged on the SQLite and PostgreSQL fixtures. They are command names, not
  abbreviations, and "introducing" them would damage the text. Add them to `additionalWellKnown` or
  to `approvedTerms`. Several fixture annotations record this finding as `disputed`.
- The default well-known list is a judgement call, not a standard.

### number-unit-format

**Triggers** on a quantity written against its unit (`25Nm`), or on a decimal comma.

**This is the only rule that reads inside protected numeric expressions**, declared by
`inspectsProtectedRegions: true`.

**Never offers a fix.** The autofix policy forbids automated edits to quantities, and inserting a
space is still an edit to a quantity. A suggestion is offered for a human to apply.

### list-instruction-structure

**Triggers** on sibling list items that disagree about terminal punctuation or initial
capitalisation, and on a numbered step containing more sentences than
`limits.maxSentencesPerProceduralStep` (default 1).

**Known failure modes** Sibling grouping is positional: items are siblings when they are contiguous
and at the same indent depth. Interleaved nested lists can split a group.

### one-instruction-per-sentence

**Triggers as a violation** only on the unambiguous shape: an instruction that starts with an
imperative verb and contains a coordinating conjunction (`and`, `then`, `and then`, `or`) followed by
another imperative verb.

**Triggers as a candidate** on the ambiguous shape: a comma-joined clause with a second imperative
verb. That goes to the `one-instruction-per-sentence` evaluator, or is reported as
`review-required` when adjudication is off.

**No fix.** Splitting a sentence is a decision about procedural order.

**Known failure modes** `Remove the cover and the filter` is one action on two objects and is
correctly ignored, but only because `the` follows the conjunction. `Remove the cover and filter` —
where `filter` is a noun — is misread as two actions if `filter` is ever added to the verb list.

---

## Candidate-only rules

These never assert a violation. They detect a shape that cannot be decided lexically and hand it to a
named semantic evaluator; with semantic analysis disabled they degrade to `review-required`.

### Measured precision of the candidate heuristics

Four independent reviewers adjudicated **all 123 candidate passages** the rule set emits across the
18 fixtures, judging each against the rule intent stated below and nothing else. The verdicts are in
`fixtures/verdicts/` and are merged into `candidateAdjudications` in each annotation record.

| Rule                           | Candidates | Confirmed defects | Non-defects |
| ------------------------------ | ---------: | ----------------: | ----------: |
| `passive-voice-candidate`      |         53 |                 2 |          51 |
| `noun-cluster-candidate`       |         35 |                 0 |          35 |
| `ambiguous-pronoun-candidate`  |         34 |                 2 |          32 |
| `one-instruction-per-sentence` |          1 |                 1 |           0 |
| **Total**                      |    **123** |             **5** |     **118** |

**Read this before quoting any figure from the semantic evaluation.** Five confirmed defects in 123
flagged passages is the headline result of this corpus, and it has three consequences:

1. **These heuristics have a very high false-positive rate on well-edited technical documentation.**
   That is why they are candidate-only, why they default to `info` severity, and why they must never
   be promoted to hard violations on this evidence.
2. **`noun-cluster-candidate` has no observed true positive at all.** It fired 35 times and every
   verdict was a non-defect. Reviewers reported that most of its spans are not noun runs: they
   straddle a finite verb, a parenthetical, a table cell or a title line, or they name a real
   product (`SSL/TLS Protocol Engine`, `Graphical User Interface (GUI)`). This is a segmentation
   defect as much as a comprehension one, and the rule should be treated as unvalidated.
3. **Recall is not measurable on this corpus.** With five positives, any recall or F1 number is
   noise. `formatEvaluationReport` therefore withholds recall and F1 below ten gold positives and
   prints the positive count instead. Precision over 118 negatives is informative; recall is not.

The counts are asserted in `test/fixtures/corpus.test.ts` so that a rule change which moves them
cannot pass unnoticed, and `scripts/ci/check-candidate-ground-truth.sh` fails the build if a change
orphans a verdict from the passage it was written about.

Reviewers judged against the intent documented here, not against ASD-STE100 — no authorised copy was
available, and they were instructed to mark a passage `undecidable` rather than reason from recalled
standard text. None did. **These figures are agreement with reviewers on provisional criteria. They
are not a conformance measurement.**

### passive-voice-candidate

**Detects** a `be`/`get` form followed by a past participle, optionally with a `by` agent.

**Why candidate-only** The same string is a passive verb in "the filter must be replaced" and an
adjectival state in "the drain valve is closed". Only the first is a defect, and only in an
instruction. Deciding needs meaning, so `passive-voice-adjudication` decides.

### noun-cluster-candidate

**Detects** a run of more than `limits.maxNounClusterLength` (default 3) consecutive content words
with no function word, no imperative verb, and no protected token between them.

**Why candidate-only** `Transport Layer Security certificate chain` is a standard name followed by a
conventional pair; `engine oil pressure warning lamp test procedure` is genuinely opaque. The shapes
are identical. `noun-cluster-comprehension` decides, and is instructed that component identity
outranks simplification.

**Known failure modes — this rule is unvalidated.** Measured: **0 confirmed defects in 35
candidates.** Reviewers found that most spans are not noun runs at all — they cross a finite verb
(`allows`, `include`, `named`), a parenthetical, a table cell, a `See [` link, or a title line
immediately below a directive name — and that the remainder name real components. Treat any finding
from this rule as unsubstantiated until the span detection is corrected and the corpus re-reviewed.
The architectural cause — hand-written regex scanning rather than a real parser — and the proposed
fix are tracked in [issue #25](https://github.com/Jamie-BitFlight/textlint-ASD-ai/issues/25).

### ambiguous-pronoun-candidate

**Detects** two shapes: a bare demonstrative used as a subject (`This prevents…`), and `it`/`they`/
`them` in a sentence whose local context offers at least `minAntecedents` (default 2) candidate
antecedents.

**Why candidate-only** Which antecedent a reader will choose is not a lexical fact.
`pronoun-antecedent-ambiguity` decides and is forbidden from guessing an antecedent.

**Known failure modes** The antecedent count is a crude content-word count over the current and
previous sentence. It over-triggers in dense technical prose; the default threshold of 2 is a
compromise, and `info` severity reflects the uncertainty. Measured: 2 confirmed defects in 34
candidates. Reviewers noted a specific failure — a list whose every item begins `it`, sharing one
implied referent, produces one candidate per item, and "no explicit antecedent" is not the same
defect as "more than one plausible antecedent". The proposed antecedents were also sometimes past
participles rather than selectable nouns.

---

## False positives observed on the corpus

These were found by running the rule set over `fixtures/original/` and are recorded as `disputed`
findings in the adjudication records. They are the honest known limits of the current rule set.

| What fires                                   | On what                                                                   | Why it is wrong                                                                                                     | Mitigation                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `abbreviation-introduction`                  | `VACUUM`, `FULL`, `ANALYZE`, `PRAGMA`, `WAL`, `LLVM`, `FIPS`, `RFC`, `ON` | Command names, keywords, product names, directive names and CMake literals are not abbreviations of a longer phrase | `additionalWellKnown`, or `approvedTerms`                                          |
| `number-unit-format`                         | `3.20.5`, `2.4.64`, `140-2`, `1910.132`                                   | Version strings, standard designations and regulatory citations are not quantity+unit pairs                         | none needed — report only, never fixed; add to `extraProtectedPatterns` to silence |
| `punctuation-constraints`                    | `SSL/TLS`                                                                 | A fixed compound protocol name, not an ambiguous `and/or`                                                           | `approvedTerms`                                                                    |
| `punctuation-constraints`                    | semicolons in an `(i)/(ii)/(iii)` legal list                              | List separators in a regulatory enumeration, not run-on joins                                                       | `forbidSemicolon: false` for such documents                                        |
| `punctuation-constraints`, `no-contractions` | `'hello!'` inside an **unfenced** terminal transcript                     | If the source does not mark a transcript as code, the linter has no way to know it is not prose                     | fence the transcript, or use `extraProtectedPatterns`                              |
| `sentence-length-descriptive`                | a flat HTML index of `PRAGMA` names rendered as text                      | Not a sentence at all; there is no punctuation for the segmenter to use                                             | none — inherent to unstructured input                                              |

The general shape of the first two rows is the same: **a token that looks like an abbreviation or a
quantity but is an identifier.** The rule pack's `approvedTechnicalTerms` and the config's
`approvedTerms` exist precisely for this, and are the first thing to reach for on a real corpus.

One further finding from the corpus was a genuine defect in the analyser rather than a rule
limitation, and was fixed: masking a markdown link destination together with its closing `]` left the
opening `[` unpaired, which made `sentence-splitter` treat the rest of the block as bracketed and
merge every following sentence into one. That inflated sentence-length findings on any paragraph
containing a link. See the regression test in `test/unit/protected-regions.test.ts`.

## The procedural/descriptive classifier

Several rules depend on `detectMode()`, which decides whether a passage is an instruction. It has no
part-of-speech model. It compares the first content word against a closed list of base-form action
verbs (`src/core/imperative-verbs.ts`) and treats a leading `Do not` / `Never` / `Always` as
imperative.

Verbs whose base form is a common noun (`file`, `place`, `order`, `plan`, `state`, `test`, `mount`,
`power`, `contact`, `access`, `report`, `label`, `mark`, `screen`) are **excluded** from the list,
because including them misclassified large amounts of descriptive prose in the fixture corpus.

Consequences:

- `Record the value.` → procedural (correct).
- `Record the value is stored in flash.` → procedural (wrong; it is descriptive).
- `Power the unit from the 24 V rail.` → descriptive (wrong; `power` is excluded on purpose).

Where a misclassification would change a hard verdict, the affected rule emits a candidate rather
than a violation. Add project verbs with `extraImperativeVerbs`.
