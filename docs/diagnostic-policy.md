# Diagnostic and autofix policy

## Five categories

A reader needs to know how much weight a finding carries before acting on it, so the categories are
distinguished rather than flattened into "error/warning".

| Category                      | What it means                                                                                                                         | Default severity |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `deterministic-violation`     | An exact, reproducible trigger fired. No inference.                                                                                   | `error`          |
| `probable-semantic-violation` | A model returned `violation` at or above the operator's threshold.                                                                    | `warning`        |
| `review-required`             | Undecidable by the tool: a heuristic hit that was not adjudicated, an `uncertain` verdict, or a passage the service could not decide. | `info`           |
| `suppressed-low-confidence`   | A `violation` below threshold, discarded. Not reported unless `reportSuppressed`.                                                     | `info`           |
| `infrastructure-failure`      | The tooling failed. Never a statement about the document.                                                                             | `warning`        |

Every diagnostic also carries `ruleStatus` (`provisional` for everything this package ships), and
semantic diagnostics carry `modelReportedConfidence` **and** `decisionThreshold` so the reason a
verdict was kept or suppressed is visible.

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
`result.notices` themselves; it does not delete the information.

Deterministic diagnostics are unaffected by an outage. `test/integration/semantic-service.test.ts`
asserts that the deterministic finding set under a 503 is byte-identical to an offline run.

When semantic analysis is simply **disabled**, candidates become `review-required` and a
`semantic-disabled` notice records the count. Again: not compliance.

All of the above is testable and tested — the outage-policy block in the integration suite covers
`notice`, `error`, `silent`, malformed replies, and the deterministic-set invariant.

## A suppression is an authored claim

An inline `ste-ai-ignore-*` directive does not delete a finding. It records that a person read the
finding and decided it does not apply, and it carries their reason — a directive without a reason is
inert and reported as `suppression-reason-missing`.

The rule above governs this too. A withheld finding leaves `diagnostics` and does not leave the
result: it appears in `AnalysisResult.suppressions`, in `ste-ai lint --json`, in the CLI's
`suppressed` lines, and in a `suppressions-applied` notice carrying the count. A file that is clean
because of six suppressions is not the same file as one that is clean, and the output says which it
is.

Inside a `danger`, `warning` or `caution` admonition a claim is **refused** by default: the
diagnostic is kept and `suppression-refused-in-admonition` is emitted at `warning`. Setting
`suppressions.allowInAdmonitions: true` permits it. That option exists at all — while
`autofix.allowInAdmonitions` is typed `z.literal(false)` and cannot — because rewriting the source
of a safety notice and withholding a report about one are different acts. The first changes what a
reader in front of the equipment is told. The second is an operator's decision about the linter's
output, permitted when taken explicitly and always recorded.

Suppression is applied to candidates as well as to diagnostics, before adjudication: a suppressed
passage is never sent to a semantic service. Full syntax and semantics are in
[`suppression.md`](./suppression.md).

## Autofix policy

A fix may exist only if one of two conditions holds:

1. **Deterministic and meaning-preserving** — a closed, enumerated substitution that cannot change
   technical meaning. `don't` → `do not`. `utilise` → `use` where the pack marks it safe.
2. **Semantically gated** — a model-proposed rewrite that passed an _independent_
   `rewrite-equivalence` evaluation and left every protected literal in the span byte-identical.
   Disabled by default (`autofix.allowSemanticFixes: false`), because enabling it means trusting a
   model verdict to authorise a source edit.

The evaluator's own `meaningPreserved` flag is **not** sufficient for case 2: it comes from the same
call that proposed the change. A separate request is made, and the gate fails closed — a transport
failure, invalid output, or an `uncertain` verdict all mean "no fix".

### Never autofixed

Regardless of rule or configuration:

- anything inside a `danger`, `warning`, `caution` or `note` admonition;
- anything that changes a digit — quantities, tolerances, ranges, versions, part numbers;
- anything that changes a negation, including collapsing a double negation;
- anything that changes a modal verb (`must`, `shall`, `should`, `can`, `may`, `might`, `will`,
  `would`, `need`, `ought`);
- anything that changes an ordering word (`before`, `after`, `first`, `then`, `next`, `finally`,
  `while`, `until`, `during`, `when`, `once`);
- anything overlapping a protected region — code, commands, identifiers, paths, URLs, placeholders,
  quoted literals;
- anything a rule did not declare `fixable`.

`autofix.allowInAdmonitions` is typed `z.literal(false)`. Setting it to `true` is a schema error, so
the refusal is explicit and testable rather than implicit.

### Normalisation before comparison

The negation and ordering checks compare _relations_, not spellings. Negative contractions
(`don't` → `do not`, `won't` → `will not`, `cannot` → `can not`) and register variants of ordering
words (`whilst` → `while`, `prior to` → `before`, `subsequent to` → `after`, `amongst` → `among`) are
normalised on both sides first.

Without this, expanding `don't` to `do not` would be refused as "changes negation" and
`prior to` → `before` as "changes an ordering word" — both correct substitutions that the pack marks
safe. This was a real defect caught by the fix-gate tests.

### Overlapping fixes

Detected across all rules in one shared analysis, before any fix reaches a caller. Two fixes that
overlap cause **both** to be refused, each diagnostic gaining
`(No automatic fix: another rule proposes an overlapping edit.)`, plus one
`overlapping-fixes-refused` run notice.

Both are dropped rather than one being preferred by precedence. Two rules disagreeing about the same
characters is precisely the situation where an automated edit is least trustworthy, so the tool
declines and says so. An identical replacement of an identical range from two rules is a duplicate,
not a conflict, and one survives.

Resolution is deterministic: the same input always produces the same outcome.

### Suggestions versus fixes

A diagnostic may carry `suggestions` even when no fix is offered — `number-unit-format` suggests
`25 Nm` for `25Nm` but never applies it, because the autofix policy forbids automated edits to
quantities. textlint surfaces suggestions to an editor; `textlint --fix` applies only gated fixes.
