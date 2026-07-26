# Non-conformance disclaimer

**This package does not implement ASD-STE100 and does not certify, assert, or approximate
conformance with it.**

## What was available, and what was not

ASD-STE100 Simplified Technical English is published by the ASD Simplified Technical English
Maintenance Group. Its specification text and its Dictionary are proprietary. The official site
states, verbatim:

> Simplified Technical English, ASD-STE100, is a Copyright and a Trademark of ASD, Brussels,
> Belgium. All rights reserved. European Union Trade Mark No. 017966390.

— <https://asd-ste100.org/>, retrieved 2026-07-26.

No licensed copy, machine-readable rule pack, or dictionary was available to this repository at the
time of writing. Consequently:

- **No Writing Rule text is reproduced, paraphrased, summarised, or reconstructed here.**
- **No part of the controlled Dictionary is reproduced or reconstructed here.**
- Nothing in this package was derived from memory of the standard or from secondary summaries of it.

## What the shipped rules actually are

Every rule this package ships is classified `provisional`. A provisional rule is an ordinary
plain-English and controlled-language editing heuristic authored for this project — the sort of
guidance found in many public technical-writing style guides. Provisional rules are documented in
[`provisional-rules.md`](./provisional-rules.md), each with its rationale and its known failure
modes.

`provisional` status is not cosmetic. It is carried in:

- each rule's `meta.status` and `meta.sourceRef`;
- every diagnostic, as the `[provisional]` tag in the message and the `ruleStatus` field in the
  programmatic and JSON output;
- the active rule pack's `metadata.authority` and `metadata.conformanceClaim`, which the bundled
  pack sets to `provisional` and `none` respectively.

`packPermitsConformanceClaim()` returns `false` for the bundled pack, and the CLI prints
`Provisional rules only; no conformance claim.` on every run.

## What a passing run means

A clean run means: _this document did not trigger the provisional checks that were enabled._ It does
not mean the document is Simplified Technical English, and it does not mean the document is correct,
safe, or complete.

## What a semantic verdict means

When the optional semantic subsystem is enabled, a diagnostic in the
`probable-semantic-violation` category reflects a **model's** judgement, recorded with the model's
own self-reported confidence. That number is not a calibrated probability. Decision thresholds are
separate, operator-owned configuration. A semantic verdict is evidence for a human reviewer, not a
finding of non-compliance.

If the model service is unreachable, the affected passages are reported as `review-required` and a
run-level notice is emitted. **A service failure is never converted into compliance.**

## Supplying authorised material

If you hold a licence that permits it, an authorised rule pack can supply normative limits, a
controlled dictionary, and per-rule authority through the documented import boundary — see
[`rule-pack-import.md`](./rule-pack-import.md). Doing so changes the `ruleStatus` on diagnostics to
whatever the pack declares. Whether that constitutes conformance is a determination for you and your
licensor; this package makes no such determination and adds no conformance wording of its own.

## Trademarks

"ASD-STE100" and "Simplified Technical English" are trademarks of ASD, Brussels, Belgium. They are
used here only to describe what this package is _not_, and to name the standard a licensee might
supply through the import boundary. This project is not affiliated with, endorsed by, or approved by
ASD or the ASD STEMG.
