# Importing an authorised rule pack

This page describes the only supported route by which normative controlled-language data enters the
package. The active pack supplies the controlled-language dictionary and the numeric limits.
Supplying licensed data therefore changes that behaviour without changing a line of rule code.

Do you want to see a pack work before you write one? [`examples/rule-pack/`](../examples/rule-pack/)
is a complete worked pack with commands that show the same document linted twice. It is linted once
under the bundled pack, then once under the custom pack.

Every behaviour this page describes is pinned by
[`test/integration/rule-pack.test.ts`](../test/integration/rule-pack.test.ts). Read that file when
you need the exact answer rather than the summary.

## What a pack controls

A pack changes only what the schema exposes. Do not edit the table below by hand.
`scripts/lib/pack-control-surface.ts` renders it from `rulePackSchema`. Regenerate it with
`npx tsx scripts/write-pack-control-surface.ts`.
`test/architecture/doc-pack-control-surface.test.ts` compares the two and fails when they differ.

<!-- pack-control-surface:begin -->

| Field                    | What it controls                                                      |
| ------------------------ | --------------------------------------------------------------------- |
| `approvedTechnicalTerms` | Literal names protected from matching, rewriting, and the heuristics. |
| `contractions`           | The contraction expansions `no-contractions` offers.                  |
| `dictionary`             | The controlled-language word lists.                                   |
| `dictionary.approved`    | Terms whose permitted sense the semantic evaluators may check.        |
| `dictionary.preferred`   | Term mappings `preferred-terminology` reports.                        |
| `dictionary.unapproved`  | Terms `unapproved-vocabulary` reports, with their alternatives.       |
| `limits`                 | The numeric thresholds. Grade levels, cluster length, step count.     |
| `metadata`               | Identity, declared authority, licence, and the conformance claim.     |
| `rules`                  | Per-rule authority and defaults.                                      |
| `rules[].enabled`        | Whether the rule runs at all.                                         |
| `rules[].options`        | Default options, below anything the user configures.                  |
| `rules[].ruleId`         | Which registered rule the entry applies to.                           |
| `rules[].severity`       | Default severity, below anything the user configures.                 |
| `rules[].sourceRef`      | The citation a deterministic diagnostic reports.                      |
| `rules[].status`         | The authority a deterministic diagnostic reports.                     |

<!-- pack-control-surface:end -->

Some rules also hold trigger vocabulary in code. The `PARTICIPLES`, `PRONOUNS`, and
`BARE_DEMONSTRATIVE_FOLLOWERS` lists in
[`src/deterministic/rules/candidate-rules.ts`](../src/deterministic/rules/candidate-rules.ts) are
examples. A pack cannot add a word to those lists. A pack can still stop one from firing, because
`approvedTechnicalTerms` protects a token before any rule scans it. The limitation runs one way
only.

## Before you start

Supplying a pack is a licensing decision. This project makes no determination about what you may
include. It adds no conformance wording of its own. See [`DISCLAIMER.md`](./DISCLAIMER.md).

Do not commit a proprietary pack to a public repository. Keep it outside the tree. Point the
configuration at it. Alternatively, store it in a private artefact repository.

## The schema

`src/rule-pack/schema.ts` is authoritative. Validate before use:

```bash
node -e "
const { loadRulePackFromFile } = await import('./dist/rule-pack/loader.js');
const pack = loadRulePackFromFile(process.argv[1]);
console.log(pack.metadata.id, pack.metadata.authority, pack.metadata.conformanceClaim);
console.log('unapproved:', pack.dictionary.unapproved.length, 'preferred:', pack.dictionary.preferred.length);
" ./my-pack.json
```

A pack that fails validation throws `RulePackError` with the failing field paths. The linter never
falls back to the provisional pack silently.

## Structure

```jsonc
{
  "metadata": {
    "id": "acme-ste-2026",
    "name": "Acme controlled-English pack",
    "version": "3.1.0",

    // 'normative' asserts that this pack carries the rule data of a standard AND that you are
    // licensed to supply it. The linter never sets this itself. It becomes the `ruleStatus` on
    // every diagnostic and replaces the `[provisional]` tag in messages.
    "authority": "normative",

    "licence": "Proprietary — Acme internal use only, licence AC-2026-004",
    "source": "ASD-STE100 Issue 8, supplied under licence AC-2026-004",
    "retrievedAt": "2026-03-01",

    // 'none' | 'partial' | 'declared-by-supplier'.
    // `packPermitsConformanceClaim()` returns true only for 'normative' + not 'none'.
    "conformanceClaim": "declared-by-supplier",

    "notice": "Reproduced under licence AC-2026-004. Do not redistribute.",
  },

  "limits": {
    // Flesch-Kincaid US grade level, applied to sentences at or above the word-count floor.
    "proceduralMaxGradeLevel": 7,
    "descriptiveMaxGradeLevel": 8,
    // Sentences shorter than this are never scored: readability formulas are unstable on very
    // short input. See docs/provisional-rules.md#sentence-length-procedural.
    "sentenceReadabilityFloorWords": 20,
    "maxNounClusterLength": 3,
    "maxSentencesPerProceduralStep": 1,
  },

  "dictionary": {
    // Approved terms with permitted senses / parts of speech. Consumed by the
    // `approved-word-sense` and `permitted-part-of-speech` evaluators, which are told to judge
    // against this list and no other dictionary.
    "approved": [{ "term": "close", "partsOfSpeech": ["verb"], "senses": ["to shut"] }],

    "unapproved": [
      {
        "term": "utilise",
        "alternatives": ["use"],
        // TRUE ONLY IF substituting alternatives[0] cannot change technical meaning in ANY context
        // this pack covers. Packs must default this to false; the linter never infers it, and the
        // central autofix gate still has to pass.
        "safeSubstitution": true,
        "partOfSpeech": "verb",
        "note": "optional",
      },
    ],

    "preferred": [{ "from": "web site", "to": "website", "safeSubstitution": true }],
  },

  "contractions": [
    { "from": "don't", "to": "do not", "safeSubstitution": true },
    { "from": "it's", "to": "it is", "safeSubstitution": false, "note": "Ambiguous." },
  ],

  // Treated as literal names: protected from vocabulary matching, rewriting, and the
  // noun-cluster and abbreviation heuristics.
  "approvedTechnicalTerms": ["Acme WidgetPro", "PRAGMA", "VACUUM"],

  // Per-rule authority and defaults. `status` and `sourceRef` are what a diagnostic reports.
  "rules": [
    {
      "ruleId": "sentence-length-procedural",
      "status": "normative",
      "sourceRef": "ASD-STE100 Issue 8, Writing Rule 3.1 (licence AC-2026-004)",
      "enabled": true,
      "severity": "error",
      "options": { "maxGradeLevel": 7 },
    },
  ],
}
```

## Wiring it in

```json
{ "rulePack": "/etc/acme/ste-rule-pack.json" }
```

in `.ste-ai.json`, or inline for a programmatic caller:

```ts
await analyseText(source, { config: { rulePack: myPackObject } });
```

Relative paths resolve against the textlint config base directory, or against `baseDir` for the
programmatic API.

## The trust gate

A pack cannot elevate itself. Schema validation proves the shape of a pack, never where it came
from. Any JSON file can declare `authority: "normative"`.

An imported pack is therefore untrusted until the operator names its `metadata.id` in
`trustedRulePackIds`. An untrusted pack still supplies its dictionary and its limits. Its claim to
normative standing is capped at `supplementary`. The match is on `metadata.id` alone. The pack name
and the file path do not count.

## What status a diagnostic reports

Two rule paths report status differently. This surprises pack authors, so read the table before you
write `rules[]`.

A deterministic rule reports a violation directly. A candidate rule instead hands the passage to a
semantic evaluator. The passage is reported as `review-required` when no evaluator ran.

| Rule entry            | Deterministic diagnostic           | Candidate (`review-required`) |
| --------------------- | ---------------------------------- | ----------------------------- |
| listed in `rules[]`   | the entry's `status`, trust-capped | ignored. Pack-wide authority  |
| absent from `rules[]` | `provisional`, the rule default    | pack-wide authority           |
| `sourceRef` reported  | the entry's `sourceRef`            | never reported                |

Read the second column downwards. Omitting a rule from `rules[]` leaves it `provisional` even under
a trusted normative pack. Read the third column downwards. Omitting a rule changes nothing there,
because `rules[].status` never applied in the first place.

`runDeterministicRules()` in `src/core/runner.ts` applies the per-rule status to diagnostics only.
Candidates bypass it. `src/analysis/analyse.ts` stamps them later with the pack-wide authority from
`verifiedAuthority()`.

Two consequences follow. A trusted pack promotes a heuristic candidate rule to `normative` even
when the pack lists that rule as `provisional`. The rule's trigger logic is unchanged and stays
heuristic. Nothing gates promotion on whether a trigger is expressible in the schema.

Rule _code_ does not change in either case.

## What the pack cannot do

- It cannot add a new rule. A new rule needs code. See [`rule-authoring.md`](./rule-authoring.md).
- It cannot add a word to a trigger list held in rule code. See `What a pack controls` above.
- It cannot grant a fix that the autofix gate refuses. `safeSubstitution: true` is necessary, but it
  is not enough. `checkFixSafety()` and `gateFix()` still run. They still refuse a fix that changes
  any of the following.
  - a digit.
  - a negation.
  - a modal.
  - an ordering word.

  They also refuse a fix that sits in an admonition.

- It cannot make the linter print conformance wording on its own. The `--json` output does carry a
  `conformance.claim` field. That field is gated by `packPermitsConformanceClaim()` in
  `src/rule-pack/loader.ts`, which needs all three of the following.
  - The pack declares `authority: "normative"`.
  - Its `conformanceClaim` is not `"none"`.
  - Its `metadata.id` is in `trustedRulePackIds`.

  The JSON output reports `"none"` for any pack that fails one of them. The declared value stays in
  `metadata.conformanceClaim` for the audit trail.

## Extending the schema

Your pack might carry data the schema cannot express. A part-of-speech table, per-rule exception
lists, or a sense inventory are examples. In that case, extend `src/rule-pack/schema.ts` and the
consuming rule together. Add a test that confirms the new field changes behaviour. Do not smuggle
data through `rules[].options`. That path is unvalidated beyond the rule's own options schema.
