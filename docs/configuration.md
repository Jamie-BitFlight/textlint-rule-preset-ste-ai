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

Unknown keys used to be dropped instead. That is the worst available outcome for a policy file: the
config parsed, the setting was discarded, and the operator's own file read as evidence of a policy
the linter had never applied. A misspelt diagnostic category applied no severity, a mistyped
`semantic` key left the timeout or threshold at its default, and nothing said so.

The one deliberate exception is `rules.<id>`, which accepts arbitrary keys: each rule declares its
own option schema, and the rule — not this file — is the only thing that can judge its own options.
Options that no rule recognises are therefore still dropped quietly, and an option that a rule
recognises but rejects produces a `rule-options-invalid` notice and skips that rule.

Rule _ids_ are checked even though their options are not. A `rules` key naming no rule the preset
exports produces a `warning`-level `unknown-rule-id` run notice (`detail: { ruleId }`) and the run
continues, so a configuration written for a newer version of this package degrades instead of
failing:

```
Configuration names rule "sentance-length-procedural", which is not a known rule,
so those options were not applied
```

### Protected patterns are screened before they run

Every `extraProtectedPatterns` entry is checked once per run, before any of them is matched against
a document. An entry that fails the check does not run, and each failure produces an
`invalid-protected-pattern` run notice at `error` level — reported in `--json`, in the CLI's text
output, in `AnalysisResult.notices`, and by the textlint adapter anchored at the document start.
`detail.reason` names the specific ground:

| `detail.reason`          | Refused because                                                                                   | Example      |
| ------------------------ | ------------------------------------------------------------------------------------------------- | ------------ |
| `invalid-syntax`         | `new RegExp(source, 'gu')` throws                                                                 | `([unclosed` |
| `source-too-long`        | the source exceeds `MAX_PROTECTED_PATTERN_LENGTH` (exported from `src/core/protected-regions.ts`) | —            |
| `nested-quantifier`      | a repetition is applied to a group whose body already repeats                                     | `(\d+)+`     |
| `quantified-alternation` | a repetition is applied to a group containing an alternation                                      | `(a\|ab)*`   |
| `quantified-optional`    | a repetition is applied to a group containing an optional element                                 | `(a?)+`      |
| `adjacent-repetition`    | the same atom is independently range-quantified twice in a row                                    | `a*a*`       |
| `matches-only-empty`     | every possible match is zero-length, so nothing is ever protected                                 | `^`          |

A refused entry is never silently ignored, because the consequence is not local: the literals it
named are matched as ordinary words by every vocabulary rule, **and** they are no longer masked out
of the passages sent to the semantic service. Silence there would look exactly like a clean run.

The first four grounds bound match time. A repetition nested inside a repetition, wrapped around a
group with an optional element, or repeated immediately next to itself, can take time exponential in
document length — `(a?)+` matches the same span more than one way per iteration for the same reason
`(a+)+` does, just reached through `?` instead of `+`/`*`; `a*a*` has no nesting or alternation at
all, but the same ambiguity in how much of a run of `a`s the first repeat consumed versus the second
— and a JavaScript regular expression cannot be interrupted once matching has begun, so each shape is
refused up front rather than timed. `adjacent-repetition` triggers on two atoms, adjacent and each
independently range-quantified (`\d+\d+`, not just `a*a*`; a lazy quantifier like `\d+?` still
counts, since laziness changes which match is preferred, not whether more than one is possible),
that can match the same character — the same atom spelled identically (`a*a*`), a single-character
class and the bare character it holds (`a*[a]*`, and `[-]*-*`, since a lone `-` in a class has no
adjacent character to form a range with and is unambiguously literal), or two different classes
that share a member (`a*[ab]*`, `[ab]*[bc]*`). An exact count (`{2}`) never qualifies, so
`DOC-[A-Z]{2}-\d+` stays accepted. The check is syntactic and therefore blunt in both directions: it
refuses `(?:foo|bar)+`, which is harmless in practice, and it only proves overlap when both atoms'
character sets are cheaply enumerable — a bare literal, or a class built entirely of individual
literal characters with no range, escape, or negation. A range (`[a-z]`), an escape shorthand inside
or outside a class (`\d`, `[\d]`), a Unicode property escape (`\p{L}`), the wildcard (`.`), or a
character whose meaning changes outside a class (`[.]` versus bare `.`) is left uncompared, on the
same "accept unless provably unsafe" bias as everything else in this screen — so `[a-z]+[0-9]+` is
accepted even though the two classes happen to be disjoint, and `\p{L}*\p{L}*` is refused only
because it is the same escape spelled identically, not because either one's character set was
computed. Rewrite a refused pattern so the repeated group's body neither repeats, alternates, nor
contains an optional element, and so no two adjacent range-quantified atoms can match the same
character — `(?:[A-Z][A-Z]-)+\d+` is accepted where `(?:[A-Z]{2}-)+\d+` is not — or match the shape
without the outer repetition.

`matches-only-empty` is a different kind of refusal: not a complexity risk, just a pattern that can
never do anything. `extraPatternPass` discards a zero-length match because there is no span to
protect, so `^` or a bare lookahead like `(?=PN)` — an atom quantified to occur exactly zero times,
`a{0}` — a _group_ quantified to occur exactly zero times, `(PN){0}`, regardless of what its body
contains — or a backreference to a group that can only ever capture empty, `()\1` — would otherwise
pass every check above and silently protect nothing. Content _outside_ a lookaround still counts:
`(?=PN)PN` consumes the second `PN` and is accepted, and a backreference to a group that actually
consumes, `(a)\1`, is an ordinary consuming atom.

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

`abbreviation-introduction` requires `minLength` to be less than or equal to `maxLength`; the two
bounds become the length range of the abbreviation-shaped token it looks for, and an inverted pair
describes no token at all. An inverted pair is rejected when the options are validated, so the rule
is skipped with a `rule-options-invalid` notice naming it and the rest of the run still reports.
Options that fail validation never abort a run — every rule's options are validated before it runs,
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

Exit codes: `0` clean, `1` errors present (or review-required with `--fail-on-review`), `2` usage
error, `3` a protection mechanism failed rather than a document finding — a semantic-service failure
under the `error` policy, or a refused `extraProtectedPatterns` entry (see "Protected patterns are
screened before they run" above): both mean the run has less protection than the operator's
configuration asked for, not that the document itself has a finding.

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
