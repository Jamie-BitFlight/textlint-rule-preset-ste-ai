# Semantic evaluators

## Why narrow tasks

This package has no "check this text against the whole scheme" request, and adding one would be a
mistake. A broad request cannot be measured, because there is no ground truth for whether text is
compliant. It cannot be calibrated, because one confidence number cannot stand in for a dozen
different judgements. And it cannot be traced back to a single rule.

Instead there are eight bounded classification tasks. Each has:

- One question with a `compliant`, `violation`, or `uncertain` answer.
- Its own versioned prompt asset in `prompts/<version>/<id>.md`.
- A declared payload that lists **only** the keys that are transmitted. This means a rule cannot
  widen the context a model sees by stuffing extra fields into a candidate.
- A required evidence span, so a verdict can be anchored back to source.

## The eight

| Evaluator                      | Question                                                                         | Produced by                                          |
| ------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `approved-word-sense`          | Is this word used in a sense the active pack permits?                            | `unapproved-vocabulary` with `adjudicateSense: true` |
| `permitted-part-of-speech`     | Is this word used in a permitted part of speech?                                 | pack-driven                                          |
| `one-instruction-per-sentence` | Does this sentence tell the reader to do more than one thing?                    | `one-instruction-per-sentence` (comma-joined shape)  |
| `passive-voice-adjudication`   | Is this a true passive verb, or an adjectival state?                             | `passive-voice-candidate`                            |
| `pronoun-antecedent-ambiguity` | Does this pronoun have more than one plausible antecedent?                       | `ambiguous-pronoun-candidate`                        |
| `noun-cluster-comprehension`   | Is this noun run hard to read, or one established name?                          | `noun-cluster-candidate`                             |
| `technical-term-legitimacy`    | Is this unlisted word part of domain terminology, or is it avoidable vocabulary? | pack-driven                                          |
| `rewrite-equivalence`          | Does a proposed rewrite preserve technical meaning?                              | the autofix gate and the fixture tooling             |

Permitted senses and parts of speech are supplied **at request time**, from the active rule pack.
The prompt instructs the model to judge against that list, not against any dictionary it may have
memorised. This is what keeps a licensed dictionary inside the import boundary instead of relying on
model recall.

## Prompt contract

Every prompt asset is checked by `test/unit/prompts.test.ts` to:

- State one bounded classification task.
- Permit `uncertain`.
- Require an evidence span, given as `evidenceStart` and `evidenceEnd`.
- Forbid changing literals, negation, ordering and quantities, as well as identifiers and modal
  force.
- Forbid rewriting the document.
- Require JSON only, with no prose and no code fence.
- **Not** ask the model to reveal its reasoning — a concise decision plus evidence, never a chain
  of thought.
- Carry compliant, violating **and hard-negative** examples.

Hard negatives are the part that matters. Every prompt includes cases that look like violations,
but are not:

- `Do not remove the cover and do not touch the busbar` is two prohibitions, not two instructions.
- `Transport Layer Security certificate chain` is a standard name, not a noun pile.
- `The connector is keyed so that it cannot be fitted the wrong way` is an adjectival property, not
  a passive verb.

## File format

```
<<<META>>>
id: passive-voice-adjudication
version: v1
task: <one line>
variables: ruleId, passage, invariants, construction, …
<<<SYSTEM>>>
…the system message…
<<<USER>>>
…the user template with {{placeholder}} substitutions…
```

Rendering throws when a placeholder has no value **and** when a value has no placeholder. Both are
prompt-construction bugs that would otherwise reach a model silently. A golden test pins the exact
rendered user message for one evaluator. This makes a prompt edit that changes request content
visible in review.

Prompts are versioned by directory. `semantic.promptVersion` selects the version. The version is
recorded in every trace and in the content hash. Changing a prompt therefore invalidates the cache
instead of serving a stale verdict.

## Response contract

```json
{
  "ruleId": "string",
  "status": "compliant | violation | uncertain",
  "confidence": 0.0,
  "evidenceStart": 0,
  "evidenceEnd": 0,
  "explanation": "string",
  "suggestedReplacements": ["string"],
  "meaningPreserved": true
}
```

`validateSemanticResponse()` is the only way this becomes a verdict. It rejects:

| Rejection                                                                      | Kind                     |
| ------------------------------------------------------------------------------ | ------------------------ |
| no JSON object<br>truncated JSON<br>extra key<br>missing key<br>wrong type     | `invalid-response`       |
| confidence outside `[0,1]`, non-integer or negative offsets, empty explanation | `invalid-response`       |
| `ruleId` not the requested rule, more than three replacements                  | `invalid-response`       |
| `evidenceEnd < evidenceStart`, or beyond the passage length                    | `out-of-range`           |
| `compliant` **and** replacements suggested                                     | `contradictory-response` |
| `compliant` **and** `meaningPreserved: false`                                  | `contradictory-response` |
| replacement suggested **while** `meaningPreserved: false`                      | `contradictory-response` |
| `uncertain` **at** confidence above `0.9`                                      | `contradictory-response` |

JSON is extracted from a fenced block, or from surrounding prose, before validation. Small local
models often wrap their answer this way. But the schema still does all the deciding.

## Confidence is not probability

`confidence` is preserved verbatim as `modelReportedConfidence`. It is the number the model emitted:
not calibrated, not a probability, not comparable across models. Decision thresholds are separate,
operator-owned configuration: `defaultConfidenceThreshold` and `confidenceThresholds[evaluatorId]`.
Both numbers are carried on the diagnostic, so a reader can see why a verdict was kept or suppressed.

## Broker guarantees

| Guarantee              | How                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| bounded concurrency    | worker pool sized to `min(maxConcurrency, queue length)`                                                                              |
| deterministic ordering | candidates sorted by id for work, and outcomes returned in the caller's order                                                         |
| safe batching          | identical content hashes share one request, and nothing else is merged                                                                |
| content-hash caching   | hash covers evaluator<br>prompt version<br>model<br>temperature<br>rendered messages                                                  |
| timeouts               | `AbortSignal.timeout` combined with the caller's signal via `AbortSignal.any`                                                         |
| cancellation           | reported as `cancelled`, distinct from `timeout`, and never retried                                                                   |
| retry policy           | transport faults only: network, timeout, or 408/429/5xx. Never 4xx, never invalid output                                              |
| bounded repair         | `maxRepairAttempts` caps the repair loop at no more than one round. The repair message restates the contract and adds no task content |
| redaction              | passages are built from masked text. Only declared payload keys are sent                                                              |
| tracing                | prompt version<br>model id<br>content hash<br>attempts<br>cache hit<br>duration<br>repaired flag                                      |
| dependency injection   | `transport`, `cache`, `promptProvider`, `now` and `trace` are all injectable                                                          |
| graceful uncertainty   | `uncertain` becomes `review-required`, never a violation                                                                              |

## Measurement

```bash
vp run eval:semantic -- --split heldout --endpoint http://127.0.0.1:8080 --model my-model
```

Reported per evaluator and overall:

- True positives, false positives, true negatives, and false negatives.
- Precision, recall, and F1.
- Uncertain rate and failure rate.
- Latency at p50, p90, and p99, excluding cache hits.

**Ground truth** comes from the fixture adjudication records, not from the linter's own output:

- A candidate whose span is covered by an **accepted** change for the same rule is a gold
  violation. A reviewer decided the passage really was defective.
- A candidate covered by a **disputed** change is a gold non-violation. A reviewer decided the
  deterministic pass was wrong.
- Anything else is **unlabelled**, excluded from the confusion matrix, and reported separately.

Excluding unlabelled candidates matters. Counting them would invent ground truth for passages
nobody adjudicated. It would also make precision look better or worse, depending on which way the
model guessed.

**Split discipline.** `dev` fixtures are for tuning prompts and thresholds. `heldout` fixtures are for
reporting and must not be tuned against. The manifest records the split per fixture. The validator
asserts that the splits are disjoint by content hash, and that `heldout` is at least 25% of the
corpus. The evaluation script defaults to `heldout` and requires `--split all` to mix.

## Adding an evaluator

1. Add the id to `SemanticEvaluatorId` in `src/core/types.ts`.
2. Add an `EvaluatorDefinition` to `src/semantic/evaluators.ts` declaring `payloadKeys` and
   `requiredKeys`.
3. Keep the payload minimal — this is the redaction mechanism.
4. Write `prompts/v1/<id>.md`.
5. `test/unit/prompts.test.ts` will hold you to the contract above, including hard-negative
   examples.
6. Emit candidates for it from a rule, with `invariants` naming what must not change.
7. Add fixture annotations that label the new candidates, or the evaluator will be unmeasurable.
