# Diagnostic and autofix policy

## Five categories

A reader needs to know how much weight a finding carries before acting on it. That is why the
categories stay distinguished, rather than flattened into "error" or "warning".

| Category                      | What it means                                                                                                                         | Default severity |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `deterministic-violation`     | An exact, reproducible trigger fired. No inference.                                                                                   | `error`          |
| `probable-semantic-violation` | A model returned `violation` at or above the operator's threshold.                                                                    | `warning`        |
| `review-required`             | Undecidable by the tool: a heuristic hit that was not adjudicated, an `uncertain` verdict, or a passage the service could not decide. | `info`           |
| `suppressed-low-confidence`   | A `violation` below threshold, discarded. Not reported unless `reportSuppressed`.                                                     | `info`           |
| `infrastructure-failure`      | The tooling failed. Never a statement about the document.                                                                             | `warning`        |

Every diagnostic also carries `ruleStatus` (`provisional` for everything this package ships).
Semantic diagnostics also carry `modelReportedConfidence` **and** `decisionThreshold`. A reader can
use these to see why the tool kept or suppressed a given verdict.

In textlint output both facts appear as a message prefix: `[deterministic-violation][provisional] …`.
Full structure is available from the programmatic API and from `ste-ai lint --json`.

Severity is configurable per category:

```json
{ "diagnostics": { "severity": { "review-required": "warning" } } }
```

## Service failure is never compliance

This is the load-bearing rule of the whole design. A document that was not checked is not a document
that passed.

`diagnostics.onSemanticServiceFailure` selects the policy:

| Value              | Run notice                              | Per-candidate diagnostic                     | CLI exit |
| ------------------ | --------------------------------------- | -------------------------------------------- | -------- |
| `notice` (default) | `semantic-service-failure` at `warning` | `review-required` for each undecided passage | normal   |
| `error`            | same notice at `error`                  | `review-required`                            | `3`      |
| `silent`           | notice still recorded                   | none                                         | normal   |

Under every policy the notice states `No compliance conclusion was drawn about them` and reports how
many of how many passages were affected. `silent` exists for programmatic callers that inspect
`result.notices` themselves. It does not delete the information.

Deterministic diagnostics are unaffected by an outage. `test/integration/semantic-service.test.ts`
asserts that the deterministic finding set under a 503 is byte-identical to an offline run.

When semantic analysis is simply **disabled**, candidates become `review-required` and a
`semantic-disabled` notice records the count. Again: not compliance.

All of the above is testable, and it is tested. The outage-policy block in the integration suite
covers three policy values: `notice`, `error`, and `silent`. It also covers malformed replies and
the deterministic-set invariant.

## A suppression is an authored claim

An inline `ste-ai-ignore-*` directive does not delete a finding. The directive records that a
person read the finding and decided it does not apply. It also carries their reason — a directive
without a reason is inert and reported as `suppression-reason-missing`.

The rule above governs suppression too. A withheld finding leaves `diagnostics`, but it does not
leave the result. It appears in `AnalysisResult.suppressions`, in `ste-ai lint --json`, and in the
CLI's `suppressed` lines. It also appears in a `suppressions-applied` notice carrying the count. A
file that is clean because of six suppressions is not the same as a file that needs no suppressions
at all. The output states which kind of clean a given file is.

Inside a `danger`, `warning` or `caution` admonition, a claim is **refused** by default. The
diagnostic is kept, and `suppression-refused-in-admonition` is emitted at `warning`. Setting
`suppressions.allowInAdmonitions: true` permits it. That option exists for a reason.
`autofix.allowInAdmonitions` is typed `z.literal(false)`, so it cannot be set the same way.
Rewriting the source of a safety notice, and withholding a report about one, are different acts. The
first act changes what a reader in front of the equipment is told. The second act is an operator's
decision about the linter's own output, permitted when taken explicitly and always recorded.

Suppression is applied to candidates, as well as to diagnostics, before adjudication. A suppressed
passage is never sent to a semantic service. Full syntax and semantics are in
[`suppression.md`](./suppression.md).

## Autofix policy

A fix may exist only if one of two conditions holds:

1. **Deterministic and meaning-preserving**: a closed, enumerated substitution that cannot change
   technical meaning.
   - Example: `don't` → `do not`.
   - Example: `utilise` → `use`, where the pack marks it safe.
2. **Semantically gated**: a model-proposed rewrite that an independent check has approved.
   - The check is a separate `rewrite-equivalence` evaluation, and it must find every protected
     literal in the span unchanged.
   - This path is disabled by default (`autofix.allowSemanticFixes: false`). Enabling it means
     trusting a model verdict to authorise a source edit.

The evaluator's own `meaningPreserved` flag is **not** enough for case 2, because that flag comes
from the same call that proposed the change. A separate request checks the rewrite instead. The gate
fails closed: a transport failure, an invalid output, or an `uncertain` verdict all mean "no fix".

### Never autofixed

Regardless of rule or configuration:

- Anything inside a `danger`, `warning`, `caution` or `note` admonition.
- Anything that changes a digit.
  - a quantity, a tolerance, a range
  - a version, a part number
- Anything that changes a negation, including collapsing a double negation.
- Anything that changes a modal verb.
  - `must`, `shall`, `should`, `can`
  - `may`, `might`, `will`, `would`
  - `need`, `ought`
- Anything that changes an ordering word.
  - `before`, `after`, `first`, `then`
  - `next`, `finally`, `while`, `until`
  - `during`, `when`, `once`
- Anything overlapping a protected region.
  - Code, commands, identifiers, paths
  - URLs, placeholders, quoted literals
- Anything a rule did not declare `fixable`.

`autofix.allowInAdmonitions` is typed `z.literal(false)`. Setting it to `true` is a schema error, so
the refusal is explicit and testable rather than implicit.

### Normalisation before comparison

The negation and ordering checks compare _relations_, not spellings. Negative contractions are
normalised on both sides first: `don't` → `do not`, `won't` → `will not`, and `cannot` → `can not`.
So are register variants of ordering words: `whilst` → `while`, `prior to` → `before`,
`subsequent to` → `after`, and `amongst` → `among`.

Without this normalisation, expanding `don't` to `do not` would be refused as "changes negation".
Turning `prior to` into `before` would be refused as "changes an ordering word". Both are correct
substitutions that the pack marks safe, and this was a real defect caught by the fix-gate tests.

### Overlapping fixes

Detected across all rules in one shared analysis, before any fix reaches a caller. Two fixes that
overlap cause **both** to be refused, each diagnostic gaining
`(No automatic fix: another rule proposes an overlapping edit.)`, plus one
`overlapping-fixes-refused` run notice.

Both are dropped rather than one being preferred by precedence. Two rules disagreeing about the same
characters is precisely the situation where an automated edit is least trustworthy. The tool
declines, and it says so. An identical replacement of an identical range from two rules is a
duplicate, not a conflict, and one survives.

Resolution is deterministic: the same input always produces the same outcome.

### Suggestions versus fixes

A diagnostic may carry `suggestions` even when no fix is offered. For example, `number-unit-format`
suggests `25 Nm` for `25Nm`, but it never applies that suggestion. The autofix policy forbids
automated edits to quantities. textlint surfaces suggestions to an editor. `textlint --fix` applies
only gated fixes.
