# textlint-rule-preset-ste-ai

An auditable Simplified Technical English linter for technical documentation: deterministic textlint
rules, plus an **optional** semantic-adjudication subsystem that calls a small model served locally by
llama.cpp.

> **This package does not implement ASD-STE100 and makes no claim of conformance with it.** The
> standard and its dictionary are proprietary and were not available to this repository. Every rule
> shipped here is an authored plain-English heuristic marked `provisional`. Read
> [`docs/DISCLAIMER.md`](docs/DISCLAIMER.md) before using this anywhere it matters.

## The idea

Deterministic rules stay deterministic. A model only adjudicates the things that genuinely depend on
syntax, context, meaning or technical-domain interpretation — and when it does, its output is
schema-validated, threshold-gated, span-anchored and traced.

```
                    ┌────────────────────────────────┐
  markdown / text → │ protected regions → blocks →   │ → deterministic rules → violations
                    │ sentences → words (offsets     │ ↘
                    │ preserved throughout)          │   candidates → broker → evaluator → verdict
                    └────────────────────────────────┘        (optional, local, off by default)
```

## Install

```bash
npm install --save-dev textlint textlint-rule-preset-ste-ai
```

`.textlintrc.json`:

```json
{
  "plugins": { "@textlint/markdown": true, "@textlint/text": true },
  "rules": { "preset-ste-ai": true }
}
```

```bash
npx textlint docs/**/*.md
npx textlint --fix docs/**/*.md     # applies only gated fixes
```

No model is needed. Semantic analysis is off by default and the deterministic rules never touch the
network.

## The 14 rules

| Rule                           | Decides?           | Fix                                  |
| ------------------------------ | ------------------ | ------------------------------------ |
| `sentence-length-procedural`   | yes                | –                                    |
| `sentence-length-descriptive`  | yes                | –                                    |
| `unapproved-vocabulary`        | yes                | when the pack marks it safe          |
| `preferred-terminology`        | yes                | when the pack marks it safe          |
| `no-contractions`              | yes                | unambiguous expansions only          |
| `punctuation-constraints`      | yes                | –                                    |
| `no-repeated-words`            | yes                | unless it would change negation      |
| `abbreviation-introduction`    | yes                | –                                    |
| `number-unit-format`           | yes                | never — quantities are not autofixed |
| `list-instruction-structure`   | yes                | –                                    |
| `one-instruction-per-sentence` | obvious shape only | –                                    |
| `passive-voice-candidate`      | **no** — candidate | –                                    |
| `noun-cluster-candidate`       | **no** — candidate | –                                    |
| `ambiguous-pronoun-candidate`  | **no** — candidate | –                                    |

Candidate rules never assert a violation. They detect a shape that cannot be decided lexically and
hand it to a named evaluator; with semantic analysis off they report `review-required`. Each rule's
trigger, rationale and **observed failure modes** are in
[`docs/provisional-rules.md`](docs/provisional-rules.md).

## Five diagnostic categories

| Category                      | Meaning                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `deterministic-violation`     | an exact trigger fired; no inference                                                                 |
| `probable-semantic-violation` | a model said `violation` at or above your threshold                                                  |
| `review-required`             | undecidable: unadjudicated heuristic, `uncertain` verdict, or a passage the service could not decide |
| `suppressed-low-confidence`   | a `violation` below threshold, discarded                                                             |
| `infrastructure-failure`      | the tooling failed — never a statement about the document                                            |

**A model outage is never converted into compliance.** Affected passages become `review-required` and
a run notice records how many. See [`docs/diagnostic-policy.md`](docs/diagnostic-policy.md).

## Inline suppression

`<!-- ste-ai-ignore-next-line rule-id -- reason -->` withholds one finding instead of disabling a
provisional rule everywhere; the reason is required, the withheld finding is still recorded in
`suppressions` and in `--json`, and a claim inside a danger, warning or caution admonition is
refused by default. See [`docs/suppression.md`](docs/suppression.md).

## What is protected

Code fences, inline code, shell commands, configuration fragments, URLs, email addresses, file paths,
identifiers, API and field names, constants, placeholders, quoted UI literals, quantities and units,
version strings, table markup, front matter, HTML, and any terminology you declare in `approvedTerms`.

Protected content is masked before segmentation and matching, and masking **preserves length exactly** —
so every offset a rule produces is a valid offset into your original file. Content-bearing literals
still count as one word toward sentence-length limits (a reader has to read `25 Nm`) but are never
matched against a vocabulary list.

## Autofix, and why it usually refuses

A fix must be either a closed deterministic substitution that cannot change meaning, or a model
rewrite that passed an **independent** meaning-preservation gate. Never autofixed: anything in a
warning, caution, danger or note; anything that changes a digit, a negation, a modal verb or an
ordering word; anything overlapping a protected region. Two rules proposing overlapping edits causes
both to be refused.

When a fix is withheld the diagnostic says why: `(No automatic fix: content in a warning admonition is
never autofixed.)` See [`docs/diagnostic-policy.md`](docs/diagnostic-policy.md#autofix-policy).

## Optional semantic adjudication

Eight bounded evaluators, each with a versioned prompt asset in `prompts/v1/`:
`approved-word-sense`, `permitted-part-of-speech`, `one-instruction-per-sentence`,
`passive-voice-adjudication`, `pronoun-antecedent-ambiguity`, `noun-cluster-comprehension`,
`technical-term-legitimacy`, `rewrite-equivalence`.

One broker mediates every request: bounded concurrency, deterministic ordering, content-hash caching
and de-duplication, timeouts, cancellation, schema validation, retry for transport faults only, and at
most one bounded repair re-ask. Model confidence is recorded verbatim as `modelReportedConfidence` and
compared against operator-owned thresholds — it is not treated as a calibrated probability.

```json
{ "semantic": { "enabled": true, "endpoint": "http://127.0.0.1:8080", "model": "my-model" } }
```

See [`docs/llama-cpp-setup.md`](docs/llama-cpp-setup.md) and
[`docs/semantic-evaluators.md`](docs/semantic-evaluators.md).

## CLI

```bash
npx ste-ai lint docs/install.md --json          # full diagnostic structure
npx ste-ai lint docs/**/*.md --deterministic-only --fail-on-review
npx ste-ai lint docs/install.md --semantic --trace
npx ste-ai rules --json
npx ste-ai evaluators
```

Exit codes: `0` clean, `1` errors, `2` usage, `3` semantic-service failure under the `error` policy.

## Programmatic API

```ts
import { analyseText, analyseTextDeterministic } from 'textlint-rule-preset-ste-ai/analysis';

const offline = analyseTextDeterministic(source, { path: 'docs/install.md' });

const full = await analyseText(source, {
  config: { semantic: { enabled: true } },
  transport: myTransport, // injectable; tests never need a real server
  signal: controller.signal,
});
console.log(full.notices, full.traces, full.pack.metadata.conformanceClaim);
```

## Fixture corpus

18 excerpts of real licensed documentation — SQLite, PostgreSQL, Apache httpd, Zephyr, LLVM,
Kubernetes, Django, curl, Node.js, OSHA — each with a rewritten counterpart and an adjudication
record. Provenance is machine-checkable: a fetch script records the real HTTP status and SHA-256 of
every source, and the validator cross-checks the manifest against it.

```bash
npm run fixtures:validate
```

See [`docs/fixtures.md`](docs/fixtures.md).

## Supplying authorised material

`src/rule-pack/` is the single import boundary. No rule hard-codes vocabulary: limits, word lists,
term mappings, contractions and per-rule authority all come from the active pack. Supply a licensed
pack and diagnostics report its authority and citations instead of `provisional`.

A pack cannot add a rule, cannot bypass the autofix gate, and cannot make the linter print a
conformance claim. See [`docs/rule-pack-import.md`](docs/rule-pack-import.md).

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test                  # no model required
npm run fixtures:validate
npm run verify            # all of the above

npm run eval:semantic -- --split heldout --endpoint http://127.0.0.1:8080   # needs a model
```

| Document                                                         | Contents                                        |
| ---------------------------------------------------------------- | ----------------------------------------------- |
| [`docs/DISCLAIMER.md`](docs/DISCLAIMER.md)                       | why this is not ASD-STE100                      |
| [`docs/architecture.md`](docs/architecture.md)                   | modules, the offset contract, the rule contract |
| [`docs/provisional-rules.md`](docs/provisional-rules.md)         | every rule, with its observed failure modes     |
| [`docs/rule-authoring.md`](docs/rule-authoring.md)               | writing a rule                                  |
| [`docs/semantic-evaluators.md`](docs/semantic-evaluators.md)     | evaluators, prompt contract, measurement        |
| [`docs/diagnostic-policy.md`](docs/diagnostic-policy.md)         | categories, outage policy, autofix policy       |
| [`docs/suppression.md`](docs/suppression.md)                     | inline directives, and what they record         |
| [`docs/configuration.md`](docs/configuration.md)                 | every option                                    |
| [`docs/rule-pack-import.md`](docs/rule-pack-import.md)           | supplying licensed material                     |
| [`docs/llama-cpp-setup.md`](docs/llama-cpp-setup.md)             | running the model service                       |
| [`docs/fixtures.md`](docs/fixtures.md)                           | the corpus and its provenance                   |
| [`docs/implementation-report.md`](docs/implementation-report.md) | what was built and verified                     |
| [`docs/extension-roadmap.md`](docs/extension-roadmap.md)         | where this goes next, and what is blocked       |

## Licence

MIT. Fixture excerpts retain their upstream licences — see `fixtures/LICENSES.md`.
"ASD-STE100" and "Simplified Technical English" are trademarks of ASD, Brussels, Belgium; this project
is not affiliated with or endorsed by ASD or the ASD STEMG.
