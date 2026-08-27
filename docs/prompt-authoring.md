# Authoring a prompt asset

This is the contract for adding or editing a file in `prompts/<version>/`. Read it before you touch
one. Every rule below exists because review caught the absence of it.

A prompt asset is not documentation. It is the input to a model whose verdict gates a suggestion in
someone's document. A prompt edit is a behaviour change, and it is reviewed as one.

## What the loader derives, and what you write

`src/semantic/prompt-loader.ts` parses each file into the sections below.

```
<<<META>>>
id: passive-voice-adjudication
version: v1
task: <one line>
<<<SYSTEM>>>
…the system message…
<<<USER>>>
…the user template with {{placeholder}} substitutions…
```

`<<<SYSTEM>>>` is sent to the model exactly as written. `buildEvaluatorRequest` never renders it.
A literal `{` or `}` character there is rejected at load time, mustache-shaped or not. Put
per-request data in `<<<USER>>>` instead. Keep the system message a general instruction, as every
other prompt's already is.

`<<<META>>>` carries only the keys in this table, no fewer and no more. `test/unit/prompt-corpus.test.ts`
asserts the exact set and rejects any mismatch.

| Key       | Who reads it                                                       |
| --------- | ------------------------------------------------------------------ |
| `id`      | `FilePromptProvider`, checked against the filename it loaded       |
| `version` | `FilePromptProvider`, checked against the directory it loaded from |
| `task`    | A human reading the file. Nothing derives from it                  |

Nothing else belongs there. These files once carried a `variables:` line. It listed the placeholders
in the template. `parsePromptFile` already derives that list on every load.

No code read the line. So it drifted. One file separated the names with spaces, not commas. Another
file left a placeholder out. A hand-written copy of a derived value is not a convenience. It is a
second answer to a question that already has one.

## The declarations that must agree

A payload key is named in each of the places below, and all of them must say the same thing:

1. The evaluator's candidate-producing code path builds it into the candidate payload (see "Adding
   an evaluator" below).
2. `evaluatorDefinitions` in `src/semantic/evaluators.ts` declares it in `payloadKeys`.
3. The `<<<USER>>>` template consumes it as `{{key}}`.

`buildEvaluatorRequest` walks the template's placeholders. It does not walk the declaration. So a
key in `payloadKeys` that the template never places is dropped. No error is raised. Nothing records
the loss.

`pronoun-antecedent-ambiguity` had this defect. The rule computed the pronoun's offset. The
evaluator declared it. The template never used it. The model was asked which noun an "It" referred
to. It was never told which "It". Each sibling evaluator that judges one token supplies that offset.
Each one tells the model to judge only that occurrence.

`prompt-corpus.test.ts` now asserts `payloadKeys` equals the placeholders the template consumes, in
both directions, so the two cannot drift again.

## Arrays render on their own line

`formatValue` renders an array as one `- item` line per entry:

```
- to shut
- to seal
```

So a placeholder that can receive an array must sit on its own line. Put it directly under a label
that ends in a colon. Leave no blank line between them:

```
Permitted senses supplied by the active rule pack:
{{permittedSenses}}
```

Substituting an array into the middle of a line strands every entry after the first:

```
Permitted senses supplied by the active rule pack: - to shut
- to seal
Approved alternatives supplied by the active rule pack: - near
```

Read that as the model reads it. `- to seal` begins a line. It carries no label. It sits directly
above a different field. A model can read the first entry as the whole permitted list. It then
reports a violation for a word the rule pack permits.

Wrapping the fields in an outer list makes this worse, not better. The stranded entry then matches
the shape of its neighbours exactly:

```
- Word: close
- Permitted senses supplied by the active rule pack: - to shut
- to seal
- Approved alternatives supplied by the active rule pack: - near
```

`prompt-corpus.test.ts` renders every evaluator with multi-entry arrays. It rejects both shapes. A
single-entry array hides the defect. That is why the shared fixtures carry a multi-entry variant.

## What every prompt must say

`test/unit/prompts.test.ts` asserts each of these against the `<<<SYSTEM>>>` message. See
[`semantic-evaluators.md`](semantic-evaluators.md) for the reasoning behind them:

- One bounded classification task.
- `uncertain` is permitted, and the conditions for it are stated.
- An evidence span is required, as `evidenceStart` and `evidenceEnd`.
- Literals, negation and ordering must not change.
- Quantities, identifiers and modal force must not change.
- The model must not rewrite the document.
- JSON only. No prose, no code fence.
- No chain of thought. A decision and one sentence of evidence.
- Compliant, violating **and hard-negative** examples.

## Adding an evaluator

A prompt file on its own will not work. `prompt-corpus.test.ts` requires the corpus and
`evaluatorDefinitions` to match in both directions. A new evaluator needs all of these:

- its id added to `SemanticEvaluatorId`
- a definition in `evaluators.ts`
- a prompt file in each version directory
- a fixture in `test/helpers/evaluator-payloads.ts`, in both the single and the multi-entry map
- a code path that produces its `CandidatePassage`

That last one is usually a deterministic rule in `src/deterministic/rules/`.
`test/integration/candidate-payload-contract.test.ts` verifies it. That test discovers every
`evaluatorId` those rules assign.

`rewrite-equivalence` differs. Its candidate is built elsewhere, in `verifyRewriteEquivalence`
(`src/semantic/analyse.ts`), as part of the autofix gate.
`test/integration/semantic-service.test.ts`'s `'semantic autofix gate'` tests verify it instead.

A non-deterministic producer still needs real, end-to-end coverage. It just will not come from the
contract test above.

`semantic-evaluators.md` covers the design question. It asks whether the task is narrow enough.

## Before you push

```bash
vp check                                          # format, lint, types
vp test --run test/unit/prompt-corpus.test.ts test/unit/prompts.test.ts
vp pack                                           # builds dist/, which the next two steps need
node scripts/ci/check-dogfood-lint.mjs            # the prompt files are linted by this preset too
```

The last one is slow. It lints every markdown file the repository authors. To see what one prompt
file reports, run the preset against it directly:

```bash
node dist/cli/main.js lint prompts/v1/approved-word-sense.md --deterministic-only
```

Prompt files are prose. They carry lint debt like any other file here.
`scripts/ci/dogfood-lint-baseline.json` records it. If you clean one up, run
`node scripts/ci/check-dogfood-lint.mjs --update`. Then commit the smaller baseline. The check fails
on a stale entry. So progress must be recorded, not left implicit.

## Changing a prompt is a cache invalidation

The prompt version is recorded in every trace. It is also folded into the content hash. An edit in
place invalidates cached verdicts instead of serving stale ones. That is the intended behaviour. It
also means that a whitespace-only edit re-runs adjudication for every affected candidate. Edits to
`v1` are for defects. A change to what the model is asked belongs in a new version directory.
