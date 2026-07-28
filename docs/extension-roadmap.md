# Extension roadmap

An assessment of where this linter can go next, framed against
[humanizer-stack](https://github.com/NulightJens/humanizer-stack) (MIT, with CC BY-SA
portions) — a project solving an adjacent problem with the opposite goal.

Everything stated about humanizer-stack below was read from a clone of the repository at
`main`, not recalled. Where a claim is about behaviour, it was produced by running the
code.

---

## 1. What humanizer-stack actually is

Thirteen files. Two Python scanners totalling about 400 lines, and three prompt documents
packaged as Claude Code Skills.

| Component                                                | Lines | What it is                                        |
| -------------------------------------------------------- | ----: | ------------------------------------------------- |
| `scripts/copy_scan.py`                                   |   172 | Regex scanner, 4 rule groups, surface tells       |
| `skills/structural-humanizer/scripts/structural_scan.py` |   228 | Regex scanner, 4 rule groups + 5 document metrics |
| `skills/humanizer/SKILL.md`                              |   476 | Prompt: the judgement half of the surface pass    |
| `skills/structural-humanizer/SKILL.md`                   |   152 | Prompt: six discourse audits, run one at a time   |
| `docs/PIPELINE.md`                                       |    83 | Pass ordering and layer ownership                 |

The architecture is a **two-pass pipeline**: pass 1 fixes words and punctuation, pass 2
fixes discourse shape, in that order, with an optional third "voice layer" the user owns.
Each pass pairs a deterministic scanner (the grep-able slice) with an LLM prompt (the
judgement slice). Scanners support `--json`, `--strict` (exit 1), stdin, and an inline
`copy-ignore` suppression marker.

Its structural pass is grounded in a cited result: the StoryScope study classified 61,608
stories using discourse features only, with every style feature withheld, at 93.2% F1 —
and a professional span-level surface rewriter dropped detection by just 1.6 points. The
repo's argument follows from that: surface tells are a decaying target, structural tells
are not.

The rule groups, verbatim from the source:

- **Surface** — `copy-em-dash`, `copy-antithesis` ("it's not just X, it's Y"), `hype-copy`
  (a 17-pattern marketing-cliché list), `copy-servile` ("Great question", "In conclusion").
- **Structural** — `embodied_emotion`, `stated_lesson`, `tidy_closer` (scanned only in the
  final two paragraphs), `vague_allusion` ("experts say", "studies show").
- **Metrics** — `paragraph_length_cv` (flagged uniform below 0.35), `reader_address_per_100w`,
  `numbers_per_100w`, `no_concrete_numbers`, `word_count`.

---

## 2. The two projects want opposite things

This matters more than any feature comparison, and it decides what can be shared.

Simplified Technical English is a **convergence goal**. The entire point of a controlled
language is that every author writes `use`, never `utilise`; that every instruction has
one action; that two writers describing the same procedure produce nearly the same text.
Uniformity is the deliverable.

Humanizing is **convergence avoidance**. humanizer-stack's sharpest observation is what it
calls "the trap": all five studied models occupy one tight region of structural space while
humans are dispersed, so _rarity is the human signal_. If every piece you fix opens
mid-scene and ends unresolved, you have built a new detectable cluster.

So the same engine can serve both only if the direction of preference lives in **data, not
code**. It already does: preferred terminology, vocabulary lists, limits and rule
enablement are all rule-pack fields, and `docs/rule-pack-import.md` documents the boundary.
A humanizing pack would set `preferredTerminology` to _widen_ rather than narrow. Nothing in
`src/core/` needs to know which direction it is pushing.

One caveat that is not symmetric: our autofix gate applies the same replacement everywhere,
deterministically, by design. That is right for STE and is exactly the trap for humanizing.
A humanizing pack must therefore ship with `autofix.enabled: false` and rely on suggestions,
which the diagnostic shape already supports.

---

## 3. What transfers, and what it costs

Ranked by value over effort. The taxonomies are the cheap part; the architecture underneath
them is where the work is.

### 3.1 An "AI-writing tells" rule pack — small, blocked on licensing

Most of the surface taxonomy maps onto rule shapes that already exist. `hype-copy` and
`copy-servile` are lexical lists, which is what `unapproved-vocabulary` and
`preferred-terminology` already consume from a pack. `copy-antithesis` is a phrase-pattern
rule of the same shape as `no-contractions`. `vague_allusion` is one new rule.

**This is blocked, and the blocker is real.** humanizer-stack's surface taxonomy derives in
part from Wikipedia's _Signs of AI writing_, which is CC BY-SA 4.0 — a share-alike licence.
This repository is MIT, and `test/fixtures/corpus.test.ts` already asserts that no fixture
carries a share-alike or copyleft licence. Importing those word lists into a bundled pack
would pull share-alike obligations into MIT-licensed source. The rule-pack import boundary
is the correct place to handle this: ship such a pack **separately, under its own licence,
loaded via `rulePack`**, never bundled — the same reasoning that keeps ASD-STE100 content
out of this repository. Any pack derived from that material must also be authored from the
licensed text by someone who has it, not reconstructed.

### 3.2 Document-scope rules — medium, and we are close

Their metrics are all computable from what `AnalysedDocument` already carries. Paragraph
length coefficient of variation needs `doc.blocks`; reader-address and numbers-per-100-words
need `doc.sentences` and `doc.words`. Nothing new is required to compute them.

Two things are genuinely missing:

- **Position as a rule input.** `tidy_closer` only fires in the final two paragraphs. Our
  `RuleInput` has no notion of where in the document a block sits, so a rule cannot express
  "only near the end". Adding a block ordinal and a document-relative position is small and
  useful beyond this one case — an STE rule wanting "the first sentence of a procedure"
  needs the same thing.
- **A category for measurements.** `paragraph_length_cv = 0.31` is not a violation; it is a
  number a human should look at. All five current diagnostic categories assert something is
  wrong. Forcing a metric into `review-required` would overstate it. A sixth category —
  `observation` — carrying a value and a reference range fits the existing philosophy: we
  already refuse to let silence mean compliant, and we should equally refuse to let a
  measurement masquerade as a defect.

### 3.3 Corpus-scope analysis — large, and a real architectural extension

Their sixth audit, "shape convergence", asks whether this piece has the same skeleton as
your last three. Our architecture has no place to put that question: every entry point
analyses exactly one document, and that isolation is deliberate — it is what makes runs
deterministic and cacheable.

Supporting it means a new input, something like a `CorpusProfile`: a set of previously
computed document-level feature vectors, passed in explicitly by the caller, never read from
disk by the core. Determinism survives because the profile is an argument, not ambient
state. This is worth doing for STE too: "this manual's sentence-length distribution has
drifted from the rest of the set" is a genuine controlled-language question we cannot
currently ask.

### 3.4 Things to take outright

- **Inline suppression.** Taken, and now implemented in the core rather than left to
  `textlint-filter-rule-comments`. For a linter making provisional claims this was close to a
  requirement — without it, a false positive can only be silenced by disabling the rule
  globally. Their `copy-ignore` line marker was the minimum viable form; what shipped adds a
  required reason, a range form, and a record of every withheld finding. See
  [suppression.md](suppression.md).
- **Per-category document thresholds.** Their `--strict` fails only when a category reaches
  a count (2 hits, not 1), which is the right shape for a heuristic with known
  false positives. Our CLI has an exit-code contract but no "fail if more than N of X".
- **Measured rates in rule metadata.** Their references carry rates ("narrator explains the
  theme 77% of the time against 52% for humans"), which is what makes a heuristic
  auditable. We could not do this before; as of the candidate adjudication we can. Every
  candidate rule now has a measured precision on a real corpus, and those numbers belong in
  `RuleMetadata` next to `sourceRef`, not only in prose. See
  [provisional-rules.md](provisional-rules.md#measured-precision-of-the-candidate-heuristics).
- **Genre calibration.** Their `genre-calibration.md` selects which audits apply per genre.
  We have `appliesTo` over procedural/descriptive mode and a `category` field on fixtures,
  but no per-genre applicability. Genre is orthogonal to mode and would let a pack say "this
  rule applies to maintenance procedures, not to API reference".
- **Aspect-at-a-time evaluation.** They cite 95% issue detection when audits run one at a
  time against 68% combined, and their structural pass is built around it. Our semantic
  subsystem already does exactly this — eight narrow evaluators, one concern each — which is
  independent corroboration of a design choice we made on other grounds. Worth citing in
  `docs/semantic-evaluators.md`.

---

## 4. What not to copy

Their scanners are line-based regex over raw text with no model of what is code. The
consequence is demonstrable. Given this file:

````markdown
Install the package before you start.

```js
const label = 'Setup — step one';
run(label);
```
````

The value is `a — b` in the table.

````

`copy_scan.py` reports an em-dash violation on the `const label` line — inside a fenced
JavaScript block, in a string literal. Its guard is a prefix test for comment markers
(`^\s*(\*|//|/\*|<!--|#|>|\||```)`), which a line beginning `const` does not match. The
inline-code case on the last line is correctly suppressed, by a separate pattern; the fenced
block is not.

This is the entire class of defect that this repository's protected-region machinery exists
to eliminate, and it is the argument for porting a taxonomy onto this engine rather than
adopting their tool: 28 detection passes over progressively masked text, exact offset
preservation, and a content-versus-structural distinction, all of which a new rule inherits
for free.

The second thing not to copy is the unstructured judgement layer. Their audits are prose
instructions to a model with no schema, no confidence, no calibrated threshold, and no
ground truth — so a verdict cannot be validated, measured, or refused. Our broker rejects
malformed, contradictory or out-of-range output, records model and prompt version, and
separates model-reported confidence from operator-owned thresholds. Any taxonomy we import
should route through that, not around it.

---

## 5. Proposed sequence

Ordered so each step is independently useful and none depends on resolving the licence
question.

1. **Inline suppression in the core.** _Implemented._ Three `ste-ai-ignore-*` HTML-comment
   directives, honoured in both `markdown` and `text` documents, with a required reason, a
   refusal inside safety admonitions, and every withheld finding recorded in
   `AnalysisResult.suppressions` rather than discarded. See [suppression.md](suppression.md).
2. **Block position in `RuleInput`.** Small, enables position-sensitive rules of any kind.
3. **The `observation` diagnostic category, plus the first document metrics** — sentence and
   paragraph length distribution, and reading-level-adjacent counts. Directly useful for
   STE: distribution drift is a controlled-language question we cannot currently express.
4. **Measured precision into `RuleMetadata`**, sourced from the candidate adjudication
   records so the numbers regenerate rather than rot.
5. **Per-category thresholds in the CLI exit-code contract.**
6. **Genre as a pack-declared applicability axis.**
7. **`CorpusProfile`** — the cross-document input. Largest change; do it last, and only once
   there are document metrics worth comparing.

A humanizing pack is deliberately absent from this list. Steps 1–6 are what such a pack
would need to exist at all, and step 3 is what makes it more than a regex list. The
licensing question should be settled before any of that taxonomy is written down here.

---

## Attribution

humanizer-stack is MIT for its own work, with portions under CC BY-SA 4.0 (Wikipedia
WikiProject AI Cleanup) and MIT (`@blader/humanizer`, `jcarterjohnson/vibecoded-design-tells`).
No code or word list from it has been copied into this repository. The StoryScope figures
quoted above are as stated in its README; they have not been independently verified here.
````
