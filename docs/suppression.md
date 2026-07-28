# Inline suppression

Every rule this package ships is `provisional`. A provisional rule will sometimes be wrong about a
particular sentence, and before inline suppression existed the only remedy was to disable the rule
for the whole run — losing every other finding it would have made. An inline directive narrows that
to one line or one region, and says in the source why.

A suppression is an **authored claim**: someone looked at this finding and decided it does not
apply here. It is treated as a claim throughout — recorded, attributed to a reason, and reported —
not as a way of deleting the finding.

## Syntax

Three directive forms, written as HTML comments:

```
<!-- ste-ai-ignore-next-line [rule-id, rule-id] -- reason text -->
<!-- ste-ai-ignore-start [rule-id, rule-id] -- reason text -->
<!-- ste-ai-ignore-end -->
```

- The keyword is the first token inside the comment, and keywords are case-sensitive.
- Rule ids are separated by commas and/or whitespace and appear before the separator, which is a
  double hyphen with a space on each side. An empty list means every rule.
- The reason is everything after the first such separator, trimmed.
- `ste-ai-ignore-end` takes no rule ids and no reason.
- The same HTML-comment form is used in `markdown` and in `text` documents. In markdown a comment
  is already a protected region and produces no prose; in `text` it is ordinary prose, so the
  scanner reads the source directly rather than relying on protected regions.

### A reason is required

A directive with no reason, or with an empty reason, is **not applied**. It is inert, the finding
it named is still reported, and `suppression-reason-missing` is emitted.

This is the one piece of syntax with no convenience form. A suppression without a reason is
indistinguishable from a mistake six months later, and a linter that lets a reader see the silence
but not the argument for it has replaced one unverified claim with another.

## What a directive claims

| Form                      | Span claimed                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ste-ai-ignore-next-line` | the whole of the next eligible line after the line containing the directive, including its terminator |
| `ste-ai-ignore-start`     | from the end of the `ignore-start` comment to the start of the matching `ignore-end`                  |
| `ste-ai-ignore-end`       | nothing; it closes the open `ignore-start`                                                            |

A line is **eligible** for `ste-ai-ignore-next-line` when it contains at least one non-whitespace
character and is not itself entirely a suppression directive. Blank lines are skipped because a
blank line between an HTML comment and the paragraph beneath it is ordinary Markdown formatting,
and a directive that claimed the blank line would claim nothing. Directive-only lines are skipped
so that directives stack, each claiming the same prose line for its own rule id and its own reason:

```markdown
<!-- ste-ai-ignore-next-line unapproved-vocabulary -- "terminate" is the vendor's API verb -->
<!-- ste-ai-ignore-next-line sentence-length-procedural -- quoted verbatim from PN-4417 -->

Terminate the session before you remove the module.
```

A finding is claimed when its **start offset** falls in `[span.start, span.end)` and the
directive's rule-id list is empty or contains the finding's rule id. Where two directives both
claim a finding, the first in source order wins.

Anchoring on the start offset rather than on span overlap is what makes a multi-line finding
behave predictably. A sentence-length diagnostic covers a sentence that may run over four lines;
under an overlap rule, a `next-line` directive anywhere in those four lines would claim it, and a
reader could not tell from the directive which finding it was aimed at. Under the start-offset
rule a finding is claimed by the line it is _reported on_ — the line the CLI prints next to it.

`ste-ai-ignore-start` does not nest. A second `ignore-start` seen before an `ignore-end` closes the
first at its own start position and emits `suppression-unclosed-range`. An `ignore-start` that is
never closed runs to the end of the document and emits the same notice.

Any finding anchored inside a directive comment itself is suppressed unconditionally, with the
reason `directive text is not prose`. Without this, a `format: 'text'` document — where comments
are not masked out — would report findings on the directive line, which is not text anyone wrote
for a reader.

## Configuration

```jsonc
{
  "suppressions": {
    // Inline directives are honoured. Set false to make every directive inert.
    "enabled": true,
    // Permit a directive to withhold a finding inside a danger, warning or caution admonition.
    "allowInAdmonitions": false,
  },
}
```

With `suppressions.enabled: false` no scan runs at all: no directive is applied, no suppression is
recorded, and every finding is reported as though the directives were not in the file. This is the
setting for an audit run that needs to see what the document contains rather than what its authors
have ruled on.

## Admonitions

A claim is **refused** when the block containing the anchor offset is a `danger`, `warning` or
`caution` admonition and `allowInAdmonitions` is false, which is the default. The diagnostic is
kept and `suppression-refused-in-admonition` is emitted at `warning`. `note` is not a safety
register and never triggers the refusal.

### Why this differs from autofix

`autofix.allowInAdmonitions` is typed `z.literal(false)` (`src/core/config.ts:50`) and can never be
set to true. `suppressions.allowInAdmonitions` is an ordinary boolean, default false. The asymmetry
is deliberate.

Rewriting the source of a safety notice and withholding a report about one are different acts. The
first changes what a reader in front of the equipment is told, and no model verdict or rule
substitution in this package is trusted to do that. The second changes only what the linter says
about wording that a person has already read and ruled on; it is an operator decision, and one an
operator is entitled to take — but only explicitly, only with a reason in the source, and always
with the withheld finding still recorded.

## Suppressions are recorded, never discarded

The load-bearing rule of this project is that silence must never mean compliant
([`diagnostic-policy.md`](./diagnostic-policy.md#service-failure-is-never-compliance)). It applies
to a suppressed finding exactly as it applies to a passage a model failed to adjudicate: the
finding leaves the diagnostic list, and it does not leave the result.

Every withheld finding is visible on every surface that reports the run:

| Surface          | Where                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Programmatic API | `AnalysisResult.suppressions` — rule id, category, range, the message the finding would have carried, the reason, and the directive's own span |
| CLI `--json`     | a `suppressions` array on each file's result object                                                                                            |
| CLI human output | one `suppressed  {ruleId} at {line}:{column} — {reason}` line per record                                                                       |
| Run notices      | `suppressions-applied` at `info`, once per run, with the count                                                                                 |

Exit-code logic is unchanged by this feature. A suppressed diagnostic is simply not in the
diagnostic list, so a suppression can turn exit `1` into exit `0`. That is what a suppression is
for; the record of what was withheld is what makes it auditable rather than invisible.

### A suppressed candidate is never sent to the model

Candidates are filtered before adjudication, not after. A candidate whose start offset is claimed
for its rule id is dropped from the run before anything else happens to it, and recorded as a
suppression with category `review-required` and the candidate's own reason as its message.

Two consequences, both intended. An operator who has already ruled on a passage does not pay for a
model to adjudicate it again. And the text of that passage never leaves the process — a suppression
is therefore also the mechanism for keeping a specific passage away from a semantic service.

## Notice codes

| Code                                | Level     | Detail                   | Meaning                                                                  |
| ----------------------------------- | --------- | ------------------------ | ------------------------------------------------------------------------ |
| `suppressions-applied`              | `info`    | `{ count }`              | emitted once when at least one finding was withheld                      |
| `suppression-reason-missing`        | `warning` | `{ line }`               | directive ignored                                                        |
| `suppression-unknown-rule`          | `warning` | `{ ruleId }`             | the named id is not a known rule; it never matches                       |
| `suppression-unclosed-range`        | `warning` | `{ line }`               | `ignore-start` with no `ignore-end`                                      |
| `suppression-end-without-start`     | `warning` | `{ line }`               | stray `ignore-end`                                                       |
| `suppression-unused`                | `info`    | `{ line }`               | the directive claimed nothing — keeps dead suppressions reviewable       |
| `suppression-refused-in-admonition` | `warning` | `{ ruleId, admonition }` | the claim was refused and the diagnostic kept                            |
| `suppression-malformed`             | `warning` | `{ line }`               | the comment starts `ste-ai-ignore` but parses as none of the three forms |

`line` values are 1-based.

`suppression-unused` exists because a suppression that no longer claims anything is the same
problem as a stale comment: the sentence it was written for may have been rewritten, and nobody
finds out unless the tool says so.

## Known limitation: suppressions are not visible in a textlint report

The textlint adapter surfaces run notices only at `warning` and `error`
(`src/textlint/adapter.ts:215`), so the `info`-level `suppressions-applied` and
`suppression-unused` notices do not reach a textlint report. Suppressed diagnostics themselves
never reach the adapter at all, by design — suppressing a finding is the core's decision, expressed
by not producing the diagnostic.

The consequence is that `npx textlint` shows a clean file and gives no indication of how much was
withheld to make it clean. Audit suppressions through the CLI or the programmatic API instead:

```bash
npx ste-ai lint docs/install.md --json    # per-file `suppressions` array
npx ste-ai lint docs/install.md           # `suppressed` lines under each file
```

The `warning`-level suppression notices — a missing reason, an unknown rule id, an unclosed range,
a refused claim in an admonition — do reach a textlint report.

## Example

```markdown
<!-- ste-ai-ignore-next-line unapproved-vocabulary -- "terminate" is the vendor's API verb, PN-4417 -->

Terminate the session before you remove the module.

<!-- ste-ai-ignore-start sentence-length-descriptive -- quoted verbatim from the supplier manual -->

The controller monitors the bus continuously and, if it detects a fault condition that persists for
longer than the configured interval, isolates the affected segment and raises an alarm.

<!-- ste-ai-ignore-end -->
```

Both findings are withheld from `diagnostics`, both appear in `suppressions` with their reasons,
and `suppressions-applied` reports a count of two.
