# Fixture corpus

## What it is

18 excerpts of real, publicly licensed technical documentation, each with a carefully rewritten
counterpart and a machine-readable adjudication record.

```
fixtures/
  manifest.json           machine-readable provenance for every fixture
  provenance.lock.json    written by scripts/fetch-sources.mjs: real URL, HTTP status, SHA-256, bytes
  LICENSES.md             per-fixture attribution and verbatim licence quotes
  original/<id>.md        verbatim excerpt from the source
  compliant/<id>.md       this project's rewritten counterpart
  annotations/<id>.json   what changed, why, and what must not change
```

## Licence rules

Only sources whose licence permits redistribution **and is not share-alike or copyleft** are included:
public domain (US federal government works, SQLite), MIT, BSD, Apache-2.0, the curl and PostgreSQL
licences, and CC-BY-4.0. Share-alike and copyleft licences are excluded on purpose — they would
propagate their obligations onto the rewritten counterparts, which are adaptations.

`derivativeLicence` records the licence of the counterpart: `MIT (this repository)` for permissive and
public-domain sources, and `CC-BY-4.0` for CC-BY sources, where attribution propagates. The validator
enforces this, and rejects any share-alike or copyleft licence outright.

Composition:

| Licence                            | Fixtures |
| ---------------------------------- | -------- |
| Public Domain (SQLite)             | 4        |
| Public Domain (US Government work) | 2        |
| Apache-2.0                         | 4        |
| Apache-2.0 WITH LLVM-exception     | 2        |
| CC-BY-4.0                          | 2        |
| PostgreSQL Licence                 | 1        |
| BSD-3-Clause                       | 1        |
| curl licence                       | 1        |
| MIT                                | 1        |

## Provenance is auditable, not asserted

`scripts/fetch-sources.mjs` downloads every source and writes `provenance.lock.json` with the real
HTTP status, byte count, SHA-256 and fetch timestamp. The manifest references a lock key per fixture,
and the validator cross-checks: a fabricated entry cannot pass.

```bash
npm run fixtures:fetch      # re-download and rewrite the lock (needs network)
npm run fixtures:validate   # build, then verify everything below
```

`validateFixtureCorpus()` checks:

- the manifest and lock satisfy their schemas;
- each `originalSha256` matches the committed file;
- each `provenanceKey` resolves to a lock record with a 2xx status and non-zero bytes, whose URL
  corresponds to the fixture's `sourceUrl`;
- no share-alike or copyleft licence, and a licence quote of at least 10 characters with a URL;
- CC-BY sources propagate attribution into `derivativeLicence`;
- category minimums (≥ 2 per category across 9 categories) and corpus size (≥ 15);
- `heldout` is at least 25% of the corpus, and the splits are disjoint by content hash;
- no unlisted files in `fixtures/original/`;
- **protected literals are byte-identical** between an original and its counterpart;
- annotations parse, agree with the manifest split, quote text that actually exists, and use real
  character offsets.

## Categories

Each category has at least two fixtures:

`installation`, `maintenance`, `troubleshooting`, `safety-warning`, `descriptive`,
`api-configuration`, `cli-reference`, `structured-content` (tables + lists + code blocks),
`hard-negative`.

`hard-negative` fixtures were selected because a naive linter flags them _wrongly_: long sentences
that are really lists of identifiers, correct passive constructions, dense abbreviation use, SQL
keywords that look like unintroduced abbreviations. They exist to keep false positives visible, and
their annotations mostly record `disputed` findings rather than rewrites.

## Splits

`dev` (12 fixtures) is for tuning rules, prompts and thresholds. `heldout` (6) is for reporting
evaluator quality and must not be tuned against.

The separation is enforced three ways: the validator asserts the splits are disjoint by content hash
and that `heldout` is ≥ 25% of the corpus; `npm run eval:semantic` defaults to `heldout` and requires
`--split all` to mix; and a test asserts no `heldout` content hash appears in `dev`.

## Rewriting rules

A counterpart applies **minimal edits**. A sentence with no defect is copied through byte for byte.
This is not a style rewrite.

Byte-identical in both versions:

- fenced and inline code, shell commands, literal output;
- identifiers, API and field names, constants, flags, environment variables;
- URLs, email addresses, file paths;
- product, component and part names; version strings;
- every number, quantity, tolerance, range and unit;
- placeholders; table structure and cell literals;
- the required order of procedural steps.

Preserved in meaning:

- negation; preconditions and conditions; actor responsibility;
- modal force — `must` / `shall` / `should` / `can` / `may` / `do not` are never softened or
  strengthened;
- the distinction between instruction, description, note, caution and warning. A `WARNING` is never
  downgraded to a note, and no hazard statement is removed.

For the two safety fixtures the permitted changes are narrower still: vocabulary, contractions and
sentence splitting only. No requirement is restructured or merged, and no regulatory citation is
touched.

## Annotation records

`src/fixture-tools/annotation-schema.ts` is authoritative. Per change:

```jsonc
{
  "passageId": "sqlite-vacuum-space-reclaim-p1",
  "originalText": "…exact substring of the original…",
  "rewrittenText": "…exact substring of the counterpart…",
  "ruleIds": ["unapproved-vocabulary"],
  "originalSpans": [{ "start": 412, "end": 420 }],   // real offsets, checked by the validator
  "expectedDiagnostics": [
    { "ruleId": "unapproved-vocabulary", "category": "deterministic-violation", "quote": "utilise" }
  ],
  "reason": "…why the change was made, or why it was refused…",
  "semanticInvariants": ["the 500-hour interval", "the prohibition on removing the cover"],
  "unresolved": ["…anything a reviewer would not decide…"],
  "status": "accepted" | "disputed" | "deferred",
  "reviewer": "rewriter-a",
  "reviewerKind": "human" | "agent",   // required, like the adjudication records
  "reviewerConfidence": 0.9
}
```

`disputed` is a first-class outcome: it records that the linter was **wrong** and the prose was left
alone. A reviewer is not obliged to satisfy a heuristic, and the tests are built so that refusing does
not fail the build — a fixture with no accepted change must simply be a `hard-negative` or carry a
`notes` explanation, and must record something as `disputed` or `deferred`.

## How the adjudication was run

The corpus holds two populations of record, produced by different runs over different partitions.
Conflating them is easy and the distinction matters, so state it first:

| Records                  | Count | Produced by                | Partition              | Provenance in the data   |
| ------------------------ | ----: | -------------------------- | ---------------------- | ------------------------ |
| `candidateAdjudications` |   105 | `reviewer-a`…`reviewer-d`  | 5 / 4 / 4 / 4 fixtures | `reviewerKind`, required |
| `changes`                |    70 | `rewriter-a`, `rewriter-b` | 9 fixtures each        | `reviewerKind`, required |

**`candidateAdjudications` — four independent agent reviewers**, one per `fixtures/verdicts/` file,
each judging a passage against the rule intent in `provisional-rules.md` and nothing else. No human
produced any of these 105 records. Every one carries `reviewerKind`, so that is answerable from the
data rather than from this paragraph; the field is required and undefaulted precisely so a record can
never omit it. `reviewer` (`reviewer-a`…`reviewer-d`) is a label for which run produced a verdict,
never a person.

**`changes` — the 70 rewrite records** behind the 32 accepted / 36 disputed / 2 deferred figures in
`implementation-report.md`. These carry the same required `reviewer` and `reviewerKind` as the
adjudications. They did not at first, and the gap was not cosmetic: while the only trace of who
wrote a rewrite was the annotation's `reviewers` array, that array was an assertion no record
pointed into, so a name could be added to it or removed from it without contradicting anything in
the file. It is now derived — exactly the set of names the two record populations carry — and
`merge-candidate-verdicts.mjs` refuses a file where it is anything else.

Be precise about what that buys, because it is less than it sounds. The adjudications are pinned to
something outside their own file: each one binds to a live candidate passage, so it cannot be
invented. The rewrite records are not. Editing every `changes[].reviewer` in an annotation _and_ its
`reviewers` array together is self-consistent, and so is adding a rewrite that never happened or
deleting four that did — measured, all three pass the merge tool untouched.

What refuses them is `scripts/ci/check-annotation-provenance.sh`, and it took three attempts to get
there, each defeated by the same mistake: a check that constrains an aggregate is defeated by
whatever rearrangement preserves that aggregate. The totals (105 adjudications, 70 rewrites, the
per-run split, every record saying `agent`) are preserved by moving credit between two fixtures in
opposite directions. The per-fixture reviewer sets that closed _that_ hole are themselves preserved
by shuffling record counts between fixtures crediting the same run — measured, splicing a real
`disputed` record out of `curl-url-option-reference` and dropping in a second copy of that file's own
`accepted` record passed every gate in the project and moved the split reported above from 32 / 36 to
33 / 35.

So the script also declares a digest of each fixture's annotation: object keys sorted, so
reformatting is not a change, array order preserved, so reordering is. That pins content rather than
counts, which is the only thing left when a record binds to nothing outside its own file.

The digest covers the whole annotation rather than only its `changes`, and the reason is worth
recording because the narrower version looked obviously sufficient. An adjudication binds to a live
candidate passage, so it seemed anchored — but the binding constrains _where a record sits_, not
_what it says_. `verdict`, `reason` and `reviewerConfidence` are copied from the reviewer row and
checked against nothing, and the only things constraining them were two aggregates in
`corpus.test.ts`. Measured: demoting the corpus's two confirmed `passive-voice-candidate` defects
while promoting two other passages of the same rule preserved both aggregates, passed every gate,
and quietly changed which passages the semantic evaluators are scored against.

Two smaller things follow from hashing parsed values rather than bytes. Duplicate JSON keys make the
file on disk and the value every check sees disagree — `JSON.parse` keeps the last and says nothing —
so annotations are read through `scripts/lib/parse-json-strict.mjs`, which refuses them. Bytes are
not hashed directly because the repository sets no `.gitattributes` and a CRLF checkout would then
fail for everyone on Windows.

All of these numbers and digests are expected to change when the corpus does; the point is that
changing them is an edit somebody makes on purpose, in the same commit as the edit that caused it.
The gate itself is covered by `test/e2e/check-annotation-provenance.test.ts`, which exists because
a review deleted each of its checks in turn and the project stayed green every time.

One more limit, since the field name invites the wrong reading. `reviewer` names the run that
produced an annotation's rewrites, not the author of the text as it stands: 11 of the 70 records
have had their content edited since, by later reconciliation commits that recorded nothing about
themselves.

What the adjudication method establishes, and what it does not:

- **Each passage was judged exactly once.** The four reviewers' fixture sets are pairwise disjoint —
  measured: zero fixtures shared between any pair — and `merge-candidate-verdicts.mjs` rejects a
  second verdict on the same `(ruleId, span)` as a duplicate. So there is no cross-check to appeal
  to: no passage was independently confirmed, and `goldLabelFor`'s disagreement path
  (`labels.size !== 1 → unlabelled`) never fires on this corpus. Agreement between reviewers is not
  weak evidence here; it is absent, because no two reviewers looked at the same thing.
- **The binding is enforced even though the judgement is not corroborated.** The merge tool binds
  each verdict to a `(ruleId, span, quote)` triple, and a verdict that does not bind to a live
  passage fails the build.
- **The labels are model-authored ground truth for a model-based evaluator.** The semantic evaluators
  are scored against these records, so a favourable score is partly a measure of agreement between
  two applications of similar judgement, not an external check.
- **The reference documents were not written as controlled language.** A "false positive" here means
  a finding a reviewer judged wrong against the rule's stated intent — not a finding that contradicts
  any standard. The corpus can therefore say a good deal about precision and very little about recall.

Treat the resulting figures as the project's own measurement of its own heuristics. They are reported
because a rule set with no measurement at all is worse, not because they are independent evidence.

## What the records are bound to, and what would break the binding

`originalSpans`, and the `candidateAdjudications` merged in from `fixtures/verdicts/` (see
[`provisional-rules.md`](./provisional-rules.md#measured-precision-of-the-candidate-heuristics)),
both bind a verdict to a specific `(ruleId, span, quote)`, on the assumption that spans are derived
the way they are today, by the regex-based scanner.
[Issue #25](https://github.com/Jamie-BitFlight/textlint-ASD-ai/issues/25) proposes deriving spans
from a real parser instead; if that change moves a span, the verdict recorded against the old span
no longer describes the new one and needs fresh review.
`scripts/ci/check-candidate-ground-truth.sh` already enforces this for candidate verdicts; a parser
adoption would need the same discipline applied to `originalSpans`.

That check runs `scripts/merge-candidate-verdicts.mjs --check`, which does two things: it refuses a
verdict that binds to no live passage, and it compares every record the verdicts produce against
what is committed in `fixtures/annotations/`. The second half is what makes the annotation files
themselves checked rather than merely generated — an adjudication edited by hand there, or left
behind after its candidate moved, fails the build instead of sitting in the corpus unnoticed. To
regenerate rather than check, run the same script without `--check` and review the diff.

## Corpus tests

`test/fixtures/corpus.test.ts` asserts, over the real corpus:

| Assertion                                                          | Why                                           |
| ------------------------------------------------------------------ | --------------------------------------------- |
| the full validator passes                                          | provenance and licences                       |
| no diagnostic lands inside a code fence, on any fixture            | the protected-region guarantee, on real input |
| every diagnostic quotes non-empty real source                      | offset integrity, on real input               |
| no fix lands inside an admonition, on any fixture                  | the autofix policy, on real input             |
| protected literals survive every rewrite                           | corpus integrity                              |
| code fences are byte-identical across a pair                       | corpus integrity                              |
| violation count never increases after a rewrite                    | the rewrite did not make things worse         |
| violations decrease whenever a change was accepted                 | the rewrite did what the annotation claims    |
| every accepted change's expected diagnostic no longer fires        | the annotation is honest about the fix        |
| every expected diagnostic actually fires on the original           | the annotation is honest about the defect     |
| a fixture with no accepted change is documented as a hard negative | refusals are explicit                         |

## Adding a fixture

1. Add the source to `scripts/fetch-sources.mjs` and run `npm run fixtures:fetch`. Never hand-write a
   provenance record.
2. Verify the licence by fetching the licence page or the repository `LICENSE` file, and quote it
   verbatim in the manifest and in `LICENSES.md`.
3. Cut a verbatim excerpt of 300–2400 characters into `fixtures/original/<id>.md` with the header
   comment the other fixtures use.
4. Add the manifest entry, including the SHA-256 of the file as committed.
5. Write the counterpart and the annotation.
6. `npm run fixtures:validate && npx vitest run test/fixtures`.
