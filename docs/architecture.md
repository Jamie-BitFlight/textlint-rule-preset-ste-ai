# Architecture

## Shape

One npm package, six internal modules with an enforced dependency direction:

```
core            → (nothing internal)      domain types, offsets, protected regions, segmentation,
                                          rule contract, fix gate, runner
rule-pack       → core                    schema, loader, bundled provisional pack  [IMPORT BOUNDARY]
deterministic   → core, rule-pack         rule implementations
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
records the cost: `noun-cluster-candidate` measured 0 confirmed defects in 24 reviewer-adjudicated
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
- rules with no rule-specific options of their own share one analysis and, at most, one round of
  semantic requests. A rule that sets its own options gets a separate analysis scoped to it.

Per-document configuration that textlint cannot express per rule (rule pack, semantic service,
autofix policy, protected terminology) is read from a shared file — see
[`configuration.md`](./configuration.md). Option layers are merged key by key, lowest first: shared
file, `shared` override, the rule's own textlint options. Replacing an object wholesale would drop an
`enabled: false` set by a lower layer; there is a test for that.

## Document reader — design note (implemented; the async `DocumentReader` interface below since removed)

**Status.** The note below predates implementation and was never updated once the work landed (PR
#32, then a follow-on stage that wired the reader into `analysis`) — read it as a historical record
of the reasoning, not as a description of today's `src/reader/` module. Three things it proposed did
not survive contact with the constraints §3 and the code itself already state:

- The `DocumentReader` interface and its `read(): AsyncIterable<TextUnit>` method (§1) were built
  exactly as drafted, on `MarkdownReader`/`PlainTextReader`, but never gained a production caller.
  `analyseTextDeterministic` documents itself as performing no I/O — a contract existing callers
  rely on — and `analysis`'s other entry point, `analyseText`, called the reader's own synchronous
  core (`readMarkdownUnitsSync`/`readPlainTextUnitsSync`, added specifically so a synchronous caller
  had something to call) rather than `read()`, for no reason particular to it being async; it simply
  never needed to be. With zero callers actually awaiting the interface, "every caller already
  awaits" (§1's stated reason for making `read()` async ahead of any reader that needed it) turned
  out not to hold, so the `DocumentReader` interface and the two wrapper classes were removed
  (ponytail-audit yagni finding), leaving `readMarkdownUnitsSync`/`readPlainTextUnitsSync` as the
  real, and only, public reader API. Reintroduce an async seam when a reader that genuinely needs
  real I/O — docx, a remotely-fetched document — actually lands; at that point `analyseTextDeterministic`'s
  "no I/O" contract, not this note, is what should drive the interface's shape.
- §7 lists "`analysis` wired to select a reader by `DocumentFormat` and iterate its units" as in
  scope; what was actually built has `src/analysis/analyse.ts` call the synchronous functions above
  directly and build blocks from their output (see that file's own `readerBlocksFor` and its doc
  comment), not iterate an `AsyncIterable`.

The rest of this section — the parser choice (§2), the module-boundary reasoning (§3), the offset
contract demonstration (§4) and everything after — is otherwise still accurate: it was implemented as
described and is not repeated or corrected again below.

### 1. The `DocumentReader` interface and the text unit

```ts
/** One reader-recognised span of the document that the checker treats as a unit of judgement. */
export interface TextUnit {
  /** Stable within one `read()` call. Not stable across edits to the source — it is not a diff key. */
  readonly id: string;
  /** Reader-defined: `'paragraph' | 'heading' | 'list-item' | 'table-cell' | 'blockquote' | …`. */
  readonly kind: string;
  /** Offset into the ORIGINAL source text handed to `read()`. See §4 for how this is guaranteed. */
  readonly range: SourceRange;
  /** Raw source slice for `range`. */
  readonly text: string;
  readonly mode: TextMode;
  readonly admonition: AdmonitionKind;
  /** Nesting depth — heading level, list depth, blockquote depth. Same meaning as `TextBlock.depth`. */
  readonly depth: number;
}

export interface DocumentReader {
  readonly mediaType: DocumentFormat;
  /**
   * Async even though every v1 implementation is synchronous underneath. A reader for docx or a
   * remotely-fetched HTML document may need real I/O to produce its next unit, and there must be no
   * second interface for that later — every caller already awaits.
   */
  read(doc: SourceDocument): AsyncIterable<TextUnit>;
}
```

This is deliberately close to today's `TextBlock` (`src/core/types.ts:129-142`), not a rewrite of it.
`TextBlock` already carries `range`, `mode`, `admonition`, `depth` — the four fields a rule actually
reads. What it does not carry, and `TextUnit` must, is `id` as a first-class, reader-produced value:
today a candidate's diagnostic id is built by the _rule_ (`` `${spec.meta.id}:${sentence.id}:${range.start}` ``,
`src/deterministic/rules/candidate-rules.ts:38`) — the rule manufactures unit identity from a
`Sentence.id` that is itself just a counter. The task requires "on a unit's failure, the report names
which unit id failed and why," which means the id has to be something the _reader_ is answerable for,
not the rule.

`Sentence` (`src/core/types.ts:158-174`) does not become `TextUnit`. Sentence segmentation is a
prose-level operation done _within_ a unit's text (a paragraph is one to several sentences), not a
structural fact the reader knows. The checker still needs sentence boundaries for anything that
reasons per-sentence (`sentence-length-procedural`, `one-instruction-per-sentence`); that segmentation
step stays exactly where it is (`src/core/segmentation.ts`), just fed by `unit.text` instead of by a
block scanned out of regex-masked source. `words` similarly is not carried on `TextUnit` — masking
and tokenising happen after reading, over `unit.text`, for the reason in §6: they are not markdown
concerns.

### 2. Which parser, and why

**Recommendation: `@textlint/markdown-to-ast` (`15.7.1`), not a fresh `remark`/`unified` install.**

This was checked against the real package tree rather than assumed:

- `@textlint/markdown-to-ast` is already resolved in `node_modules` — it is a dependency of
  `@textlint/textlint-plugin-markdown`, which `textlint` (a devDependency here, `>=13` as an
  **optional** peer per `package.json`) depends on for its own markdown plugin. It is _not_,
  however, currently part of this package's own runtime dependency graph — `textlint` is optional,
  so an installer of `textlint-rule-preset-ste-ai` alone does not necessarily get it. Depending on it
  directly in `dependencies` is a real, new cost, not a free ride; I want to be honest about that
  rather than claim it costs nothing because it happens to already be on disk in this dev tree.
- What it buys: its `TxtNode` shape (`@textlint/ast-node-types`, already a genuine transitive
  runtime dependency via `sentence-splitter`) is `{ range: readonly [number, number], loc: {...}, ... }`
  — exactly the AST the textlint kernel itself builds and, per the paragraph above this section,
  currently discards at `src/textlint/adapter.ts:168-172`. Adopting it means the reader produces the
  same node shape the rest of this codebase's textlint integration already type-checks against,
  rather than a second, unrelated AST convention (mdast) existing alongside it for no reason.
- The version pinned inside `markdown-to-ast` is old — `unified@9.2.2`, `remark-parse@9.0.0`,
  `mdast-util-from-markdown@0.8.5` — versus current `remark`'s `unified@11`. I checked whether this
  matters for what this reader needs (offsets, node kinds, determinism) and it does not: the position
  contract (`node.range`) has been stable across that whole range of versions, and a parse is pure —
  no I/O, no clock, no locale dependence. It would matter if this project wanted streaming/plugin
  composition from the modern `unified` ecosystem; it does not need that for a reader that just walks
  a tree once.
- **Determinism, checked, not assumed:** two `parse()` calls over the same string produced
  byte-identical `JSON.stringify` output in a direct run against this tree's installed copy. No
  further verification of this claim should be needed before relying on it, but I did not want to
  assert it from documentation.

The runner-up is a direct `unified` + `remark-parse` + `remark-gfm` install (current major versions).
It gives the same offset guarantee and a more actively maintained toolchain, at the cost of a second,
unrelated AST convention living next to the one `@textlint/kernel` already builds, and a larger,
independent set of transitive packages. I would switch the recommendation to this if `@textlint/markdown-to-ast`'s
tie to `textlint`'s own release cadence turns out to be a problem in practice — it hasn't been
checked against that risk yet, only against the offset and determinism requirements above.

**Plain text** needs no parser at all. `format: 'text'` today already only splits on blank lines
(`src/core/structure.ts`, the `options.format === 'text'` branch) — a `PlainTextReader` reproduces
exactly that with a `String.split(/\n{2,}/)`-equivalent scan and real offsets, zero new dependencies.
This is the "simplest reader that satisfies the interface" the task asked to keep working.

**Policy, general and explicit, not just true of the Markdown choice above: every `DocumentReader` is
built on an existing, mature parsing library for its format. None is ever hand-written.** This is the
entire point of issue #25 — what is being replaced here is exactly a hand-rolled stand-in for a real
parser, the regex scanner in `protected-regions.ts`/`structure.ts`. Writing a second one, for a
different format, in this codebase, would be repeating the mistake in a new place rather than fixing
it. This does not mean every future reader's library choice is settled — none of the following are
decisions, they are leads for whoever picks up issue #31 or the RST/HTML/docx readers, to verify the
same way `@textlint/markdown-to-ast` was verified above rather than assumed:

- **TypeScript/JavaScript** (docstrings and JSDoc/TSDoc comments in source): the TypeScript Compiler
  API (the `typescript` package) — a full AST, exact character positions, and it already attaches
  JSDoc to the nodes it documents.
- **HTML**: `parse5` or `htmlparser2`, both with position tracking.
- **Python** (docstrings): the real wrinkle. Python's own `ast` module is authoritative, but it is a
  Python library, and this project has zero non-npm runtime dependencies today. Using it means either
  a Python subprocess — a genuine new deployment dependency, not just a `package.json` line — or a
  JS-native alternative. `tree-sitter` with a Python grammar is a credible candidate: it avoids the
  subprocess and gives exact byte ranges by design. Unverified against this project; a lead, not a
  choice.
- **RST**: `docutils` is the reference implementation, also Python-only, the same subprocess question
  as above. Whether a JS-native RST parser exists with the same fidelity is an open question, not
  checked yet.
- **docx is a genuinely different case, not just another format to pick a parser for.** It is a ZIP
  archive of XML, not a linear text file, so "an offset into the original document" does not have an
  obvious meaning the way it does for every format above — offset into `word/document.xml`? Into a
  reconstructed paragraph view assembled from several XML parts? That question has to be answered
  before the offset contract in §4 even applies to a docx reader, not after. Worth stating plainly so
  docx does not read as "one more format on the list" when it is actually a different kind of problem
  than RST, HTML, Python or TypeScript/JavaScript are.

A source-code reader (TypeScript/JavaScript, Python) is also a different _shape_ of reader from the
ones built here, worth naming so nobody designs against the wrong assumption: a Markdown, RST, HTML or
docx reader treats the whole file as prose-shaped and walks its own tree directly, while a source-code
reader must first parse the _host_ language, then select the small subset of nodes that are
prose-bearing (a docstring literal, a JSDoc-shaped comment) rather than assume most of the tree is a
unit — filtering, not a different mechanism. Whether interpreting a docstring's own internal
convention (Google/NumPy/reST sections, JSDoc tags) into finer-grained units is worth doing is a real,
separate, addable-later refinement, not a blocker to emitting one `TextUnit` per whole docstring first.

The offset contract still has to hold for a source-code reader, and it holds the same way it holds
everywhere else in this codebase: by masking per-line noise (Python's leading indentation, JSDoc's
leading `*`) at the same length, never by stripping it. This was checked against something concrete,
not asserted from principle — while building `MarkdownReader` for this note, a real gap surfaced that
is exactly this shape: a multi-line blockquote's _continuation_ line keeps its own `>` marker
embedded verbatim inside the paragraph node's text (verified: `parse('> First line.\n> Second line.\n')`
gives one `Paragraph` node whose text is `"First line.\n> Second line."` — the first line's marker is
excluded, the second line's is not). The fix, deferred to whichever stage first builds masking for
this reader, is to mask that embedded marker at the same length, not strip it — a single coordinate
system survives exactly because nothing is ever deleted, only replaced, which is the same invariant
`maskedText.length === text.length` already asserts for the pipeline this reader is replacing.

### 3. Where the module-boundary line sits

**A new top-level module, `src/reader/`, that `core` does not import — not a change to what `core`
is allowed to import.**

The reasoning, checked against the actual enforcement rather than the prose description of it:
`test/architecture/module-boundaries.test.ts` has a dedicated assertion, `'core imports no textlint
package and performs no HTTP'` (line ~124), that greps every import specifier under `src/core` for the
literal substring `textlint` and fails if it appears — an assertion built, by name, specifically to
stop what this feature would otherwise do to `core`. `@textlint/markdown-to-ast` contains that
substring in its own package name. Landing the reader in `core` does not "graze" this rule, it is
exactly the case the rule's own name describes; changing it would mean deleting one of the three named
prohibitions the module-boundaries section of this document calls out deliberately, not adjusting an
incidental detail.

A new `reader` module sidesteps that question entirely rather than answering it by weakening the
rule:

```
reader          → core                    DocumentReader interface, TextUnit, MarkdownReader,
                                          PlainTextReader
```

- `reader` imports `core` for shared types (`SourceRange`, `TextMode`, `AdmonitionKind`, `SourceDocument`).
- `analysis` and `cli` gain `reader` in their `ALLOWED` entries; `core` does not change at all — none
  of its three existing prohibitions needs editing, and the "core depends on nothing internal"
  assertion (`module-boundaries.test.ts`, the one that currently asserts `core`'s edge list is empty)
  stays true and stays meaningful, rather than becoming a rule with a carved-out exception nobody
  reads twice.
- `textlint` (`src/textlint/`) is deliberately **not** given access to `reader` in this landing. The
  adapter still calls `analysis`'s `analyseText`/`analyseTextDeterministic` on a raw string
  (`src/textlint/adapter.ts`, `getAnalysis`), which is what lets the standalone CLI and the textlint
  path share one analysis pipeline; `reader` is used _inside_ `analysis`, not spliced into the
  adapter's own kernel-AST handling. A later change that lets the adapter hand its own already-built
  kernel AST to the reader (avoiding a second parse of the same document) is a real, worthwhile
  optimisation, but it is out of scope here and would touch the adapter's contract, which this note
  is deliberately not proposing to change yet.

This is the smaller, more reversible of the two options posed. It costs one new entry in `ALLOWED`
and zero changes to `core`'s own rules; the alternative (loosen `core`) costs rewriting a rule that
exists specifically to prevent this, with no way to partially un-rewrite it later if the choice turns
out to be wrong.

### 4. The offset contract, demonstrated

The requirement: an index into a unit's `text` must be a valid offset into the _original_ source the
author has open — the same guarantee `positionAt` (`src/core/text.ts:76`) and textlint's `locator`
rely on today (`docs/architecture.md`, "The offset contract", above). This is checked here against a
real parse, not asserted:

```js
const { parse } = require('@textlint/markdown-to-ast');
const text = [
  '# Setup',
  '',
  '| Step | Action |',
  '| --- | --- |',
  '| 1 | Utilise the tool |',
  '',
  'See [the guide](./guide.md) before you continue.',
  '',
].join('\n');
const ast = parse(text);
```

Actual output, this run, this tree:

```
Document        range=[0,116]
  Header        range=[0,7]    "# Setup"
  Table         range=[9,65]
    TableRow    range=[9,26]   "| Step | Action |"
    TableRow    range=[41,65]  "| 1 | Utilise the tool |"
      TableCell range=[46,65]  " Utilise the tool |"
        Str     range=[47,63]  "Utilise the tool"
  Paragraph     range=[67,115] "See [the guide](./guide.md) before you continue."
    Str         range=[67,71]  "See "
    Link        range=[71,94]  "[the guide](./guide.md)"
      Str       range=[72,81]  "the guide"
    Str         range=[94,115] " before you continue."
```

`text.slice(47, 63) === 'Utilise the tool'` and `text.slice(94, 115) === ' before you continue.'`,
both directly against the original `text` string — no translation table, no reparse. This is the
exact defect class issue #11 names: a table cell (`TableCell`'s `Str` child isolates the cell's prose
from its `|` markup automatically) and a link (`Str` after the `Link` node correctly resumes at offset
94, past the whole `[text](dest)` construct, with nothing of the link's own syntax leaking into it).
A `TextUnit` built from either of these nodes carries `range` values obtained by walking the AST, and
every one of them is already an offset into `text` — the guarantee holds by construction, the same way
it holds today by never rewriting, only masking.

Determinism was checked the same way: two `parse(text)` calls over the identical string, this run,
produced byte-identical `JSON.stringify` output.

### 5. `src/core/protected-regions.ts` and `src/core/structure.ts`

**Not a clean deletion of either file. Both split, and only part of each goes away.**

I checked every pass in both files against what the AST gives for free before writing this, rather
than asserting the files are simply obsolete:

**Retired.** Fenced/indented code, front matter, HTML blocks/inline, reference definitions, link/image
destinations, autolinks, tables, headings, lists, blockquotes, footnotes, emphasis markers —
`frontMatterPass`, `fencedCodePass`, `htmlCommentPass`, `htmlBlockPass`, `indentedCodePass`,
`referenceDefinitionPass`, `inlineCodePass`, `linkDestinationPass`, `autolinkPass`, `tableMarkupPass`,
`headingMarkerPass`, `blockquoteMarkerPass`, `listMarkerPass`, `footnotePass`, `htmlInlinePass`,
`emphasisMarkerPass` (`src/core/protected-regions.ts`). This is markdown structure; a real parser gives
it as node types and exact ranges, which is the entire premise of this change.

**Not retired — moved.** Credentials, quoted literals, approved terms, extra user patterns,
placeholders, shell command lines, file paths, config-key/value fragments, code-shaped identifiers,
quantities/units — `credentialPass`, `quotedLiteralPass`, `approvedTermPass`, `extraPatternPass`,
`placeholderPass`, `shellCommandPass`, `filePathPass`, `configFragmentPass`, `identifierPass`,
`numericPass`. These are plain regex over already-structurally-masked _prose text_, not markdown
syntax — confirmed by reading each: `shellCommandPass`, for example, matches
`/^[ \t]{0,3}[$#][ \t]+\S.*$/gm` against masked text, nothing about markdown. They apply identically
to a table cell's text, a list item's text, or a plain-text document's paragraph, so they belong
beside the checker, applied per `TextUnit.text`, not inside the reader.

Also in this bucket, but not interchangeable with the rest of it: `corroboratedConstantPass`
(in `src/core/protected-regions.ts`), which protects a bare all-caps token (e.g. `LLVM`, `ON`)
when it is corroborated elsewhere in the same document by a region a naming-shaped pass already
recognised. Unlike the other passes named above, it is order-dependent — it consults
`priorRegions`, the regions already produced by earlier naming-shaped passes (`configFragmentPass`,
`identifierPass`, `quotedLiteralPass`, `approvedTermPass`, and the `product-identifier`-kind passes)
within the same `extractProtectedRegions` call, so it cannot run standalone the way the rest of this
bucket can. Its placement last in both `MARKDOWN_PASSES` and `PLAIN_TEXT_PASSES` is load-bearing,
not incidental: it must run after every pass whose output it reads.

**Probably retired, not yet confirmed.** Bare URL/email in prose, outside markdown link syntax —
`urlPass`, `emailPass`. `@textlint/markdown-to-ast` carries `remark-gfm` as a dependency, which
recognises bare autolinks (GFM's autolink-literal extension) as `Link` nodes without `[]()` syntax.
Whether that extension is actually wired on for this specific parser's default configuration, versus
needing to stay as a prose pattern for plain-text documents at least, is exactly the kind of thing the
implementation stage needs to verify against a real parse before this claim is trusted — flagged here,
not asserted.

**Not addressed by this parser at all.** Math — `mathPass`. Math has no standard commonmark
representation; `mathPass` may need to stay as a prose pattern regardless of parser, unless a math
extension is added deliberately. Not verified either way yet.

The corollary: this is not "delete two files, add one dependency." It is "delete the markdown-structural
half of `protected-regions.ts` and all of `structure.ts`'s block-scanning, and move the prose-pattern
half of `protected-regions.ts` to run over `TextUnit.text` wherever the checker layer ends up living."
`docs/architecture.md`'s own claim above — "the checker layer is CLOSER to reader-agnostic than the
reader is" — already anticipated this; it undersold it slightly, because the prose-pattern passes
were never reader logic in the first place, just filed in the same source file as the passes that are.

**One concrete interaction with the suppression feature, found while checking the above, not asked
for but worth flagging now rather than at implementation time:** `src/core/suppressions.ts` currently
distinguishes an HTML _comment_ from other raw HTML via a dedicated protected-region kind, `'comment'`
(`htmlCommentPass`, `src/core/protected-regions.ts`), which `isLiveDirectiveComment` matches on
exactly. `@textlint/markdown-to-ast` does not produce a distinct comment node — I parsed
`<!-- a comment -->\n\nProse.\n` and got a single `Html` node covering the comment, with no `Html`
node distinguishing it from an HTML block that is not a comment. This is a small, containable gap —
the AST still gives the exact byte range, and `/^<!--[\s\S]*-->$/`-testing that range's raw slice
recovers "is this Html node a comment" without needing a new node kind — but it is a real seam between
this work and the suppression feature just finished, and worth a test in whichever stage first touches
`isLiveDirectiveComment`'s assumptions, not an assumption that the migration is comment-shape-neutral.

### 6. Issue #11's ground truth (`fixtures/verdicts/`)

Checked, not assumed: 4 reviewer files, 18 source documents in `fixtures/original/`, verdicts keyed by
`(ruleId, span, quote)` exactly as described — e.g.
`{"passageId":"passive-voice-candidate:s3:399","span":{"start":399,"end":409},"quote":"is deleted",...}`
in `fixtures/verdicts/reviewer-d.json`.

**If migrating a document to the new reader moves any span the corpus already covers, that is a
re-review trigger for every verdict keyed against that document — not something a span-remapping
script should paper over.** A verdict is a judgement about a specific quoted passage, recorded by the
reviewer named on the record (agent runs, per `reviewerKind`; see
[`fixtures.md`](./fixtures.md#how-the-adjudication-was-run)); if the
new reader reports the "same" finding two characters to the left because a table cell's leading
space is now excluded from its `Str` child where the old regex scanner included it, the quote the
reviewer judged may no longer be the quote the tool now reports, and silently rewriting `span` to match
would be asserting the reviewer verified something they did not look at. The concrete plan, if this is
approved: before switching a fixture document's family over, run both readers against it, diff every
`(ruleId, range)` pair the deterministic rules produce, and for every document where a span changed,
treat every verdict keyed to that document as needing re-review rather than auto-remapping it. This
should surface as a small number of documents (only ones containing the structures issue #11 named —
tables, links, directive-plus-title constructs) rather than all 18, but that is a claim to verify
against the real diff when the migration actually runs, not to state now.

### 7. Explicit v1 scope

**In scope for a first landing:**

- `DocumentReader` interface and `TextUnit` type in `src/reader/`.
- `MarkdownReader` on `@textlint/markdown-to-ast` (or the `unified`/`remark` runner-up, if §2's
  concern is resolved against it instead).
- `PlainTextReader`, dependency-free.
- `analysis` wired to select a reader by `DocumentFormat` and iterate its units.
- Migrating the markdown-structural half of `protected-regions.ts` and all of `structure.ts`'s block
  scanning off; the prose-pattern half moves, not deletes.
- The suppression-comment seam in §5, tested explicitly rather than discovered by a failing test.
- The fixture re-review process in §6, run against the real corpus, with its actual result reported —
  not "no spans moved" asserted in advance.

**Explicitly out of scope, stubbed behind the same interface:**

- RST, HTML, and docx readers. The interface is shaped so that adding one later means implementing
  `DocumentReader` and registering it by `DocumentFormat` — no change below that line — but none of
  the three is implemented, and `DocumentFormat` itself (`src/core/types.ts:176`, currently
  `'markdown' | 'text'`) is not extended for them in this landing. A reader that isn't backed by a
  real parser yet is not stubbed as a fake pass-through either — better to leave the format
  unsupported than to ship a reader that silently mis-reports positions for a format nobody has
  actually implemented.
- The adapter optimisation in §3 (reusing textlint's own kernel-built AST instead of a second parse).
- Any change to `DiagnosticCategory`, the suppression directive syntax, or the rule contract's public
  shape (`meta`, `optionsSchema`, `run`) — this is a reader change, not a rule-contract change, and
  the existing 434 tests passing unmodified is exactly what would demonstrate that boundary held.

### Gate

No implementation starts from this note alone. The reviewing party reads this against the real
source and replies "proceed" or with specific pushback, the same as any other change on this branch —
this section makes no claim to have settled that already.
