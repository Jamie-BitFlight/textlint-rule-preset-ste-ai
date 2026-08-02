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
written as `"preset-ste-ai/<rule-id>"`: textlint resolves anything beginning with `preset-` as a
package name, so a slashed key is looked up as a package called `preset-ste-ai/<rule-id>`, is not
found, and the whole configuration silently loads no rules at all.

```json
{
  "rules": {
    "preset-ste-ai": {
      "sentence-length-procedural": { "maxGradeLevel": 6 },
      "sentence-length-descriptive": { "maxGradeLevel": 7 },
      "no-contractions": true,
      "abbreviation-introduction": {
        "additionalWellKnown": ["VACUUM", "PRAGMA", "WAL"]
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

Each diagnostic carries the severity of its category (see [diagnostic-policy.md](diagnostic-policy.md))
and the adapter maps that onto textlint's own severity levels, so `error`, `warning` and `info`
findings are distinguishable in textlint output and to `--max-warnings`.

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

1. `$STE_AI_CONFIG` — an explicit path;
2. `.ste-ai.json`, `.ste-ai.jsonc` or `ste-ai.config.json` in the textlint config base directory;
3. the same names in `process.cwd()`;
4. built-in defaults — bundled provisional pack, semantic analysis **off**.

`.ste-ai.json`:

```jsonc
{
  // Path to an authorised rule pack, or an inline pack object.
  // Omit to use the bundled provisional pack. See docs/rule-pack-import.md.
  "rulePack": "./ste-rule-pack.json",

  // Terminology protected as literal names: never matched against a vocabulary list,
  // never rewritten, and excluded from noun-cluster and abbreviation heuristics.
  "approvedTerms": ["Acme WidgetPro", "Node.js", "PostgreSQL", "VACUUM", "PRAGMA"],

  // Extra regular expressions protected as identifiers.
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

### Option precedence

For a rule's options, lowest first:

1. `rules.<id>` in the shared file;
2. `rules.<id>` inside a `shared` object in the rule's textlint options;
3. the rule's own textlint options.

Layers are merged key by key, so a lower layer's `enabled: false` is not lost when a higher layer sets
an unrelated key.

### Inline suppression is not one of these layers

`suppressions` is read only from the shared file; there is no per-rule or per-textlint-options form
of it. Inline `ste-ai-ignore-*` directives are applied after every rule has run, to the diagnostics
the run produced, so they cannot change a rule's options and a rule cannot see them.

A suppressed finding is withheld from `diagnostics` but recorded in `AnalysisResult.suppressions`,
in `--json`, and in a `suppressions-applied` notice. See
[suppression.md](suppression.md).

## Offline, deterministic-only mode

This is the default. With `semantic.enabled` false, no network call is made at all — proven by
`test/integration/semantic-service.test.ts`, which asserts the fake server received zero requests.

Passages that would have needed adjudication are reported as `review-required`, and a
`semantic-disabled` run notice records how many there were. Nothing is silently treated as compliant.

To be explicit in CI:

```bash
npx ste-ai lint docs/**/*.md --deterministic-only
```

## Per-rule options

| Rule                           | Options                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `sentence-length-procedural`   | `maxGradeLevel`, `floorWords`, `includeHeadings`, `includeTableCells`                                                             |
| `sentence-length-descriptive`  | `maxGradeLevel`, `floorWords`, `includeHeadings`, `includeTableCells`                                                             |
| `unapproved-vocabulary`        | `additional` (`{term: [alternatives]}`), `allow`, `adjudicateSense`                                                               |
| `preferred-terminology`        | `additional` (`{from: to}`), `allow`                                                                                              |
| `no-contractions`              | `allow`                                                                                                                           |
| `punctuation-constraints`      | `forbidSemicolon`, `forbidSlashBetweenWords`, `forbidExclamation`, `forbidEllipsis`, `forbidParenthesesInProcedural`, `maxCommas` |
| `no-repeated-words`            | `allow` (default `["had","that"]`)                                                                                                |
| `abbreviation-introduction`    | `minLength`, `maxLength`, `wellKnown` (replaces), `additionalWellKnown` (adds)                                                    |
| `number-unit-format`           | `unitSpacing` (`required`\|`forbidden`\|`off`), `noSpaceUnits`, `forbidDecimalComma`                                              |
| `list-instruction-structure`   | `checkTerminalPunctuation`, `checkInitialCapital`, `maxSentencesPerStep`                                                          |
| `one-instruction-per-sentence` | `conjunctions`, `adjudicate`                                                                                                      |
| `passive-voice-candidate`      | `requireByAgent`, `adjudicate`                                                                                                    |
| `noun-cluster-candidate`       | `maxClusterLength`, `adjudicate`                                                                                                  |
| `ambiguous-pronoun-candidate`  | `minAntecedents`, `adjudicate`                                                                                                    |

Setting `adjudicate: false` on a candidate rule makes it report `review-required` locally instead of
producing a semantic candidate.

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

Exit codes: `0` clean, `1` errors present (or review-required with `--fail-on-review`), `2` usage
error, `3` semantic-service failure under the `error` policy.

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

`AnalysisResult.document` is the `AnalysedDocument`: protected regions, blocks, sentences, words and
`positionAt()` for converting an offset to line/column.
