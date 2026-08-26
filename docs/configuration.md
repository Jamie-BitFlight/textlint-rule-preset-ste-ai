# Configuration

## textlint

`.textlintrc.json` — enable the whole preset:

```json
{
  "plugins": {
    "@textlint/markdown": true,
    "@textlint/text": true
  },
  "rules": {
    "preset-ste-ai": true
  }
}
```

Or select and tune individual rules. Per-rule options are **nested under the preset key**, not
written as `"preset-ste-ai/<rule-id>"`. textlint resolves anything beginning with `preset-` as a
package name. A slashed key is therefore looked up as a package called `preset-ste-ai/<rule-id>`.
That package is not found, and the whole configuration silently loads no rules at all.

```json
{
  "rules": {
    "preset-ste-ai": {
      "sentence-length-procedural": { "maxGradeLevel": 6 },
      "sentence-length-descriptive": { "maxGradeLevel": 7 },
      "no-contractions": true,
      "abbreviation-introduction": {
        "additionalWellKnown": ["WAL"]
      },
      "punctuation-constraints": { "maxCommas": 2 },
      "passive-voice-candidate": false
    }
  }
}
```

`examples/.textlintrc.json` is a complete working file in this shape, and
`test/e2e/example-config.test.ts` checks that it stays valid.

### Severity

Each diagnostic carries the severity of its category (see
[diagnostic-policy.md](diagnostic-policy.md)). The adapter maps that severity onto textlint's own
severity levels. As a result, `error`, `warning`, and `info` findings are distinguishable in
textlint output and to `--max-warnings`.

A per-rule `severity` overrides the category default for that rule:

```json
{ "rules": { "preset-ste-ai": { "preferred-terminology": { "severity": "warning" } } } }
```

To move a whole category, set it in the shared configuration file instead:

```json
{ "diagnostics": { "severity": { "review-required": "warning" } } }
```

## Shared configuration file

Several settings apply to the whole document and would otherwise have to be repeated on every rule.
They are read once from a shared file, resolved in this order (first hit wins):

1. `$STE_AI_CONFIG` — an explicit path.
2. `.ste-ai.json`, `.ste-ai.jsonc`, or `ste-ai.config.json` in the textlint config base directory.
3. The same names in `process.cwd()`.
4. Built-in defaults: bundled provisional pack, semantic analysis **off**.

`.ste-ai.json`:

```jsonc
{
  // Path to an authorised rule pack, or an inline pack object.
  // Omit to use the bundled provisional pack. See docs/rule-pack-import.md.
  "rulePack": "./ste-rule-pack.json",

  // Terminology protected as literal names: never matched against a vocabulary list,
  // never rewritten, and excluded from noun-cluster and abbreviation heuristics.
  "approvedTerms": ["Acme WidgetPro", "Node.js", "PostgreSQL", "VACUUM", "PRAGMA"],

  // Extra regular expressions protected as identifiers. Screened before use; see
  // "Protected patterns are screened before they run" below.
  "extraProtectedPatterns": ["PN\\d{4,}", "DOC-[A-Z]{2}-\\d+"],

  // Verbs that mark a passage as an instruction, added to the built-in list.
  "extraImperativeVerbs": ["torque", "safety-wire", "swage"],

  "autofix": {
    "enabled": true,
    // Accept model-proposed rewrites that passed an independent equivalence gate.
    // Off by default: enabling it trusts a model verdict to authorise a source edit.
    "allowSemanticFixes": false,
    // "allowInAdmonitions" cannot be set to true.
  },

  // Inline `ste-ai-ignore-*` directives. See docs/suppression.md.
  "suppressions": {
    // Honour inline directives. Set false to make every directive inert: nothing is
    // scanned, nothing is withheld, and the file is reported as if it carried no directives.
    "enabled": true,
    // Permit a directive to withhold a finding inside a danger, warning or caution
    // admonition. Off by default; every suppression is recorded either way.
    "allowInAdmonitions": false,
  },

  "diagnostics": {
    "reportReviewRequired": true,
    "reportSuppressed": false,
    "onSemanticServiceFailure": "notice",
    "severity": {
      "deterministic-violation": "error",
      "probable-semantic-violation": "warning",
      "review-required": "info",
      "suppressed-low-confidence": "info",
      "infrastructure-failure": "warning",
    },
  },

  "semantic": {
    "enabled": false,
    "endpoint": "http://127.0.0.1:8080",
    "model": "local-ste-adjudicator",
    "promptVersion": "v1",
    "maxConcurrency": 2,
    "requestTimeoutMs": 20000,
    "maxTransportRetries": 2,
    "maxRepairAttempts": 1,
    "cache": true,
    "temperature": 0,
    "maxOutputTokens": 512,
    "trace": false,
    "defaultConfidenceThreshold": 0.7,
    "confidenceThresholds": {
      "passive-voice-adjudication": 0.8,
      "pronoun-antecedent-ambiguity": 0.75,
      "noun-cluster-comprehension": 0.85,
    },
    "evaluators": [],
  },

  "rules": {
    "unapproved-vocabulary": { "allow": ["terminate"], "adjudicateSense": true },
    "noun-cluster-candidate": { "maxClusterLength": 4 },
  },
}
```

### An unrecognised key is an error

Every object in the shared configuration is strict. A key the schema does not recognise fails the
load and is named in the message, with its path:

```
Invalid ste-ai configuration:
  diagnostics.severity: Unrecognized key: "style-preference"
```

Unknown keys used to be dropped instead. That is the worst available outcome for a policy file. The
config parsed, and the setting was discarded. The operator's own file then read as evidence of a
policy the linter had never applied. A misspelt diagnostic category applied no severity. A mistyped
`semantic` key left the timeout or threshold at its default. Nothing said so.

The one deliberate exception is `rules.<id>`, which accepts arbitrary keys. Each rule declares its
own option schema. Only the rule itself, not this file, can judge whether its own options are
valid. Options that no rule recognises are therefore still dropped quietly. If a rule recognises an
option but rejects it, the run gets a `rule-options-invalid` notice, and that rule is skipped.

Rule _ids_ are checked even though their options are not. A `rules` key naming no rule the preset
exports produces a `warning`-level `unknown-rule-id` run notice (`detail: { ruleId }`). The run
continues. A configuration written for a newer version of this package therefore degrades instead
of failing:

```
Configuration names rule "sentance-length-procedural", which is not a known rule,
so those options were not applied
```

### Protected patterns are screened before they run

Every `extraProtectedPatterns` entry is checked once per run, before any of them is matched against
a document. An entry that fails the check does not run. Each failure produces an
`invalid-protected-pattern` run notice at `error` level. That notice is reported in `--json`, in
the CLI's text output, and in `AnalysisResult.notices`. It is also reported by the textlint
adapter, anchored at the document start. `detail.reason` names the specific ground:

| `detail.reason`         | Refused because                                                                                   | Example      |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ------------ |
| `invalid-syntax`        | `new RegExp(source, 'gu')` throws                                                                 | `([unclosed` |
| `source-too-long`       | the source exceeds `MAX_PROTECTED_PATTERN_LENGTH` (exported from `src/core/protected-regions.ts`) | —            |
| `unsafe-complexity`     | ReDoS analysis found polynomial or exponential backtracking                                       | `(\d+)+`     |
| `analysis-inconclusive` | ReDoS analysis could not determine whether the expression is safe                                 | —            |
| `matches-only-empty`    | every possible match is zero-length, so nothing is ever protected                                 | `^`          |

A refused entry is never silently ignored, because the consequence is not local. The literals it
named are matched as ordinary words by every vocabulary rule. They are also no longer masked out of
the passages sent to the semantic service. Silence there would look exactly like a clean run.

`invalid-syntax` and `source-too-long` are gates checked before analysis. Valid sources are parsed
by `@eslint-community/regexpp`. `recheck` classifies their ReDoS complexity. `regexp-ast-analysis`
determines whether every possible match is empty. An inconclusive ReDoS result is refused rather
than run. This package does not maintain a second regular-expression parser or a fallback set of
hand-written complexity rules.

### Option precedence

For a rule's options, lowest first:

1. `rules.<id>` in the shared file.
2. `rules.<id>` inside a `shared` object in the rule's textlint options.
3. the rule's own textlint options.

Layers are merged key by key. A lower layer's `enabled: false` is therefore not lost when a higher
layer sets an unrelated key.

### Inline suppression is not one of these layers

`suppressions` is read only from the shared file. There is no per-rule or per-textlint-options form
of it. Inline `ste-ai-ignore-*` directives are applied after every rule has run, to the diagnostics
the run produced. They cannot change a rule's options, and a rule cannot see them.

A suppressed finding is withheld from `diagnostics` but recorded in `AnalysisResult.suppressions`,
in `--json`, and in a `suppressions-applied` notice. See
[suppression.md](suppression.md).

## Offline, deterministic-only mode

This is the default. With `semantic.enabled` false, no network call is made at all — proven by
`test/integration/semantic-service.test.ts`, which asserts the fake server received zero requests.

Passages that would have needed adjudication are reported as `review-required`. A
`semantic-disabled` run notice records how many there were. Nothing is silently treated as compliant.

To be explicit in continuous integration (CI):

```bash
npx ste-ai lint docs/**/*.md --deterministic-only
```

## Per-rule options

Each rule validates its options against its own Zod schema before it runs. The table below names
that schema and where it lives, not the option list itself. The schema is the source of truth.
Copying its field names into prose here would drift when the schema changes. This file would not
change with it. Read the schema for the authoritative option names, types, and defaults.

| Rule                           | Options schema                | Defined in                                       |
| ------------------------------ | ----------------------------- | ------------------------------------------------ |
| `sentence-length-procedural`   | `optionsSchema`               | `src/deterministic/rules/sentence-length.ts:7`   |
| `sentence-length-descriptive`  | `optionsSchema`               | `src/deterministic/rules/sentence-length.ts:7`   |
| `unapproved-vocabulary`        | `unapprovedOptionsSchema`     | `src/deterministic/rules/vocabulary.ts:16`       |
| `preferred-terminology`        | `preferredOptionsSchema`      | `src/deterministic/rules/vocabulary.ts:137`      |
| `no-contractions`              | `contractionOptionsSchema`    | `src/deterministic/rules/vocabulary.ts:218`      |
| `punctuation-constraints`      | `punctuationOptionsSchema`    | `src/deterministic/rules/mechanics.ts:10`        |
| `no-repeated-words`            | `repeatedOptionsSchema`       | `src/deterministic/rules/mechanics.ts:139`       |
| `abbreviation-introduction`    | `abbreviationOptionsSchema`   | `src/deterministic/rules/mechanics.ts:263`       |
| `number-unit-format`           | `numberUnitOptionsSchema`     | `src/deterministic/rules/mechanics.ts:360`       |
| `list-instruction-structure`   | `listOptionsSchema`           | `src/deterministic/rules/structure-rules.ts:15`  |
| `one-instruction-per-sentence` | `oneInstructionOptionsSchema` | `src/deterministic/rules/structure-rules.ts:130` |
| `passive-voice-candidate`      | `passiveOptionsSchema`        | `src/deterministic/rules/candidate-rules.ts:203` |
| `noun-cluster-candidate`       | `nounClusterOptionsSchema`    | `src/deterministic/rules/candidate-rules.ts:297` |
| `ambiguous-pronoun-candidate`  | `pronounOptionsSchema`        | `src/deterministic/rules/candidate-rules.ts:432` |

Every candidate rule's schema (`passive-voice-candidate`, `noun-cluster-candidate`,
`ambiguous-pronoun-candidate`, and `one-instruction-per-sentence`) includes an `adjudicate` field.
Setting `adjudicate: false` makes the rule report `review-required` locally instead of producing a
semantic candidate.

`abbreviation-introduction` requires `minLength` to be less than or equal to `maxLength`. The two
bounds become the length range of the abbreviation-shaped token it looks for. An inverted pair
describes no token at all. An inverted pair is rejected when the options are validated. The rule is
then skipped with a `rule-options-invalid` notice naming it, and the rest of the run still reports.
Options that fail validation never abort a run. Every rule's options are validated before it runs,
and a rule whose options are invalid is skipped this way.

## CLI

```bash
# machine-readable, deterministic only
npx ste-ai lint docs/install.md --json

# with a local model, tracing each request to stderr
npx ste-ai lint docs/install.md --semantic --endpoint http://127.0.0.1:8080 --trace

# fail CI on anything needing review
npx ste-ai lint docs/**/*.md --fail-on-review

# inspect the rule set and the evaluators
npx ste-ai rules --json
npx ste-ai evaluators
```

Exit codes:

- `0` — clean.
- `1` — errors present. This also includes review-required findings when `--fail-on-review` is set.
- `2` — usage error.
- `3` — any `error`-level run notice. This means one of two things. The run had less protection
  than the operator's configuration asked for. Alternatively, fewer of its configured rules ran
  than the operator asked for. It does not mean the document itself has a finding.

Current examples of an `error`-level run notice:

- A semantic-service failure under the `error` policy.
- A refused `extraProtectedPatterns` entry. See the "Protected patterns are screened before they
  run" section above.
- A rule skipped over invalid options (`rule-options-invalid`, described above).

## Programmatic API

```ts
import { analyseText, analyseTextDeterministic } from 'textlint-rule-preset-ste-ai/analysis';

// Offline, synchronous, no I/O beyond reading the rule pack.
const offline = analyseTextDeterministic(source, { path: 'docs/install.md', format: 'markdown' });
for (const d of offline.diagnostics) {
  console.log(d.category, d.ruleId, d.ruleStatus, d.range, d.message);
}

// With semantic adjudication, and an injected transport for tests.
const full = await analyseText(source, {
  path: 'docs/install.md',
  config: { semantic: { enabled: true, endpoint: 'http://127.0.0.1:8080' } },
  transport: myFakeTransport, // optional dependency injection
  brokerDeps: { trace: (t) => log(t) },
  signal: abortController.signal,
});

console.log(full.notices); // run-level events: outages, disabled candidates, refused fixes
console.log(full.traces); // per-request prompt version, model id, content hash, latency
console.log(full.pack.metadata.conformanceClaim); // 'none' for the bundled pack
```

`AnalysisResult.document` is the `AnalysedDocument`. It exposes protected regions, blocks,
sentences, words and `positionAt()` for converting an offset to a line and column position.
