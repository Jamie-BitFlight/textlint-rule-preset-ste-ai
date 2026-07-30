# textlint-rule-preset-ste-ai

A linter that lets an AI agent gate the documents it writes for clarity, readability, and vocabulary
consistency — checked against a checkable, per-project-approved vocabulary, not just a generic style
guide. "Write following ASD-STE100 guidelines" is already a prompt pattern agents respond well to,
producing shorter, clearer text; this package turns that pattern into something enforceable and
gateable instead of a hope. It ships deterministic textlint rules, plus an **optional**
semantic-adjudication subsystem that calls a small model served locally by llama.cpp for the checks
that genuinely need judgement. It is meant to run inside a pre-commit hook — Husky, prek, or the
Python `pre-commit` framework, invoked via `npx` — most often checking documentation an AI agent has
just drafted, so the agent's vocabulary stays consistent with the project's before the commit lands.

> **This package does not implement ASD-STE100 and makes no claim of conformance with it.** The
> standard and its dictionary are proprietary and were not available to this repository. ASD-STE100
> is referenced here as a known target agents already understand, not as a specification this
> package reproduces. Every rule shipped here is an authored plain-English heuristic marked
> `provisional`. Read [`docs/DISCLAIMER.md`](docs/DISCLAIMER.md) before using this anywhere it
> matters.

## The idea

Deterministic rules stay deterministic. A model only adjudicates the things that genuinely depend on
syntax, context, meaning or technical-domain interpretation — and when it does, its output is
schema-validated, threshold-gated, span-anchored and traced.

```
                    ┌────────────────────────────────┐
  markdown / text → │ pluggable document reader →    │ → deterministic rules → violations
                    │ text units → sentences → words │ ↘
                    │ (offsets preserved throughout) │   candidates → broker → evaluator → verdict
                    └────────────────────────────────┘        (optional, local, off by default)
```

Document structure is read through a real parser (`@textlint/markdown-to-ast` for Markdown today) via
a pluggable `DocumentReader` interface, not hand-written regex over masked text; see
[`docs/architecture.md`](docs/architecture.md) for the reasoning and
[issue #25](https://github.com/Jamie-BitFlight/textlint-rule-preset-ste-ai/issues/25) for the history.

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

## Who this serves, and how

The intended audience is an AI agent generating text, and the goal is keeping that agent's vocabulary
consistent with the project's own approved/preferred/unapproved terms — plus any further list a
specific repository wants layered on top of the bundled provisional pack. That serves three distinct
consumer surfaces, at different stages of readiness. They are not the same shape and should not be
conflated:

**1. Pre-commit hooks — works today.** Husky, prek, or the Python `pre-commit` framework, invoked via
`npx`, linting documentation files before a commit lands. Both pieces this needs are real today, not
proposed:

- `rulePack` (a path to a JSON file, or an inline object) and `approvedTerms` in the shared config let
  a repository supply its own vocabulary on top of the bundled provisional pack — see
  [`docs/configuration.md`](docs/configuration.md) and
  [`docs/rule-pack-import.md`](docs/rule-pack-import.md).
- The CLI's exit codes are the ones a hook needs: `0` clean, `1` errors present (or review-required
  with `--fail-on-review`), `2` usage error, `3` semantic-service failure under the `error` policy.

```yaml
# .pre-commit-config.yaml — works with prek too, same config format
repos:
  - repo: local
    hooks:
      - id: ste-ai
        name: Simplified Technical English check
        entry: npx --yes ste-ai lint --fail-on-review
        language: system
        files: \.md$
```

```sh
# .husky/pre-commit
npx ste-ai lint docs/**/*.md --fail-on-review
```

**2. An authoring agent consulting the vocabulary in-loop — proposed, not built.** The agent checks
its own draft voluntarily, mid-composition, rather than being checked after the fact: exporting the
merged vocabulary as a machine-readable artefact to consult _before_ drafting
([issue #2](https://github.com/Jamie-BitFlight/textlint-ASD-ai/issues/2)), and an MCP server —
`check_text`, `lookup_term`, `list_vocabulary` — so the agent can check text and look up terms in-loop
instead of shelling out to the CLI per iteration
([issue #5](https://github.com/Jamie-BitFlight/textlint-ASD-ai/issues/5)). Resolving a rule pack from
a package name or a URL with a required integrity digest, so an organisation shares one vocabulary
across repositories instead of copying a JSON file into each, matters to this surface too
([issue #3](https://github.com/Jamie-BitFlight/textlint-ASD-ai/issues/3)).

**3. A blocking Claude Code hook gating live agent/user communication — proposed, not built, and
currently blocked.** Checking that outgoing messages — assistant to user, or between sub-agents and
an orchestrator — stay on the same agreed vocabulary, before they are sent. This is a different
integration shape from surface 2: a hook is invoked by the harness, not by the agent's own choice, and
it conventionally receives text on stdin and reports pass/fail through its exit code, not through MCP.
It cannot be wired up yet: `lint` only reads files, via `readFileSync`, and exits `2` with no file
arguments — there is no stdin path. The programmatic API
(`analyseTextDeterministic`/`analyseText`) already accepts an arbitrary string with no file
dependency, so this is a gap in the CLI surface only, not in the underlying analysis. Tracked as
[issue #26](https://github.com/Jamie-BitFlight/textlint-ASD-ai/issues/26).

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
