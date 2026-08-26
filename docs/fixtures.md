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

Only sources whose licence permits redistribution are included. A share-alike or copyleft licence
excludes a source. It would propagate its obligations onto the rewritten counterpart, which is an
adaptation.

Accepted licences:

- public domain (US federal government works, SQLite)
- `MIT`
- `BSD`
- `Apache-2.0`
- the curl licence
- the PostgreSQL licence
- `CC-BY-4.0`

`derivativeLicence` records the licence of the counterpart. Permissive and public-domain sources get
`MIT (this repository)`. `CC-BY` sources get `CC-BY-4.0`, where attribution propagates. The validator
enforces this and rejects any share-alike or copyleft licence outright.

Composition:

| Licence                            | Fixtures |
| ---------------------------------- | -------- |
| Public Domain (SQLite)             | 4        |
| Public Domain (US Government work) | 2        |
| `Apache-2.0`                       | 4        |
| `Apache-2.0 WITH LLVM-exception`   | 2        |
| `CC-BY-4.0`                        | 2        |
| PostgreSQL Licence                 | 1        |
| `BSD-3-Clause`                     | 1        |
| curl licence                       | 1        |
| `MIT`                              | 1        |

## Provenance is auditable, not asserted

`scripts/fetch-sources.mjs` downloads every source and writes `provenance.lock.json` with the real
HTTP status, byte count, SHA-256 and fetch timestamp. The manifest references a lock key per fixture,
and the validator cross-checks: a fabricated entry cannot pass.

```bash
vp run fixtures:fetch      # re-download and rewrite the lock (needs network)
vp run fixtures:validate   # build, then verify everything below
```

`validateFixtureCorpus()` checks:

- the manifest and lock satisfy their schemas.
- each `originalSha256` matches the committed file.
- each `provenanceKey` resolves to a lock record with a 2xx status and non-zero bytes, whose URL
  corresponds to the fixture's `sourceUrl`.
- no share-alike or copyleft licence, and a licence quote of at least 10 characters with a URL.
- `CC-BY` sources propagate attribution into `derivativeLicence`.
- category minimums (≥ 2 per category across 9 categories) and corpus size (≥ 15).
- `heldout` is at least 25% of the corpus, and the splits are disjoint by content hash.
- no unlisted files in `fixtures/original/`.
- **protected literals are byte-identical** between an original and its counterpart.
- annotations parse, agree with the manifest split, quote text that actually exists, and use real
  character offsets.

## Categories

Each category has at least two fixtures:

- `installation`
- `maintenance`
- `troubleshooting`
- `safety-warning`
- `descriptive`
- `api-configuration`
- `cli-reference`
- `structured-content` (tables + lists + code blocks)
- `hard-negative`

`hard-negative` fixtures were selected because a naive linter flags them _wrongly_. Examples include
long sentences that are really lists of identifiers, correct passive constructions, and dense
abbreviation use. They also include SQL keywords that look like unintroduced abbreviations. These
fixtures exist to keep false positives visible, and their annotations mostly record `disputed`
findings rather than rewrites.

## Splits

`dev` (12 fixtures) is for tuning rules, prompts and thresholds. `heldout` (6) is for reporting
evaluator quality and must not be tuned against.

The separation is enforced three ways. The validator asserts the splits are disjoint by content
hash, and that `heldout` is ≥ 25% of the corpus. `vp run eval:semantic` defaults to `heldout`, and
requires `--split all` to mix. A test also asserts no `heldout` content hash appears in `dev`.

## Rewriting rules

A counterpart applies **minimal edits**. A sentence with no defect is copied through byte for byte.
This is not a style rewrite.

Byte-identical in both versions:

- fenced and inline code, shell commands, literal output.
- identifiers, API names, and field names.
- constants, flags, and environment variables.
- email addresses, file paths, and URLs.
- product, component and part names.
- version strings.
- every number, quantity, tolerance, range and unit.
- placeholders.
- table structure and cell literals.
- the required order of procedural steps.

Preserved in meaning:

- negation.
- preconditions and conditions.
- actor responsibility.
- modal force — `must` / `shall` / `should` / `can` / `may` / `do not` are never softened or
  strengthened.
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
alone. A reviewer is not obliged to satisfy a heuristic. The tests are built so that refusing does
not fail the build. A fixture with no accepted change must simply be a `hard-negative`, or carry a
`notes` explanation. It must also record something as `disputed` or `deferred`.

## How the adjudication was run

The corpus holds two populations of record, produced by different runs over different partitions.
Conflating them is easy and the distinction matters, so state it first:

| Records                  | Count | Produced by                       | Partition              | Provenance in the data   |
| ------------------------ | ----: | --------------------------------- | ---------------------- | ------------------------ |
| `candidateAdjudications` |   105 | `reviewer-a` through `reviewer-d` | 5 / 4 / 4 / 4 fixtures | `reviewerKind`, required |
| `changes`                |    70 | `rewriter-a`, `rewriter-b`        | 9 fixtures each        | `reviewerKind`, required |

**`candidateAdjudications` comes from four independent agent reviewers**, one per
`fixtures/verdicts/` file. Each reviewer judges a passage against the rule intent in
`provisional-rules.md`, and nothing else. No human produced any of these 105 records. Every record
carries `reviewerKind`. That makes the question answerable from the data itself, not from this
paragraph. The field is required and undefaulted, so a record can never omit it. Duplicate keys are
refused too. The answer a reader gets from the bytes is the answer every consumer gets from the
parse. `reviewer` (one of `reviewer-a` through `reviewer-d`) is a label for which run produced a
verdict, never a person.

**`changes` — the 70 rewrite records** behind the 32 accepted / 36 disputed / 2 deferred figures in
`implementation-report.md`. These carry the same required `reviewer` and `reviewerKind` as the
adjudications. They did not at first, and the gap was not cosmetic. The only trace of who wrote a
rewrite used to be the annotation's `reviewers` array. That array was an assertion no record pointed
into. So a name could be added to it, or removed from it, without contradicting anything else in the
file. It is now derived — exactly the set of names the two record populations carry.
`merge-candidate-verdicts.mjs` refuses a file where it is anything else.

Be precise about what that buys, because it is less than it sounds. The adjudications are pinned to
something outside their own file. Each one binds to a live candidate passage, so it cannot be
invented. The rewrite records are not. Editing every `changes[].reviewer` in an annotation, together
with its `reviewers` array, is self-consistent. So is adding a rewrite that never happened. So is
deleting four rewrites that did happen. Measured, all three pass the merge tool untouched.

What refuses them is `scripts/ci/check-annotation-provenance.sh`. It took three attempts to get
there, each defeated by the same mistake. A check that constrains an aggregate is defeated by
whatever rearrangement preserves that aggregate. The totals are preserved by moving credit between
two fixtures in opposite directions. Those totals are: 105 adjudications, 70 rewrites, the per-run
split, and every record saying `agent`. The per-fixture reviewer sets closed _that_ hole. But those
sets are preserved too, by shuffling record counts between fixtures that credit the same run. This
was measured directly. Splicing a real `disputed` record out of `curl-url-option-reference` passed
every gate in the project. So did dropping in a second copy of that file's own `accepted` record.
That swap also moved the split reported above from 32 / 36 to 33 / 35.

So the script also declares a digest of each fixture's annotation. Object keys are sorted, so
reformatting is not a change. Array order is preserved, so reordering is a change. That pins content
rather than counts. Content is the only thing left to pin when a record binds to nothing outside its
own file.

The digest covers the whole annotation rather than only its `changes`. The reason is worth
recording, because the narrower version seemed like enough. An adjudication binds to a live candidate
passage, so it seemed anchored. But the binding constrains _where a record sits_, not _what it says_.
`verdict`, `reason`, and `reviewerConfidence` are copied from the reviewer row and checked against
nothing. The only things constraining them were two aggregates in `corpus.test.ts`, since replaced by
a record-by-record comparison against `fixtures/verdicts/`. Measured: demoting the corpus's two
confirmed `passive-voice-candidate` defects preserved both aggregates. So did promoting two other
passages of the same rule instead. It passed every gate. It also quietly changed which passages the
semantic evaluators are scored against.

Two smaller things follow from hashing parsed values rather than bytes. Duplicate JSON keys make the
file on disk and the value every check sees disagree. `JSON.parse` keeps the last key and says
nothing about the conflict. So every JSON file under `fixtures/` is read through
`scripts/lib/parse-json-strict.mjs`, which refuses them. That scan covers the whole tree, not just
the annotations. The reason is worth recording. An earlier revision guarded only the annotations,
arguing the rest was defence in depth. A review disproved that: it moved the identical forgery one
directory over. `fixtures/verdicts/` is what the adjudications are _derived from_. So a duplicated
`reviewer` pair there flows the last value into every record. The committed annotation and its digest
stay byte-identical while that happens. The file still reads as human-audited, and `agent=175` still
matches. The same trick works on `manifest.json`. It makes the manifest document a share-alike
licence, while the validator reads the permissive duplicate. That walks straight through the gate
that exists to refuse copyleft.

Bytes are not hashed directly, even though that would also catch the problem. The repository sets no
`.gitattributes`, so a CRLF checkout would then fail for everyone on Windows.

All of these numbers and digests are expected to change when the corpus does. The point is that
changing them is a deliberate edit. It happens in the same commit as the edit that caused it. The
gate itself is covered by `test/e2e/check-annotation-provenance.test.ts`. That test exists because a
review once deleted each of its checks in turn. Even then, the project stayed green every time.

One more limit, since the field name invites the wrong reading. `reviewer` names the run that
produced an annotation's rewrites. It does not name the author of the text as it stands today. 11 of
the 70 records have had their content edited since. Later reconciliation commits made those edits,
and those commits recorded nothing about themselves.

What the adjudication method establishes, and what it does not:

- **Each passage was judged exactly once**. The four reviewers' fixture sets are pairwise disjoint.
  Measured, zero fixtures were shared between any pair. `merge-candidate-verdicts.mjs` also rejects a
  second verdict on the same `(ruleId, span)` as a duplicate. So there is no cross-check to appeal
  to. No passage was independently confirmed, and `goldLabelFor`'s disagreement path
  (`labels.size !== 1 → unlabelled`) never fires on this corpus. Agreement between reviewers is not
  weak evidence here. It is absent, because no two reviewers looked at the same thing.
- **The binding is enforced even though the judgement is not corroborated**. The merge tool binds
  each verdict to a `(ruleId, span, quote)` triple. A verdict that does not bind to a live passage
  fails the build.
- **The labels are model-authored ground truth for a model-based evaluator**. The semantic evaluators
  are scored against these records. A favourable score is therefore partly a measure of agreement
  between two similar applications of judgement. It is not an external check.
- **The reference documents were not written as controlled language**. A "false positive" here means
  a finding a reviewer judged wrong against the rule's stated intent. It does not mean a finding that
  contradicts any external standard. The corpus can therefore say a good deal about precision and
  very little about recall.

Treat the resulting figures as the project's own measurement of its own heuristics. They are reported
because a rule set with no measurement at all is worse. They are not reported because they are
independent evidence.

## What the records are bound to, and what would break the binding

`originalSpans`, and the `candidateAdjudications` merged in from `fixtures/verdicts/` (see
[`provisional-rules.md`](./provisional-rules.md#measured-precision-of-the-candidate-heuristics)),
both bind a verdict to a specific `(ruleId, span, quote)`. That binding assumes spans are derived the
way they are today, by the regex-based scanner. [Issue #25](https://github.com/Jamie-BitFlight/textlint-ASD-ai/issues/25)
proposes deriving spans from a real parser instead. If that change moves a span, the verdict recorded
against the old span no longer describes the new one. It then needs fresh review.
`scripts/ci/check-candidate-ground-truth.sh` already enforces this for candidate verdicts. A parser
adoption would need the same discipline applied to `originalSpans`.

That check runs `scripts/merge-candidate-verdicts.mjs --check`, which does two things. It refuses a
verdict that binds to no live passage. It also compares every record the verdicts produce against
what is committed in `fixtures/annotations/`. The second half is what makes the annotation files
themselves checked, rather than merely generated. An adjudication edited by hand there fails the
build. So does one left behind after its candidate moved. Neither sits in the corpus unnoticed. To
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

Never hand-write a provenance record: `scripts/fetch-sources.mjs` writes it for you.

1. Add the source to `scripts/fetch-sources.mjs`.
2. Run `vp run fixtures:fetch` to download it.
3. Verify the licence using the licence page or the repository `LICENSE` file.
4. Quote the licence verbatim in the manifest and in `LICENSES.md`.
5. Cut a verbatim excerpt of `300–2400` characters into `fixtures/original/<id>.md`, using the header
   comment the other fixtures use.
6. Add the manifest entry, including the file's committed `SHA-256`.
7. Write the counterpart and the annotation.
8. Run `vp run fixtures:validate && vp test test/fixtures`.
