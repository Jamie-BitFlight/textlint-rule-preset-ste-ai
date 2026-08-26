# Importing an authorised rule pack

This page describes the only supported route by which normative controlled-language data enters the package.
The active pack supplies the controlled-language dictionary — approved, unapproved, and preferred
terms, and contractions — and the numeric limits. Supplying licensed data therefore changes that
behaviour without changing a line of rule code.

Some candidate rules also hard-code the trigger vocabulary they scan for — for example the
`PARTICIPLES`, `PRONOUNS`, and `BARE_DEMONSTRATIVE_FOLLOWERS` lists in
[`src/deterministic/rules/candidate-rules.ts`](../src/deterministic/rules/candidate-rules.ts).
A pack cannot change those lists. It can only change what the pack schema exposes: the dictionary,
the limits, and per-rule options and authority.

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

## What changes when you supply a normative pack

|                                  | Bundled provisional pack                  | Normative pack                          |
| -------------------------------- | ----------------------------------------- | --------------------------------------- |
| `meta.status` reported per rule  | `provisional`                             | the pack's `rules[].status`             |
| Message tag                      | `[provisional]`                           | `[normative]`                           |
| `sourceRef`                      | `provisional:docs/provisional-rules.md#…` | the pack's citation                     |
| `packPermitsConformanceClaim()`  | `false`                                   | `true` if `conformanceClaim !== 'none'` |
| Vocabulary, limits, contractions | small authored set                        | yours                                   |

Rule _code_ does not change. `runDeterministicRules()` (`src/core/runner.ts`) applies a pack's
declared status to any rule the pack lists in `rules[]`. This includes a heuristic candidate rule
whose trigger the pack schema cannot express. There is no separate check that gates status
promotion on whether a rule's trigger is pack-expressible. The only gate is `trustedRulePackIds`: a
pack not named there is capped at `supplementary` even when it declares `normative`, per
`verifiedRuleStatus()` in `src/core/runner.ts`. A pack you have named as trusted can therefore make
a heuristic rule's diagnostics report `normative`. The rule's own trigger logic stays unchanged and
still heuristic.

## What the pack cannot do

- It cannot add a new rule. A new rule needs code. See [`rule-authoring.md`](./rule-authoring.md).
- It cannot grant a fix that the autofix gate refuses. `safeSubstitution: true` is necessary, but it
  is not enough. `checkFixSafety()` and `gateFix()` still run. They still refuse a fix that changes
  any of the following.
  - a digit.
  - a negation.
  - a modal.
  - an ordering word.

  They also refuse a fix that sits in an admonition.

- It cannot make the linter print conformance wording on its own. `--json` output does include a
  `conformance.claim` field, but only when `packPermitsConformanceClaim()` (`src/rule-pack/loader.ts`)
  returns `true`: the pack declares `authority: "normative"`, its `conformanceClaim` is not `"none"`,
  and its `metadata.id` is in `trustedRulePackIds`. An untrusted or non-normative pack's
  `conformanceClaim` is never surfaced there — the JSON output reports `"none"` instead. It stays
  recorded only in `metadata.conformanceClaim`, for the audit trail.

## Extending the schema

Your pack might carry data the schema cannot express: a part-of-speech table, per-rule exception
lists, or a sense inventory. In that case, extend `src/rule-pack/schema.ts` and the consuming rule
together. Add a test that confirms the new field actually changes behaviour. Do not smuggle data
through `rules[].options`: that path is unvalidated beyond the rule's own options schema.
