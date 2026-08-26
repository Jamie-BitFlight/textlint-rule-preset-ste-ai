# Inline suppression

Every rule this package ships is `provisional`. A provisional rule will sometimes be wrong about a
particular sentence. Before inline suppression existed, the only remedy was to disable the rule for
the whole run. That approach lost every other finding the rule would have made. An inline directive
narrows the fix to one line or one region. It also records why, right in the source.

A suppression is an **authored claim**: someone looked at this finding and decided it does not
apply here. The tool treats it as a claim throughout. It is recorded, tied to a reason, and
reported. A suppression is not a way to delete the finding.

## Syntax

Three directive forms, written as HTML comments:

```
<!-- ste-ai-ignore-next-line [rule-id, rule-id] -- reason text -->
<!-- ste-ai-ignore-start [rule-id, rule-id] -- reason text -->
<!-- ste-ai-ignore-end -->
```

- The keyword is the first token inside the comment, and keywords are case-sensitive.
- Rule ids are separated by commas, by whitespace, or by both. They appear before the separator,
  which is a double hyphen with a space on each side. An empty list means every rule.
- The reason is everything after the first such separator, trimmed.
- `ste-ai-ignore-end` takes no rule ids and no reason.
- The same HTML-comment form works in `markdown` documents and in `text` documents. In markdown a
  comment is already a protected region, so it produces no prose. In `text` a comment is ordinary
  prose. There the scanner reads the source directly, instead of relying on protected regions.

### A reason is required

A directive with no reason, or with an empty reason, is **not applied**. It is inert, the finding
it named is still reported, and `suppression-reason-missing` is emitted.

This is the one piece of syntax with no convenience form. A suppression without a reason is
indistinguishable from a mistake six months later. A linter can let a reader see the silence but
not the argument for it. Such a linter has only replaced one unverified claim with another.

## What a directive claims

| Form                      | Span claimed                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `ste-ai-ignore-next-line` | the next block of prose                                                              |
| `ste-ai-ignore-start`     | from the end of the `ignore-start` comment to the start of the matching `ignore-end` |
| `ste-ai-ignore-end`       | nothing — it closes the open `ignore-start`                                          |

**A block, not a line.** `ste-ai-ignore-next-line` claims the first block whose end lies after the
directive. The span is clamped to begin at the directive's own end. A block is the same unit every
rule in this package works in. It is one of:

- a paragraph
- a heading
- a list item
- a table cell
- a block quote
- a caption

The keyword keeps the name every other linter uses, because that is the name a reader reaches for.
What it claims is a block, and the distinction matters in three places:

- **A soft-wrapped paragraph is one block**. See [Reformatting the prose](#reformatting-the-prose).
- **A directive right above its paragraph, with no blank line, joins that paragraph's block**.
- **Blank lines and blockquote markers need no special handling**.

The claim does not move when a soft-wrapped paragraph is rewrapped, because it stays one block. A
directive that joins its paragraph's block this way makes the block start before the directive. The
clamp is what keeps that directive claiming the rest of its own paragraph, not the prose above it.

A directive set off from its paragraph by a blank line produces no block of its own in markdown. A
directive inside a blockquote is not prose either. Stacking therefore works in both cases, with no
separate rule for either one. The example below shows two directives stacked above one paragraph.

```markdown
<!-- ste-ai-ignore-next-line unapproved-vocabulary -- "terminate" is the vendor's API verb -->
<!-- ste-ai-ignore-next-line sentence-length-procedural -- quoted verbatim from PN-4417 -->

Terminate the session before you remove the module.
```

Both directives above claim the same paragraph, each for its own rule id and its own reason.

Claiming a block is wider than claiming a line. A directive above a paragraph of five sentences
covers all five sentences, for the rule ids it names. Name the rule ids to keep the claim narrow.
Prefer one directive per paragraph over a single range that covers several paragraphs.

A finding is claimed when both of these hold:

- its **start offset** falls in `[span.start, span.end)`
- the directive's rule-id list is empty, or it contains the finding's rule id

Where two directives both claim a finding, the first in source order wins.

Anchoring on the start offset, rather than on span overlap, is what makes a multi-line finding
behave predictably. A sentence-length diagnostic covers a sentence that may run over four lines.
Under an overlap rule, a `next-line` directive anywhere in those four lines would claim it. A
reader could not then tell, from the directive alone, which finding it was aimed at. Under the
start-offset rule, a finding is claimed by the line it is _reported on_. That is the line the CLI
prints next to it.

`ste-ai-ignore-start` does not nest. A second `ignore-start` seen before an `ignore-end` closes the
first at its own start position and emits `suppression-unclosed-range`. An `ignore-start` that is
never closed runs to the end of the document and emits the same notice.

Any finding anchored inside a directive comment itself is suppressed unconditionally, with the
reason `directive text is not prose`. Without this, a `format: 'text'` document — where comments
are not masked out — would report findings on the directive line. That line is not text anyone
wrote for a reader.

### Reformatting the prose

Rewrapping a paragraph does not change what a directive claims. This linter reads wording, not
whitespace. A soft wrap is not a boundary that any part of the analysis recognises. The same
prose, wrapped or unwrapped, is treated as the same prose.

Measured over the same three sentences written as one long line and as six soft-wrapped ones:

| Property           | Unwrapped | Wrapped   |
| ------------------ | --------- | --------- |
| lines              | 1         | 6         |
| blocks             | 1         | 1         |
| sentences          | 3         | 3         |
| words per sentence | 12, 24, 8 | 12, 24, 8 |
| diagnostics        | —         | identical |
| candidates         | —         | identical |

Suppressions inherit that property from the block unit. A test asserts this directly: the same
paragraph, wrapped or unwrapped, withholds the same findings. Neither version emits a
`suppression-unused` notice.

An earlier revision of this feature claimed a physical line instead of a block. When a paragraph
was rewrapped, the offending word could move to a later line. That line was no longer covered, so
the suppression silently stopped working. That bug is fixed. It is recorded here because the
failure was instructive. The line was the only unit in this package that whitespace could move. It
had been borrowed from linters that read code, where a line is a structural unit.

Some line breaks are structural — for example a table row, a list item, or a heading. This package
continues to treat those as block boundaries.

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

With `suppressions.enabled: false`, no scan runs at all. No directive is applied. No suppression is
recorded. Every finding is reported as though there were no directives in the file. Use this
setting for an audit run. It needs to see what the document contains, not what its authors have
already ruled on.

## Admonitions

A claim is **refused** when two things are both true. The block containing the anchor offset is a
`danger`, `warning`, or `caution` admonition. And `allowInAdmonitions` is false, which is the
default. When a claim is refused, the diagnostic is kept, and `suppression-refused-in-admonition`
is emitted at `warning`. `note` is not a safety register, so it never triggers the refusal.

### Why this differs from autofix

`autofix.allowInAdmonitions` is typed `z.literal(false)` (`src/core/config.ts:62`). It can never
be set to true. `suppressions.allowInAdmonitions` is an ordinary boolean, and its default is also
false. The asymmetry between them is deliberate.

Rewriting the source of a safety notice and withholding a report about one are different acts. The
first changes what a reader in front of the equipment is told. No model verdict, and no rule
substitution in this package, is trusted to do that. The second act changes only what the linter
says about wording a person has already read and ruled on. That is an operator decision, and an
operator is entitled to make it. But the operator may only make it explicitly. A reason must be
in the source. And the withheld finding must still be recorded.

## Suppressions are recorded, never discarded

The load-bearing rule of this project is that silence must never mean compliant
([`diagnostic-policy.md`](./diagnostic-policy.md#service-failure-is-never-compliance)). That rule
applies to a suppressed finding exactly as it applies to a passage a model failed to adjudicate.
The finding leaves the diagnostic list. It does not leave the result.

Every withheld finding is visible on every surface that reports the run:

| Surface          | Where                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Programmatic API | `AnalysisResult.suppressions` — rule id<br>category<br>range<br>the message the finding would have carried<br>the reason<br>the directive's own span |
| CLI `--json`     | a `suppressions` array on each file's result object                                                                                                  |
| CLI human output | one `suppressed  {ruleId} at {line}:{column} — {reason}` line per record                                                                             |
| Run notices      | `suppressions-applied` at `info`, once per run, with the count                                                                                       |

Exit-code logic is unchanged by this feature. A suppressed diagnostic is simply not in the
diagnostic list. That is enough for a suppression to turn exit `1` into exit `0`. That is what a
suppression is for. The record of what was withheld is what makes it auditable, rather than
invisible.

### A suppressed candidate is never sent to the model

Candidates are filtered before adjudication, not after. Take a candidate whose start offset is
claimed for its rule id. It is dropped from the run before anything else happens to it. It is then
recorded as a suppression, with category `review-required` and the candidate's own reason as its
message.

Two consequences, both intended. An operator who has already ruled on a passage does not pay for a
model to adjudicate it again. And the text of that passage never leaves the process. A suppression
is therefore also the mechanism for keeping one specific passage away from a semantic service.

## Notice codes

| Code                                | Level     | Detail                   | Meaning                                                                  |
| ----------------------------------- | --------- | ------------------------ | ------------------------------------------------------------------------ |
| `suppressions-applied`              | `info`    | `{ count }`              | emitted once when at least one finding was withheld                      |
| `suppression-reason-missing`        | `warning` | `{ line }`               | directive ignored                                                        |
| `suppression-unknown-rule`          | `warning` | `{ ruleId }`             | the named id is not a known rule — it never matches                      |
| `suppression-unclosed-range`        | `warning` | `{ line }`               | `ignore-start` with no `ignore-end`                                      |
| `suppression-end-without-start`     | `warning` | `{ line }`               | stray `ignore-end`                                                       |
| `suppression-unused`                | `info`    | `{ line }`               | the directive claimed nothing — keeps dead suppressions reviewable       |
| `suppression-refused-in-admonition` | `warning` | `{ ruleId, admonition }` | the claim was refused and the diagnostic kept                            |
| `suppression-malformed`             | `warning` | `{ line }`               | the comment starts `ste-ai-ignore` but parses as none of the three forms |

`line` values are 1-based.

`suppression-unused` exists because of a stale-comment problem. A suppression that no longer
claims anything is exactly that. The sentence it was written for may have been rewritten since.
Nobody finds out, unless the tool says so.

## Known limitation: suppressions are not visible in a textlint report

The textlint adapter surfaces run notices only at `warning` and `error`
(`src/textlint/adapter.ts:336`). As a result, the `info`-level `suppressions-applied` and
`suppression-unused` notices never reach a textlint report. Suppressed diagnostics themselves
never reach the adapter at all. That omission is by design: suppressing a finding is the core's
decision, expressed by not producing the diagnostic.

The consequence is that `npx textlint` shows a clean file. It gives no indication of how much was
withheld to make it look that way. Audit suppressions instead, through the CLI or the programmatic
API:

```bash
npx ste-ai lint docs/install.md --json    # per-file `suppressions` array
npx ste-ai lint docs/install.md           # `suppressed` lines under each file
```

Some suppression notices are surfaced at `warning`, and those do reach a textlint report:

- a missing reason
- an unknown rule id
- an unclosed range
- a refused claim in an admonition

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
