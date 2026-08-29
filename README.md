# textlint-rule-preset-ste-ai

This is a linter for an AI (artificial intelligence) agent's own writing. It gates the documents an
agent drafts for clarity, readability, and vocabulary consistency. It checks against a
per-project-approved vocabulary. That is a checkable target. A generic style guide is not.

"Write following ASD-STE100 guidelines" is already a prompt pattern that agents respond well to. It
produces shorter, clearer text. This package turns that pattern into something enforceable and
gateable, not just a hope. It ships deterministic textlint rules. It also ships an **optional**
semantic-adjudication subsystem. That subsystem calls a small model, served locally by llama.cpp, for
the checks that genuinely need judgement.

It is meant to run inside a pre-commit hook. Husky, prek, and the Python `pre-commit` framework all
work, invoked via `npx`. It most often checks documentation an agent has just drafted. That way, the
agent's vocabulary stays consistent with the project's own, before the commit lands.

> **This package does not implement ASD-STE100 and makes no claim of conformance with it**. The
> standard and its dictionary are proprietary. Neither was available to this repository. ASD-STE100
> is referenced here as a known target agents already understand, not as a specification this
> package reproduces. Every rule shipped here is an authored plain-English heuristic, marked
> `provisional`. Read [`docs/DISCLAIMER.md`](docs/DISCLAIMER.md) before using this anywhere it
> matters.

## The idea

Deterministic rules stay deterministic. A model only adjudicates the things that genuinely depend on
syntax, context, meaning, or technical-domain interpretation. Only then is its output
schema-validated, threshold-gated, span-anchored, and traced.

```
                    ┌────────────────────────────────┐
  markdown / text → │ document reader →              │ → deterministic rules → violations
                    │ text units → sentences → words │ ↘
                    │ (offsets preserved throughout) │   candidates → broker → evaluator → verdict
                    └────────────────────────────────┘        (optional, local, off by default)
```

Markdown structure is read through a real parser, [`@textlint/markdown-to-ast`](https://www.npmjs.com/package/@textlint/markdown-to-ast),
not hand-written regex over masked text. See [`docs/architecture.md`](docs/architecture.md) for the
reasoning and [issue #25](https://github.com/Jamie-BitFlight/textlint-rule-preset-ste-ai/issues/25)
for the history.

## Install

```bash
npm install --save-dev textlint textlint-rule-preset-ste-ai
```

`pnpm add -D`, `yarn add -D` and `vp install -D` all work the same way. Nothing here needs this
repository's own toolchain.

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

No model is needed. Semantic analysis is off by default. The deterministic rules never touch the
network.

## Who this serves, and how

The intended audience is an AI agent generating text. The goal: keep that agent's vocabulary
consistent with the project's own approved, preferred, and unapproved terms. A repository can
supply its own `approvedTerms` list on top of whichever pack is active. A repository can also
replace the bundled provisional pack entirely with its own `rulePack`.

That serves four distinct consumer surfaces, at different stages of readiness. They are not the same
shape, and should not be conflated.

**1. Pre-commit hooks — works today**. Husky, prek, and the Python `pre-commit` framework can all
invoke this via `npx`. Each can lint documentation files before a commit lands. Both pieces this needs
are real today, not proposed:

- `rulePack` (a path to a JSON file, or an inline object) and `approvedTerms` are both shared-config
  options. `approvedTerms` layers on top of whichever pack is active. `rulePack` replaces the
  bundled provisional pack entirely, not just adds to it. See
  [`docs/configuration.md`](docs/configuration.md) and
  [`docs/rule-pack-import.md`](docs/rule-pack-import.md).
- The CLI's exit codes are the ones a hook needs.
  - `0` — clean
  - `1` — errors present (or review-required, with `--fail-on-review`)
  - `2` — usage error
  - `3` — any `error`-level run notice. See
    [`docs/configuration.md`](docs/configuration.md#protected-patterns-are-screened-before-they-run)
    for the full list: a protection mechanism failing, or a rule skipped for invalid options
- This repository ships a [`.pre-commit-hooks.yaml`](.pre-commit-hooks.yaml) manifest at its root.
  The Python `pre-commit` framework and `prek` can both point straight at this repository. Neither
  needs a hand-copied `repo: local` block.

Every path below needs the package installed locally first. See "Install" above. `npx` resolves the
already-installed copy. Nothing here installs it for you.

```yaml
# .pre-commit-config.yaml — prek reads the same file format
repos:
  - repo: https://github.com/Jamie-BitFlight/textlint-rule-preset-ste-ai
    rev: <latest release tag> # see the repository's Releases page
    hooks:
      - id: ste-ai
```

```sh
# .husky/pre-commit
files=$(git diff --cached --name-only --diff-filter=ACMR -- '*.md' '*.txt')
[ -z "$files" ] && exit 0
git diff --cached --name-only -z --diff-filter=ACMR -- '*.md' '*.txt' \
  | xargs -0 npx --yes textlint-rule-preset-ste-ai lint --fail-on-review --
```

See [`docs/pre-commit-hooks.md`](docs/pre-commit-hooks.md) for both, including why the manifest
uses `language: system` rather than `language: node`, and for troubleshooting.

**2. An authoring agent consulting the vocabulary in-loop — proposed, not built**. The agent would
check its own draft voluntarily, during composition, not just after the fact:

- Exporting the merged vocabulary as a machine-readable artefact would let the agent consult it
  before drafting. Tracked as [issue #2](https://github.com/Jamie-BitFlight/textlint-rule-preset-ste-ai/issues/2).
- A Model Context Protocol (MCP) server would expose `check_text`, `lookup_term`, and
  `list_vocabulary`. The agent could then check text and look up terms in-loop. It would no longer
  need to shell out to the CLI on every iteration. Tracked as
  [issue #5](https://github.com/Jamie-BitFlight/textlint-rule-preset-ste-ai/issues/5).
- A rule pack could also resolve from a package name or a URL, with a required integrity digest. That
  would let an organisation share one vocabulary across every repository, instead of copying a JSON
  file into each. Tracked as [issue #3](https://github.com/Jamie-BitFlight/textlint-rule-preset-ste-ai/issues/3).

**3. A blocking Claude Code hook gating live agent or user communication — proposed, not built, and
currently blocked**. The goal is to check outgoing messages before they are sent. That covers
assistant-to-user messages, and messages between sub-agents and an orchestrator. All of them must stay
on one agreed vocabulary.

This is a different integration shape from surface 2. A hook is invoked by the harness, not by the
agent's own choice. It conventionally receives text on stdin, and reports pass or fail through its
exit code, not through MCP.

It cannot be wired up yet. `lint` only reads files, via `readFileSync`, and exits `2` with no file
arguments. There is no stdin path. The programmatic API (`analyseTextDeterministic`/`analyseText`)
already accepts an arbitrary string, with no file dependency. This gap is in the CLI surface only, not
in the underlying analysis. Tracked as
[issue #26](https://github.com/Jamie-BitFlight/textlint-rule-preset-ste-ai/issues/26).

**4. A blocking Claude Code `PreToolUse` hook gating an agent's own file writes — built, shipped
as this repository's own plugin**. This repository is also a Claude Code plugin (see
[`PLUGIN.md`](PLUGIN.md)). Its hook blocks `Write` and `Edit` when the would-be markdown content
carries a lint finding the file did not already have. It compares findings by rule and message,
not by count alone. Replacing one finding with a different one still blocks the write, even when
the total count stays the same. The plugin also ships a way-of-working compliance agent and a
pre-push skill.

This is a different integration shape from surface 3. Surface 3 would gate outgoing chat text
before it is sent, over stdin. That gap is still open, still tracked under issue #26. This hook
instead gates a file write already headed for disk. It checks the write through the real
`textlint` binary, against a scratch copy of the would-be content. It does not touch the stdin gap
surface 3 needs.

## The rules

Run `npx ste-ai rules` for the current list and count, or `npx ste-ai rules --json | jq length` for
just the count. Both read from the live registry, so they stay correct as rules are added or removed.

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

Candidate rules never assert a violation. Each one detects a shape that cannot be decided lexically,
and hands it to a named evaluator. With semantic analysis off, each reports `review-required` instead.
Each rule's trigger, rationale, and **observed failure modes** are in
[`docs/provisional-rules.md`](docs/provisional-rules.md).

## Five diagnostic categories

| Category                      | Meaning                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `deterministic-violation`     | an exact trigger fired — no inference                                                                |
| `probable-semantic-violation` | a model said `violation` at or above your threshold                                                  |
| `review-required`             | undecidable: unadjudicated heuristic, `uncertain` verdict, or a passage the service could not decide |
| `suppressed-low-confidence`   | a `violation` below threshold, discarded                                                             |
| `infrastructure-failure`      | the tooling failed — never a statement about the document                                            |

**A model outage is never converted into compliance.** Affected passages become `review-required`, and
a run notice records how many. See [`docs/diagnostic-policy.md`](docs/diagnostic-policy.md).

## Inline suppression

`<!-- ste-ai-ignore-next-line rule-id -- reason -->` withholds one finding instead of disabling a
provisional rule everywhere. The reason is required. The withheld finding is still recorded in
`suppressions` and in `--json`. A claim inside a danger, warning, or caution admonition is refused by
default. See [`docs/suppression.md`](docs/suppression.md).

## What is protected

Protected content is masked before segmentation and matching, so it is never checked against a
vocabulary list. A content-bearing literal still counts toward sentence-length word counts, because a
reader still has to read `25 Nm`. Masking **preserves length exactly**, so every offset a rule produces
is a valid offset into your original file.

What counts as protected:

- code fences, inline code, and shell commands
- configuration fragments, file paths, and URLs or email addresses
- identifiers, API and field names, constants, and placeholders
- quoted user interface (UI) literals
- quantities, units, and version strings
- table markup, front matter, and raw HTML
- any terminology you declare in `approvedTerms`

## Autofix, and why it usually refuses

A fix needs one of two things to exist at all:

- a closed, deterministic substitution that cannot change meaning
- a model rewrite that passed an **independent** meaning-preservation gate

Several things are never autofixed:

- content in a warning, caution, danger, or note admonition
- anything that changes a digit, a negation, a modal verb, or an ordering word
- anything overlapping a protected region

When two rules propose overlapping edits, both are refused.

When a fix is withheld, the diagnostic says why: `(No automatic fix: content in a warning admonition
is never autofixed.)` See [`docs/diagnostic-policy.md`](docs/diagnostic-policy.md#autofix-policy).

## Optional semantic adjudication

A fixed set of bounded evaluators exist, each with a versioned prompt asset in `prompts/v1/`. Run
`npx ste-ai evaluators` for the current list. This list reads from the live registry, so it stays
correct as evaluators are added or removed.

One broker mediates every request. It handles:

- bounded concurrency and deterministic ordering
- content-hash caching and de-duplication
- timeouts and cancellation
- schema validation
- retry for transport faults only, and at most one bounded repair re-ask

Model confidence is recorded verbatim as `modelReportedConfidence`, and compared against
operator-owned thresholds. It is not treated as a calibrated probability.

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

Exit codes: `0` clean, `1` errors, `2` usage, `3` any `error`-level run notice. See "Who this
serves, and how" above for the full list of triggers.

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

The corpus is real licensed documentation. Each excerpt has a rewritten counterpart and an
adjudication record. `fixtures/manifest.json` is the source of truth for the excerpt count and the
source organisations:

```bash
node -e "const m = require('./fixtures/manifest.json'); \
  console.log(m.fixtures.length, 'excerpts from', new Set(m.fixtures.map(f => f.sourceOrganisation)).size, 'sources'); \
  console.log([...new Set(m.fixtures.map(f => f.sourceOrganisation))].join('\n'))"
```

Provenance is machine-checkable. A fetch script records the real HTTP status and `SHA-256` checksum of
every source. The validator cross-checks the manifest against it.

```bash
vp run fixtures:validate
```

See [`docs/fixtures.md`](docs/fixtures.md).

## Supplying authorised material

`src/rule-pack/` is the single import boundary. The active pack supplies:

- limits
- word lists
- term mappings
- contractions
- protected technical terms
- per-rule authority, severity, and default options

Supply a licensed pack, and diagnostics report its authority and citations instead of `provisional`.
The pack must also be named in `trustedRulePackIds` first. Until then its declared authority is
capped at `supplementary`.

Some rules hold trigger vocabulary in code, which no pack field can add to. A pack cannot add a
rule. A pack cannot bypass the autofix gate. A pack cannot make the linter print a conformance
claim unless it is trusted, normative, and declares one.

Want to see this work? [`examples/rule-pack/`](examples/rule-pack/) is a complete worked pack. The
full field list and the exact status rules are in
[`docs/rule-pack-import.md`](docs/rule-pack-import.md).

## Development

```bash
vp install
vp check                  # format, lint, and type checks
vp test                   # no model required
vp run fixtures:validate
vp run verify             # all of the above

vp run eval:semantic -- --split heldout --endpoint http://127.0.0.1:8080   # needs a model
```

The repository lints its own docs with its own preset. `.textlintrc.json` and `.ste-ai.json` at the
repository root carry the `additionalWellKnown` exceptions this project's own writing needs.

Most of that prose does not pass yet. `scripts/ci/check-dogfood-lint.mjs` ratchets it.
`scripts/ci/dogfood-lint-baseline.json` records what each file reports today. Rules follow from it.
A file with no entry must be clean. No file may get worse. A file's findings may shrink,
even partway, not only to zero. Record that too. Otherwise a later change could quietly reintroduce
what was fixed. So the baseline only ever shrinks. Clean a file up, even partway, run the script
with `--update`, then commit the smaller baseline.

`textlint` resolves `preset-ste-ai` as an installed package here, the same way it does for any
consumer. The package name is `textlint-rule-preset-ste-ai`. `package.json` lists this package as
its own `devDependency`, using `"file:."`. `vp install` then links it into `node_modules`.

Run `vp pack` first. The self-link needs a built `dist/` to resolve into. Then
`node_modules/.bin/textlint README.md` runs the real preset against the real docs.
`scripts/ci/check-textlint-configs-resolve.sh` runs this same check automatically, for both this
config and `examples/.textlintrc.json`. See [`examples/README.md`](examples/README.md) to try
either one yourself.

| Document                                                         | Contents                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------- |
| [`docs/DISCLAIMER.md`](docs/DISCLAIMER.md)                       | why this is not ASD-STE100                                     |
| [`docs/architecture.md`](docs/architecture.md)                   | modules, the offset contract, the rule contract                |
| [`docs/provisional-rules.md`](docs/provisional-rules.md)         | every rule, with its observed failure modes                    |
| [`docs/rule-authoring.md`](docs/rule-authoring.md)               | writing a rule                                                 |
| [`docs/prompt-authoring.md`](docs/prompt-authoring.md)           | writing or editing a prompt asset                              |
| [`docs/publishing.md`](docs/publishing.md)                       | publishing releases to npm, with trusted OpenID Connect (OIDC) |
| [`docs/semantic-evaluators.md`](docs/semantic-evaluators.md)     | evaluators, prompt contract, measurement                       |
| [`docs/diagnostic-policy.md`](docs/diagnostic-policy.md)         | categories, outage policy, autofix policy                      |
| [`docs/suppression.md`](docs/suppression.md)                     | inline directives, and what they record                        |
| [`docs/configuration.md`](docs/configuration.md)                 | every option                                                   |
| [`docs/pre-commit-hooks.md`](docs/pre-commit-hooks.md)           | wiring this into `pre-commit`, `prek`, or Husky                |
| [`docs/rule-pack-import.md`](docs/rule-pack-import.md)           | supplying licensed material                                    |
| [`docs/llama-cpp-setup.md`](docs/llama-cpp-setup.md)             | running the model service                                      |
| [`docs/fixtures.md`](docs/fixtures.md)                           | the corpus and its provenance                                  |
| [`docs/implementation-report.md`](docs/implementation-report.md) | what was built and verified                                    |
| [`docs/extension-roadmap.md`](docs/extension-roadmap.md)         | where this goes next, and what is blocked                      |
| [`PLUGIN.md`](PLUGIN.md)                                         | this repository as a Claude Code plugin                        |

## Licence

MIT. Fixture excerpts retain their upstream licences — see `fixtures/LICENSES.md`. "ASD-STE100" and
"Simplified Technical English" are trademarks of ASD, Brussels, Belgium. This project is not
affiliated with or endorsed by ASD or the ASD Simplified Technical English Maintenance Group (STEMG).
