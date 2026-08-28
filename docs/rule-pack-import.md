# Importing an authorised rule pack

This page describes the only supported route by which normative controlled-language data enters the
package. The active pack supplies the controlled-language dictionary and the numeric limits.
Supplying licensed data therefore changes that behaviour without changing a line of rule code.

Do you want to see a pack work before you write one? [`examples/rule-pack/`](../examples/rule-pack/)
is a complete worked pack. It lints the same document under the bundled pack. Then it lints the
same document under a custom pack, and under that same pack once trusted. See its README for the
trust gate's effect on each run.

Every behaviour this page describes has a passing assertion in
[`test/integration/rule-pack.test.ts`](../test/integration/rule-pack.test.ts). That file covers:

- the trust gate.
- the status split between deterministic and candidate rules.
- `limits`, `contractions`, and `approvedTechnicalTerms`.
- per-rule `severity`, `enabled`, and `options` — each a default the user's own configuration
  outranks.
- relative-path resolution against `baseDir`.
- pack validation.
- the autofix gate's refusal of a pack-declared-safe fix.

It does not assert every combination. One `limits` field stands in for the mechanism, and so does
one `contractions` entry. Read that file when you need the exact answer rather than the summary.

## What a pack controls

A pack changes only what the schema exposes. Do not edit the table below by hand.
`scripts/lib/pack-control-surface.ts` renders it from `rulePackSchema`. Regenerate it with
`npx tsx scripts/write-pack-control-surface.ts`.
`test/architecture/doc-pack-control-surface.test.ts` compares the two and fails when they differ.

<!-- pack-control-surface:begin -->

| Field                                      | What it controls                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `approvedTechnicalTerms`                   | Literal names protected from matching, rewriting, and the heuristics.                        |
| `contractions`                             | The contraction expansions `no-contractions` offers.                                         |
| `contractions[].from`                      | The contraction.                                                                             |
| `contractions[].note`                      | Optional context shown with the diagnostic.                                                  |
| `contractions[].safeSubstitution`          | True only if the expansion is always safe to autofix.                                        |
| `contractions[].to`                        | The expansion.                                                                               |
| `dictionary`                               | The controlled-language word lists.                                                          |
| `dictionary.approved`                      | Terms whose permitted sense the semantic evaluators may check.                               |
| `dictionary.approved[].partsOfSpeech`      | Optional. Parts of speech the approval covers.                                               |
| `dictionary.approved[].senses`             | Optional. Senses the approval covers.                                                        |
| `dictionary.approved[].term`               | The approved term.                                                                           |
| `dictionary.preferred`                     | Term mappings `preferred-terminology` reports.                                               |
| `dictionary.preferred[].from`              | The discouraged term.                                                                        |
| `dictionary.preferred[].note`              | Optional context shown with the diagnostic.                                                  |
| `dictionary.preferred[].safeSubstitution`  | True only if the substitution is always safe.                                                |
| `dictionary.preferred[].to`                | The preferred term.                                                                          |
| `dictionary.unapproved`                    | Terms `unapproved-vocabulary` reports, with their alternatives.                              |
| `dictionary.unapproved[].alternatives`     | Terms the diagnostic suggests instead.                                                       |
| `dictionary.unapproved[].note`             | Optional context shown with the diagnostic.                                                  |
| `dictionary.unapproved[].partOfSpeech`     | Optional. The part of speech this entry covers.                                              |
| `dictionary.unapproved[].safeSubstitution` | True only if `alternatives[0]` cannot change technical meaning. Gates autofix.               |
| `dictionary.unapproved[].term`             | The unapproved term.                                                                         |
| `limits`                                   | The numeric thresholds. Grade levels, cluster length, step count.                            |
| `limits.descriptiveMaxGradeLevel`          | As above, for descriptive sentences.                                                         |
| `limits.maxNounClusterLength`              | Word-count limit `noun-cluster-candidate` reports.                                           |
| `limits.maxSentencesPerProceduralStep`     | Sentence-count limit `list-instruction-structure` reports per numbered step.                 |
| `limits.proceduralMaxGradeLevel`           | Grade level above which a procedural sentence is reported.                                   |
| `limits.sentenceReadabilityFloorWords`     | Sentences shorter than this are never grade-scored.                                          |
| `metadata`                                 | Identity, declared authority, licence, and the conformance claim.                            |
| `metadata.authority`                       | The pack's declared authority. Capped at `supplementary` until the operator trusts the pack. |
| `metadata.conformanceClaim`                | One of none, partial, or declared-by-supplier. Gates the `--json` conformance field.         |
| `metadata.id`                              | The identifier `trustedRulePackIds` must match. Not the pack's name or path.                 |
| `metadata.licence`                         | What the supplier asserts you may distribute, for the audit trail.                           |
| `metadata.name`                            | A human-readable label. Cosmetic. Nothing matches on it.                                     |
| `metadata.notice`                          | Optional notice text, for the audit trail.                                                   |
| `metadata.retrievedAt`                     | Optional. When the source data was retrieved, for the audit trail.                           |
| `metadata.source`                          | Where the data came from, per the supplier, for the audit trail.                             |
| `metadata.version`                         | The pack's own version string, for the audit trail.                                          |
| `rules`                                    | Per-rule authority and defaults.                                                             |
| `rules[].enabled`                          | Whether the rule runs at all.                                                                |
| `rules[].options`                          | Default options, below anything the user configures.                                         |
| `rules[].ruleId`                           | Which registered rule the entry applies to.                                                  |
| `rules[].severity`                         | Default severity, below anything the user configures.                                        |
| `rules[].sourceRef`                        | The citation a deterministic diagnostic reports.                                             |
| `rules[].status`                           | The authority a deterministic diagnostic reports.                                            |

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
    // licensed to supply it. The linter never sets this itself. It is capped at `supplementary`
    // until the operator trusts this pack. See "The trust gate" and "What status a diagnostic
    // reports" below for what it becomes on each rule path once trusted.
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

A rule entry's `sourceRef` is capped the same way. A rule entry can declare `status: "normative"`.
Say the pack is untrusted. The diagnostic then withholds that entry's free-text citation. It
reports `unverified citation from untrusted rule pack "<metadata.id>"` instead. An untrusted pack
cannot fabricate a specific-looking citation next to a `supplementary` tag. A rule entry can instead
never declare `normative`. Such an entry keeps its `sourceRef` regardless of trust. There was no
normative claim for a citation to withhold.

## What status a diagnostic reports

Two rule paths report status differently. This surprises pack authors, so read the table before you
write `rules[]`.

A deterministic rule reports a violation directly. A candidate rule instead hands the passage to a
semantic evaluator. The passage is reported as `review-required` when no evaluator ran.

| Rule entry            | Deterministic diagnostic                   | Candidate (`review-required`) |
| --------------------- | ------------------------------------------ | ----------------------------- |
| listed in `rules[]`   | the entry's `status`, trust-capped         | ignored. Pack-wide authority  |
| absent from `rules[]` | `provisional`, the rule default            | pack-wide authority           |
| `sourceRef` reported  | the entry's `sourceRef`, also trust-capped | never reported                |

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
