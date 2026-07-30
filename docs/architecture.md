# Architecture

## Shape

One npm package, six internal modules with an enforced dependency direction:

```
core            → (nothing internal)      domain types, offsets, protected regions, segmentation,
                                          rule contract, fix gate, runner
rule-pack       → core                    schema, loader, bundled provisional pack  [IMPORT BOUNDARY]
deterministic   → core, rule-pack         the 14 rules
model-client    → core                    llama.cpp HTTP transport, cache      [NO RULE LOGIC]
semantic        → core, rule-pack,        broker, evaluators, prompt loader, response schema
                  model-client
analysis        → core, rule-pack,        composition root: analyseText / analyseTextDeterministic
                  deterministic, semantic
textlint        → core, rule-pack,        node ↔ core translation, preset       [NO RULE LOGIC]
                  deterministic, semantic,
                  analysis
fixture-tools   → core, rule-pack         manifest/annotation schemas, corpus validation
evaluation      → all except textlint     evaluator measurement (a leaf: nothing imports it)
cli             → all of the above        argument parsing and output formatting only
```

`evaluation` is deliberately its own module rather than part of `fixture-tools`. Measuring an
evaluator requires running the real rule set and the real broker, so it needs almost every layer;
keeping it separate lets `fixture-tools` — which the library itself uses for corpus validation — stay
restricted to `core` and `rule-pack`.

The repository has no monorepo justification, so the boundaries are enforced by a test rather than by
package topology: `test/architecture/module-boundaries.test.ts` parses every relative import in
`src/` and asserts the direction, plus three prohibitions:

- `core` imports no textlint package and performs no HTTP;
- `model-client` never imports `semantic`, `deterministic` or `rule-pack`;
- no file under `src/textlint` declares rule metadata, an options schema, or builds a diagnostic;
- no file under `src/deterministic` touches `node:fs`, `node:http`, or `fetch`.

## The offset contract

Everything downstream of parsing depends on one property: **an offset obtained at any stage is a
valid offset into the original source text.** It is maintained by never rewriting text — only masking
it.

### Document reading: current implementation, and where it is going

The diagram below is what `src/core/document.ts` runs today — regex passes over progressively masked
text, selected by a two-value `format: 'markdown' | 'text'` flag (`src/core/types.ts:176`) — and it is
not the intended permanent design. [Issue #25](https://github.com/Jamie-BitFlight/textlint-ASD-ai/issues/25)
records the cost: `noun-cluster-candidate` measured 0 confirmed defects in 35 reviewer-adjudicated
candidates ([issue #11](https://github.com/Jamie-BitFlight/textlint-ASD-ai/issues/11)), with the false
positives traced to a line scanner disagreeing with a table cell, a `See [` link, and a directive name
followed by its title line — constructs a real parser reads correctly and a line scanner reliably does
not. `src/textlint/adapter.ts:168-172` already builds a markdown AST via the textlint kernel and
discards it, calling `getSource(node)` and re-scanning the string with this same regex machinery.
Prose is not part of that defect: the same three sentences written as one line or as six
soft-wrapped ones already produce byte-identical diagnostics, because segmentation works over blocks,
not physical lines — the weakness is specifically structured constructs, not prose in general.

The stated direction (issue #25) is a pluggable `DocumentReader`, one implementation per media type —
a real parser for Markdown, a minimal reader for plain text, with the interface open to RST, HTML and
docx readers later without a change below it — feeding a reader-agnostic prose checker. The rule
contract described further down already qualifies as reader-agnostic: it reads only `sentence.masked`
and `sentence.words`, never the raw document. Positions would then trace back through the reader's own
AST rather than through hand-rolled offsets. This is in progress on this branch, being implemented
separately from this document; nothing below reflects that change yet — the pipeline that follows is
what actually runs today.

```
raw text
  │
  ├─ extractProtectedRegions()      passes run in a fixed order over progressively-masked text,
  │                                 so a later pattern cannot match inside an earlier region
  │
  ├─ buildStructuralMask()          content regions masked, structural markers left visible
  │      └─ scanBlocks()            paragraphs, headings, list items, table cells, block quotes,
  │                                 each with mode (procedural/descriptive) and admonition register
  │
  ├─ maskRanges() → full mask       every opaque region masked
  │      └─ segmentSentences()      sentence-splitter over masked text, per block
  │             └─ tokenizeWords()  words from masked text, plus one synthetic word per
  │                                 content-bearing protected region
  │
  └─ AnalysedDocument               absolute ranges throughout
```

Masking replaces characters with U+FFFD and **preserves length exactly** — newlines are never masked,
so line/column arithmetic is unaffected. `maskedText.length === text.length` is asserted by test.
This is why an index into a masked sentence is directly usable as a source offset, with no
translation table anywhere in the codebase.

Two mask levels exist because they answer different questions:

| Mask       | Masks                | Used for                                     | Why                                                          |
| ---------- | -------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| structural | content regions only | block scanning                               | the scanner needs `#`, `-`, `1.`, `\|` to find blocks at all |
| full       | every opaque region  | segmentation, word tokenising, rule matching | a rule must never read a literal as prose                    |

### Words versus literals

A protected region is one of two things, and the distinction matters:

- **content-bearing** (`inline-code`, `url`, `numeric-expression`, `identifier`, `placeholder`,
  `quoted-literal`, …) — becomes exactly one `Word` with `protectedKind` set. It **counts** toward
  sentence-length limits, because a reader still has to read `25 Nm`; it is **never** matched against
  a vocabulary list.
- **structural markup** (`list-marker`, `heading-marker`, `table-markup`, `emphasis-marker`, …) —
  produces no word at all.

Vocabulary rules filter on `protectedKind === undefined`. Length rules do not.

### Protected-region containment

The runner drops a diagnostic only when its span contains **no prose at all** — see
`pointsOnlyAtProtectedContent()`. Rejecting on mere _overlap_ is wrong and was a real defect: a
sentence-length diagnostic legitimately spans a sentence that contains a quantity or an inline code
span, and overlap-rejection silently discarded those findings. There is a regression test for it.

## Rule contract

```ts
interface DeterministicRule<TOptions> {
  meta: RuleMetadata; // stable id, provisional/normative status, sourceRef, fixable…
  optionsSchema: ZodType<TOptions>; // must accept {}
  run(input: RuleInput<TOptions>): { diagnostics: Diagnostic[]; candidates: CandidatePassage[] };
}
```

Rules are pure: same `AnalysedDocument` plus same options gives the same output. They do no I/O and
hold no state.

A rule does **not** get to decide:

| Concern                                | Enforced by                                          |
| -------------------------------------- | ---------------------------------------------------- |
| severity                               | `buildDiagnostic()` + the runner's severity override |
| whether a fix may be applied           | `gateFix()`, called by the runner for every fix      |
| whether it may read protected content  | `meta.inspectsProtectedRegions` + the runner         |
| whether `review-required` is reported  | the diagnostic policy                                |
| request ordering, concurrency, caching | the semantic broker                                  |

The runner applies these after the rule returns, so a rule cannot opt out of them.

## Diagnostic categories

Five, deliberately distinguished so a reader knows how much weight a finding carries:

| Category                      | Meaning                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `deterministic-violation`     | an exact trigger fired; no inference                                                                                        |
| `probable-semantic-violation` | a model returned `violation` at or above the operator's threshold                                                           |
| `review-required`             | undecidable: a heuristic hit that was not adjudicated, or an `uncertain` verdict, or a passage the service could not decide |
| `suppressed-low-confidence`   | a `violation` below threshold, discarded (reportable)                                                                       |
| `infrastructure-failure`      | the tooling failed; never a statement about the document                                                                    |

## Semantic subsystem

Rules never issue HTTP requests. They emit `CandidatePassage` values; one `SemanticBroker` decides
whether, when and how often to call a model.

```
CandidatePassage[]
  │
  ├─ enabled? no  → every candidate becomes a `disabled` failure → review-required
  │
  ├─ evaluator selection (config.semantic.evaluators)
  ├─ deterministic work order (sorted by candidate id)
  ├─ buildEvaluatorRequest()   only the payload keys the evaluator declares are sent
  ├─ content-hash de-duplication   identical questions share one request and one cache entry
  ├─ cache lookup
  ├─ bounded-concurrency worker pool
  │      ├─ transport attempt, retried only for retryable transport faults
  │      ├─ validateSemanticResponse()  schema + range + contradiction checks
  │      └─ at most `maxRepairAttempts` (≤1) bounded re-ask restating the contract only
  └─ outcomes returned in the caller's original order
```

The hash covers evaluator id, prompt version, model id, temperature, and the rendered messages —
everything that can change the answer. Changing any of them misses the cache, which is what makes
cached runs reproducible rather than merely fast.

### Why narrow evaluators

There is no "check this text against the whole scheme" request. Eight bounded classification tasks
exist instead, each with its own versioned prompt asset and its own minimal payload. A broad request
cannot be measured, cannot be calibrated, and cannot be traced back to a rule. See
[`semantic-evaluators.md`](./semantic-evaluators.md).

### Model output is never trusted

`validateSemanticResponse()` is the only way a response becomes a verdict. It rejects: non-JSON,
extra keys, out-of-range confidence, a reversed or out-of-bounds evidence span, a mismatched rule id,
and four kinds of self-contradiction (compliant-with-replacements, compliant-with-meaning-not-
preserved, replacement-while-denying-meaning-preservation, uncertain-at-very-high-confidence).
Grammar-constrained decoding via `response_format: json_schema` is a convenience, not a trust
boundary — validation runs regardless of how the text was produced.

## Autofix

Two gates, both mandatory.

1. **`checkFixSafety(before, after)`** — refuses any substitution that changes a digit, a negation, a
   modal verb, or an ordering word. Negative contractions and register variants of ordering words
   (`whilst`/`while`, `prior to`/`before`) are normalised first, so the check compares _relations_
   rather than spellings.
2. **`gateFix()`** — refuses when autofix is off, when the rule is not `fixable`, when the span sits
   in any admonition (`danger`/`warning`/`caution`/`note`), when the span overlaps a protected
   region, or when a `semantic-gated` fix is not explicitly permitted.

`autofix.allowInAdmonitions` is typed `z.literal(false)`: the refusal is explicit and testable rather
than implicit.

A semantic rewrite additionally requires an **independent** `rewrite-equivalence` request — the
evaluator's own `meaningPreserved` flag is not sufficient, because it comes from the same call that
proposed the change — and every protected literal in the span must survive verbatim.

Overlapping fixes are refused **on both sides** rather than resolved by precedence. Two rules
disagreeing about the same characters is the situation where an automated edit is least trustworthy.

## textlint adapter

The whole document is analysed once, by the core; each textlint rule reports only the diagnostics
carrying its own id. Consequences:

- protected regions, segmentation and the fix gate are applied once, identically, for all rules — a
  rule cannot disagree with its neighbours about what is code;
- diagnostics are reported against the `Document` node, whose range starts at 0, so the relative
  padding textlint wants equals the absolute offset the core produced;
- a 14-rule preset performs one analysis and at most one round of semantic requests.

Per-document configuration that textlint cannot express per rule (rule pack, semantic service,
autofix policy, protected terminology) is read from a shared file — see
[`configuration.md`](./configuration.md). Option layers are merged key by key, lowest first: shared
file, `shared` override, the rule's own textlint options. Replacing an object wholesale would drop an
`enabled: false` set by a lower layer; there is a test for that.
