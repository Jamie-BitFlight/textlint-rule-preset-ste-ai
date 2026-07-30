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

**Triggers** when a sentence classified as an instruction is at least
`limits.sentenceReadabilityFloorWords` words long (bundled default 20) **and** its Flesch-Kincaid
grade level exceeds `limits.proceduralMaxGradeLevel` (bundled default 7).

**History** This rule used to trigger on raw word count alone (bundled default 20 words). It was
replaced with the mechanism below on the maintainer's explicit instruction, on the understanding
that it trades one documented failure mode for a different one — see "Known failure modes" below
for both directions of that trade. The `maxGradeLevel`/`floorWords` per-rule options replace the
old `maxWords` option; a pack or config still setting `maxWords` is silently ignored by the schema
(unknown keys are dropped), not rejected — see `docs/configuration.md`.

**Why a readability formula, and why Flesch-Kincaid** A word limit is objective and reproducible,
but it cannot tell a genuinely hard-to-parse sentence (nested clauses, low-frequency vocabulary)
from a long-but-simple one, and it cannot catch a short sentence that is hard to read for reasons
word count does not see. [`text-readability`](https://www.npmjs.com/package/text-readability)
exposes several formulas (Flesch-Kincaid grade, Gunning Fog, SMOG, Dale-Chall, and others).
Flesch-Kincaid grade level was chosen over Gunning Fog specifically because Gunning Fog counts any
word of 3+ syllables not on a fixed 3000-word "easy" list as fully "difficult" (a binary
per-word threshold), while Flesch-Kincaid only averages syllables per word — a smoother, less
binary penalty that was measurably gentler on the identifier-heavy sentences this project's
`hard-negative` fixtures are built around, in a hand comparison run before committing to it.

**Why the sentences are scored on masked text, not raw text** The rule feeds `sentence.masked` (not
`sentence.raw`) to `fleschKincaidGrade()`. Protected identifiers, part numbers and other opaque
protected regions are already replaced there with equal-length runs of U+FFFD before the sentence
reaches the formula. This matters a great deal in practice: a syllable-counting formula run against
the _literal spelling_ of a snake_case or CamelCase identifier (`wal_autocheckpoint`,
`legacy_alter_table`) treats it as a very long, high-syllable English word and inflates the grade
sharply — a hand comparison on a 21-word identifier-enumerating sentence measured a masked-text
grade of 2.0 against a raw-text grade of 17 on the same sentence. Masking removes that effect while
leaving ordinary prose (which contains no protected regions) untouched. Protected tokens still count
towards the word-count floor, exactly as they did towards the old word limit — a reader still has to
read them, even if their internal spelling should not be scored as if it were English prose.

**Why there is a word-count floor at all (the granularity problem)** Readability formulas are
normed on paragraph-or-longer passages, not single sentences, and `text-readability`'s own
`sentenceCount()` always treats a lone sentence as exactly one sentence — there is no
division-by-near-zero crash, but the score is still frequently meaningless on short input. Measured
directly against every non-heading, non-table sentence in this project's fixture corpus: single-word
or few-word sentences (markdown link-text fragments, section anchors, terse labels like
`Application.`) produced Flesch-Kincaid grades as high as 79 — nonsense for a two- or three-word
"sentence". The instability is concentrated below roughly a dozen words, essentially because the
formula's `11.8 × syllablesPerWord` term dominates whenever `sentenceLength` (word count) is small.
Below the floor, the grade is never computed and the sentence is presumed simple regardless of
vocabulary. The bundled floor (20) was chosen to equal the old bundled `proceduralSentenceMaxWords`
word limit, which both keeps the floor comfortably clear of the observed instability region and
keeps a recognisable anchor to the value this replaced.

**Why the bundled threshold (grade 7) is lower than the "grade 8-10" starting hypothesis** A
Flesch-Kincaid target of grade 8-10 is a reasonable starting point for technical writing in general,
but it does not hold up once the formula is run against real technical prose in this corpus: at
grade 8-10 on raw text, the rule flagged several multiples of what the old word-count rule flagged,
overwhelmingly driven by ordinary jargon (`configuration`, `installation`, `PostgreSQL`) rather than
genuine syntactic complexity — the exact syllable-weighting risk this rule was warned about before
implementation. Masking protected regions removes part of that effect but not all of it: ordinary
prose words that merely happen to be long and technical (not protected identifiers) still count
fully. The bundled thresholds (7 procedural / 8 descriptive) were set empirically, as the tightest
values that still reproduce every sentence-length finding in this project's own fixture-corpus
ground truth (18 reviewer-confirmed findings across 14 real documents); they are lower than the
"grade 8-10" hypothesis because they are calibrated against masked text, not raw text, and masking
already lowers most genuine sentences' scores relative to a raw-text baseline.

**Known failure modes**

- Depends on the procedural/descriptive classifier, which has no part-of-speech model (below).
- **Ordinary long technical vocabulary still inflates the score.** Masking removes syllable
  inflation from _protected_ tokens (identifiers, part numbers, quantities), but an everyday
  technical word that is not auto-detected as a protected region — `configuration`,
  `authentication`, `installation`, `synchronization` — is still scored as prose and still adds
  syllables the reader does not actually find difficult, because they are common, well-known terms
  in their domain. Measured across every non-heading, non-table-cell sentence in this project's 18
  original fixture documents (215 sentences total), this rule fires on 39 sentences where the old
  word-count rule fired on 18 — the 18 old findings are a strict subset of the 39, so nothing the
  old rule caught was lost, but 21 sentences are newly flagged. Reading those 21 by hand, most read
  as ordinary, well-edited technical prose (curl option reference text, Kubernetes audit-log
  description, SQLite CLI documentation) whose Flesch-Kincaid grade is inflated mainly by
  domain-standard vocabulary length rather than by genuinely tangled sentence structure. This is a
  real regression relative to the old rule's much smaller false-positive surface, not a hypothetical
  one, and it is the main reason this change is not an unqualified improvement.
- **Rewriting to satisfy word count does not reliably satisfy this rule, and vice versa.** Several
  of this project's `compliant/` fixture counterparts were written to bring a sentence under the old
  word limit, typically by splitting a long sentence into two. Measured against those same
  counterparts, splitting does not reliably lower the Flesch-Kincaid grade of the resulting
  sentences — legalistic or jargon-dense source prose (OSHA safety language, Node.js module
  resolution semantics) can produce split sentences whose _individual_ grade levels are unchanged or
  higher than the original's, even though the total number of words dropped in each half. The
  project-wide total count of deterministic-violation diagnostics still decreases on every
  fixture's compliant counterpart (other rules' fixes outweigh this), but the sentence-length count
  specifically increases on at least two fixtures (`node-cli-hard-negative`,
  `osha-lockout-tagout-warning`) after their word-count-motivated rewrite.
- A sentence listing many identifiers is now measurably **less** likely to be falsely flagged than
  under pure word count, specifically because of the masked-text scoring above — this is the
  `hard-negative` fixtures' original concern, and it measurably improved. See
  `docs/DISCLAIMER.md` and the hard-negative fixtures themselves for what "measurably" means here:
  spot checks against constructed long, identifier-enumerating sentences (21-26 words, comfortably
  over the old word limit) scored Flesch-Kincaid grades of 2-3 on masked text, well under the
  bundled thresholds, where the old rule would have flagged them unconditionally.
- Headings and table cells are excluded by default; a genuinely over-long or complex heading is
  missed.
- A sentence shorter than the floor is never flagged, however genuinely hard to parse its vocabulary
  is. This is a deliberate trade against the granularity problem above, not an oversight.

### sentence-length-descriptive

As above with `limits.descriptiveMaxGradeLevel` (bundled default 8) and the same
`limits.sentenceReadabilityFloorWords` floor, applied to descriptive sentences.

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

Several rules depend on `detectMode()`, which decides whether a passage is an instruction. As of the
[`compromise`](https://www.npmjs.com/package/compromise) integration (issue #35), this asks a
grammatical question — does the passage open with an imperative-mood verb? — via
`sentenceOpensImperative()` in `src/core/pos-tags.ts`, rather than testing set membership against a
closed word list. It still only looks at the sentence opener, so the classifier's oldest known limit
is unchanged:

- `Record the value.` → procedural (correct).
- `Record the value is stored in flash.` → procedural (wrong; it is descriptive).

`src/core/imperative-verbs.ts` (`IMPERATIVE_VERBS`) survives, but its role changed. It is no longer
consulted as `Set.has()` membership anywhere outside `pos-tags.ts`. It is now:

1. A **domain lexicon** taught to `compromise` via `addWords`, so `compromise`'s own
   context-sensitive tagger can recognise technical verbs it does not know out of the box —
   confirmed directly: `torque`, `flash`, `mark` (as a verb), `source`, `sync`, `query`, `rebase`,
   `unset` and `serialise`/`serialize` all default to a non-verb reading until taught this way.
   Only words `compromise` does not already tag as a verb are taught — `addWords` was found, by
   direct testing, to _replace_ `compromise`'s own richer conjugation-aware tag for a word it
   already knows (`addWords({build: 'Verb'})` turns `Build` from `Verb·PresentTense·Infinitive`
   into `Verb·PastTense` in "Build, flash, and run a sample application") rather than adding to it,
   so every word is checked against a pristine tag lookup before ever being taught.
2. A **fallback** for words `compromise`'s own tagging gets wrong even with full sentence context
   (below), and for the rare case where `compromise`'s tokenisation of a sentence does not align
   with this project's own word tokeniser.

`src/deterministic/helpers.ts`'s old `FUNCTION_WORDS`/`isFunctionWord` moved into `pos-tags.ts` for
the same reason, backing `noun-cluster-candidate` and `ambiguous-pronoun-candidate`. There,
`compromise`'s tag and list membership are a **union**, not tag-first-list-as-fallback: corpus
validation found `compromise` mistags unambiguous closed-class words even with full sentence
context (`no` and `so` tag as `Expression`, `under` as `Adjective` in "is under the exclusive
control of" — confirmed directly, not alignment misses). This is also this design's known
limitation: a word the closed list wrongly treats as _always_ a function word — this issue's own
motivating examples, `per` as a unit marker and `further` as a comparative adjective — is not fixed
by adding `compromise`, because the list still fires unconditionally and `compromise`'s tag is
exactly the thing just shown to be unreliable here.

**Additional known failure modes, all found by corpus validation and fixed with small, documented
overrides rather than silently accepted:**

- `compromise` tags a capitalised sentence-initial word that collides with a common English verb as
  imperative regardless of what it actually names — `VACUUM reclaims storage occupied by dead
tuples.` (PostgreSQL's own command name) tags `VACUUM` as `Verb·Imperative`, which then cascades
  into mistagging the real verb `reclaims` as a noun. `List Of PRAGMAs …`, a heading rendered as a
  run-on Title Case line in `fixtures/original/sqlite-pragma-hard-negative.md` — a fixture named for
  exactly this kind of trap — has the same failure with `List`. Both are excluded by a two-word
  override list in `pos-tags.ts`, found empirically against this corpus, not enumerated in advance.
- `compromise` does not tag `#Imperative` on any verb in a coordinated imperative list ("Build,
  flash, and run a sample application.") — confirmed directly, none of the three verbs get the tag.
  `sentenceOpensImperative` recovers this by also accepting a bare (infinitive/present-tense,
  non-passive, non-gerund) tag on the very first word of a sentence, which is otherwise a
  vanishingly rare shape outside imperative mood — guarded against a word immediately followed by a
  colon (`Note:`, `Exception:`), which is a label, not a verb taking an object.
- `have`/`has`/`had`, `do`/`does`/`did`, `be`/`being`/`been`, `get`/`gets`/`got`, `go`/`goes` are
  excluded from the tag-based "is this a bare action verb" signal used by
  `one-instruction-per-sentence`'s conjunction/comma detection, even though `compromise` correctly
  tags them as bare verbs. This was the one regression corpus validation found against the
  annotated ground truth: without the exclusion, "Select, and have each affected employee use, the
  types of PPE…" (`fixtures/annotations/osha-ppe-requirements.json`, a confirmed real defect) went
  from a `one-instruction-per-sentence` **candidate** — this project's own candidate/adjudication
  architecture working as intended — to an immediate `deterministic-violation`, skipping semantic
  adjudication. The verdict was right; the architecture was bypassed for the wrong reason, and the
  same tag would misfire on ordinary descriptive prose using "have" as an auxiliary near an
  unrelated "and".

Add project verbs with `extraImperativeVerbs`; they are taught to `compromise` the same way the
built-in domain lexicon is (same already-known-as-verb guard), so a configured verb genuinely
participates in mood detection.

**Measured corpus effect** (`fixtures/original/*.md`, all 18 documents, before/after this change):

| Rule                           | Before | After | Note                                                                                                                                                                                           |
| ------------------------------ | -----: | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list-instruction-structure`   |      3 |     3 | Unaffected — does not depend on imperative/function-word detection.                                                                                                                            |
| `one-instruction-per-sentence` |      6 |     6 | Same count; composition unchanged after the auxiliary-verb fix above.                                                                                                                          |
| `noun-cluster-candidate`       |     70 |    48 | −22. This rule has **zero** confirmed true positives in 35 reviewed candidates (below); every removed candidate is a reduction of an already-100%-false-positive heuristic, not a recall loss. |
| `ambiguous-pronoun-candidate`  |     68 |    60 | −8. Both of the rule's 2 confirmed true positives (`httpd-mod-ssl-directive-config`, `postgres-vacuum-overview`) were checked directly and are still generated as candidates.                  |

The one confirmed `one-instruction-per-sentence` true positive (`osha-ppe-requirements`) was also
checked directly and is still generated as a candidate, not a hard violation.
