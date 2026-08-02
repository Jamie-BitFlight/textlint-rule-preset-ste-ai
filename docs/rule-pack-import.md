# Importing an authorised rule pack

This is the **only** supported route by which normative controlled-language data enters the package.
No rule hard-codes vocabulary: every word list, term mapping and numeric limit is read from the
active pack, so supplying licensed data changes behaviour without changing a line of rule code.

## Before you start

Supplying a pack is a licensing decision. This project makes no determination about what you are
permitted to include, and adds no conformance wording of its own. See
[`DISCLAIMER.md`](./DISCLAIMER.md).

Do not commit a proprietary pack to a public repository. Keep it outside the tree and point at it,
or hold it in a private artefact store.

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

Rule _code_ does not change. Rules whose trigger cannot be expressed in the pack schema stay
provisional regardless of what the pack declares — a pack cannot promote a heuristic by asserting
authority over it.

## What the pack cannot do

- It cannot add a new rule. A new rule needs code; see [`rule-authoring.md`](./rule-authoring.md).
- It cannot grant a fix that the autofix gate refuses. `safeSubstitution: true` is necessary but not
  sufficient: `checkFixSafety()` and `gateFix()` still run, and still refuse anything that changes a
  digit, a negation, a modal, an ordering word, or that sits in an admonition.
- It cannot make the linter print conformance wording. Nothing in the codebase emits a conformance
  claim; `conformanceClaim` only records what the supplier asserts, for the audit trail.

## Extending the schema

If your pack carries data the schema cannot express — a part-of-speech table, per-rule exception
lists, a sense inventory — extend `src/rule-pack/schema.ts` and the consuming rule together, and add
a test that the new field actually changes behaviour. Do not smuggle data through
`rules[].options`: that path is unvalidated beyond the rule's own options schema.
