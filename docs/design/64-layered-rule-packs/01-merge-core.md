# Layered rule packs — the composition core

> **Read [`00-decisions.md`](./00-decisions.md) first.** This spec is one of three produced
> independently, and the decision record overturns part of it: the new `rulePacks` config key is
> replaced by widening the existing `rulePack`, `replace` mode is dropped, and the composed output
> no longer has to satisfy `RulePack` exactly. Nothing below has been rewritten to match, on purpose
> — the specs are the reasoning, `00` is the conclusion.

Spec scope: the merge algorithm and the schema/config changes that support it.
Out of scope (owned elsewhere): authority/trust, `trustedRulePackIds`, `verifiedAuthority`,
per-entry provenance reporting, migration, fixtures, pack distribution. Seams are marked
**[AUTHORITY-SEAM]** and stop at the seam.

Line citations were written against commit `9d78a8b`, which turned out to be a sibling of this
branch rather than an ancestor, and have since been re-checked against the branch with `main` merged
in. Any that still name `9d78a8b` describe that commit, not this tree.

---

## Summary

Composition is a **left fold over an ordered layer list**, producing a value that satisfies the
existing `RulePack` interface (`src/core/types.ts:474-486`) exactly. No rule, no evaluator and no
consumer learns a new type. Concretely:

1. Start from an implicit base: the bundled `provisionalRulePack`.
2. If the first declared layer has `mode: "replace"`, it _becomes_ the base and the bundled pack is
   discarded. `replace` is legal only at index 0.
3. Every subsequent layer is applied with `mode: "extend"`: first its `retract` block removes keys
   from the accumulator, then its own entries are upserted by key.
4. The composed pack is checked for contradictions. Some throw, some emit `RunNotice`s, some are
   silent by design.

`rulePack: X` (singular) stays valid and is exactly `rulePacks: [{ source: X, mode: "replace" }]` —
which is exactly today's behaviour, so the singular form is not merely tolerated, it is _defined by_
the new algorithm.

Two design constraints drive most of what follows, and both are verified rather than assumed:

- **Composed array order is observable in output.** `unapprovedVocabularyRule` sorts entries by
  `term.length` descending (`src/deterministic/rules/vocabulary.ts:64`) and then claims
  non-overlapping ranges first-come-first-served (`vocabulary.ts:70-72`). `Array.prototype.sort` is
  stable, so ties break by array position. Which of two equal-length terms wins an overlapping match
  is therefore decided by composed array order. Determinism here is load-bearing, not cosmetic.
- **The merge key must be the key the _matcher_ uses, per field, and the matchers disagree with each
  other.** Vocabulary matching is case-insensitive and whitespace-collapsing
  (`src/deterministic/helpers.ts:5-11`, flags `giu`, `\s+` normalisation). Technical-term protection
  is case-**sensitive** with no whitespace normalisation (`approvedTermPass` in
  `src/core/protected-regions.ts`, flags `gu`). Contractions are matched under both apostrophe forms
  (`vocabulary.ts:248`, `variantsOf` at `vocabulary.ts:280-283`). One global normalisation function
  would be wrong for at least one field.

---

## Current behaviour (verified)

### Substitution, not composition

`resolveRulePack` (`src/rule-pack/loader.ts:49-56`) is three branches, each returning exactly one
pack:

```ts
if (spec === undefined) return provisionalRulePack; // loader.ts:53
if (typeof spec === 'string') return loadRulePackFromFile(spec, baseDir); // loader.ts:54
return parseRulePack(spec, 'inline configuration'); // loader.ts:55
```

Naming a project pack therefore discards the bundled pack whole. Measured contents of
`provisionalRulePack` (obtained by importing `src/rule-pack/provisional-pack.ts` under `npx tsx`):

| field                    | count |
| ------------------------ | ----- |
| `dictionary.unapproved`  | 61    |
| `dictionary.approved`    | 6     |
| `dictionary.preferred`   | 7     |
| `contractions`           | 35    |
| `approvedTechnicalTerms` | 0     |
| `rules`                  | 14    |

`limits` is `{proceduralMaxGradeLevel: 7, descriptiveMaxGradeLevel: 8,
sentenceReadabilityFloorWords: 20, maxNounClusterLength: 3, maxSentencesPerProceduralStep: 1}`.
`metadata.id` is `ste-ai-provisional`, `authority: "provisional"`, `conformanceClaim: "none"`.

The rule count 14 is asserted by CI: `scripts/ci/check-rules-provisional.sh` passes the literal `14`
to `scripts/ci/assert-rules-provisional.mjs`, which fails the build on a mismatch
(`assert-rules-provisional.mjs:28-33`). That script counts _shipped rule code_ via `cli rules --json`,
not pack entries, so composition does not by itself invalidate it — but any change that alters what
`cli rules` prints must reconcile it.

### Config today

```ts
rulePack: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),  // src/core/config.ts:124
```

Two call sites bind the result directly and neither has a channel for load-time diagnostics:

- `src/analysis/analyse.ts:244` — `const pack = resolveRulePack(config.rulePack, options.baseDir ?? process.cwd());`
- `src/evaluation/evaluate.ts:227` — `const pack = resolveRulePack(config.rulePack);`

### Schema fields

`rulePackSchema` (`src/rule-pack/schema.ts:93-104`) has exactly seven top-level keys:
`metadata`, `limits`, `dictionary` (`{approved, unapproved, preferred}`), `contractions`,
`approvedTechnicalTerms`, `rules`. Entry shapes:

- `approvedTermSchema` — `{term, partsOfSpeech?, senses?}` (`schema.ts:33-37`)
- `unapprovedTermSchema` — `{term, alternatives=[], note?, safeSubstitution=false, partOfSpeech?}`
  (`schema.ts:39-49`). Note the brief omitted `partOfSpeech`; it exists.
- `preferredTermSchema` — `{from, to, safeSubstitution=false, note?}` (`schema.ts:51-56`); used for
  both `dictionary.preferred` and `contractions` (`schema.ts:99,101`).
- `rulePackLimitsSchema` — five **required** numbers with bounds (`schema.ts:58-77`).
- `rulePackRuleSpecSchema` — `{ruleId, status, sourceRef, enabled=true, severity?, options?}`
  (`schema.ts:79-91`).

### How pack data is consumed (this is what constrains merge semantics)

- `dictionary.unapproved` → `vocabulary.ts:53-61`, concatenated with `options.additional`, filtered
  by `options.allow` (lowercased set, `vocabulary.ts:51,61`), sorted longest-first (`:64`).
  `safeSubstitution` gates whether a `TextFix` is attached at all (`:77-84`).
- `dictionary.preferred` → `vocabulary.ts:164-173`, same shape of pipeline, `allow` keyed on `from`.
- `contractions` → `vocabulary.ts:242`, `allow` keyed on `from`; apostrophe variants at `:248,280-283`.
- `approvedTechnicalTerms` → merged into protected-region `approvedTerms` at `analyse.ts:255` and
  `evaluate.ts:244`; matched case-sensitively (`approvedTermPass` in `protected-regions.ts`).
  Vocabulary matching runs against `sentence.masked`, so a protected term can never be matched by a
  vocabulary rule (`helpers.ts:18-23`).
- `limits` → five consumers, each `options.X ?? pack.limits.X`:
  `structure-rules.ts:43`, `candidate-rules.ts:331`, `sentence-length.ts:28-30`.
- `rules` → indexed by `ruleId` in `runDeterministicRules` (`src/core/runner.ts:51`), then used for
  `enabled` (`:59`), options base (`:62-65`, a **shallow spread**:
  `{...packSpec?.options, ...stripControlKeys(userConfig)}`), `severity` (`:79`), and
  `status`/`sourceRef` on emitted diagnostics (`:93-113`).
- `dictionary.approved` → **no production reader at this commit.** A grep over `src/` for
  `.approved` (excluding `approvedTerms`/`approvedTechnicalTerms`) returns nothing. The
  `approved-word-sense` evaluator declares a `permittedSenses` payload key
  (`src/semantic/evaluators.ts:28`) but the only construction of that key in the tree is
  `test/unit/prompts.test.ts:37`; the candidate actually built by `vocabulary.ts:115-119` supplies
  `word`, `approvedAlternatives`, `offsetInPassage` and no senses. So the merge rule for
  `dictionary.approved` is currently unobservable in behaviour. Specified conservatively below and
  flagged.

### Run-level notices (the existing mechanism — do not invent a new one)

`RunNotice` is `{code, level: 'info'|'warning'|'error', message, detail?}`
(`src/core/types.ts:253-258`). Notices are accumulated per subsystem and concatenated into
`AnalysisResult.notices` (`src/analysis/analyse.ts:314` and `:634`). Precedents worth copying:

- `runner.ts:66-75` emits `rule-options-invalid` at `error` when a rule's options fail validation and
  the rule is skipped — a _configuration_ defect surfaced as a notice, exactly the family my
  conflict notices belong to.
- `analysis/analyse.ts:515-518` (`withRunTotal`) replaces per-item notices with **one aggregate**
  notice carrying a count. Copy this for high-cardinality merge events.

Two delivery caveats, both verified:

- The textlint adapter **drops `info`-level notices**: `if (notice.level === 'info') continue;`
  (`src/textlint/adapter.ts:298-299`). Anything classified `info` is invisible to a textlint user.
- The CLI prints every notice regardless of level (`src/cli/main.ts:246-249`), and the programmatic
  API exposes them all on `AnalysisResult.notices`.

So "info" here means "audit trail, not a nag" — and choosing it is a real decision about visibility,
not a soft warning.

---

## Config schema changes

### New pieces in `src/core/config.ts`

```ts
/** How a layer combines with everything declared before it. */
export const rulePackModeSchema = z.enum(['extend', 'replace']);

/** A pack reference: a path (resolved like today's `rulePack`) or an inline pack object. */
export const rulePackSourceSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);

export const rulePackLayerSchema = z.object({
  source: rulePackSourceSchema,
  mode: rulePackModeSchema.default('extend'),
});

/** Shorthand: a bare source in the array means `{ source, mode: 'extend' }`. */
export const rulePackLayerInputSchema = z.union([rulePackSourceSchema, rulePackLayerSchema]);
```

`steAiConfigSchema` (`src/core/config.ts:119-145`) gains one key and keeps the old one:

```ts
export const steAiConfigSchema = z
  .object({
    /**
     * @deprecated Single-pack form. Exactly equivalent to
     * `rulePacks: [{ source: <value>, mode: 'replace' }]` — it *replaces* the bundled pack.
     */
    rulePack: rulePackSourceSchema.optional(),

    /**
     * Ordered layer stack, lowest authority first. Each layer merges onto everything before it.
     * The bundled provisional pack is an implicit layer 0 unless the first entry says
     * `mode: 'replace'`.
     */
    rulePacks: z.array(rulePackLayerInputSchema).optional(),

    // …unchanged keys…
  })
  .superRefine((cfg, ctx) => {
    if (cfg.rulePack !== undefined && cfg.rulePacks !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['rulePacks'],
        message:
          'Set either "rulePack" or "rulePacks", not both. The singular form is equivalent to ' +
          '`rulePacks: [{ "source": <your value>, "mode": "replace" }]`; put that entry first in ' +
          '"rulePacks" and delete "rulePack".',
      });
    }
    const layers = cfg.rulePacks ?? [];
    layers.forEach((layer, index) => {
      const mode = typeof layer === 'object' && 'mode' in layer ? layer.mode : 'extend';
      if (mode === 'replace' && index > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['rulePacks', index, 'mode'],
          message:
            `"replace" is only legal on the first layer. At index ${index} it would discard the ` +
            `${index} layer(s) declared before it, making them dead configuration. To drop ` +
            'individual entries from an earlier layer, use that layer\'s "retract" block.',
        });
      }
    });
  });
```

Note the zod idiom in this file is v4-flavoured (`z.record(z.string(), …)`, `.prefault({})` — see
`config.ts:104,139-144`). `.superRefine`, `.refine` and `ctx.addIssue` appear nowhere in `src/`
today, so the block above introduces that idiom rather than following it. Putting it on the object
keeps `SteAiConfig` as `z.output<typeof steAiConfigSchema>` (`config.ts:147`) and leaves
`resolveConfig` (`config.ts:150-152`) unchanged.

### Normalisation to a canonical stack

Composition never sees the union types. `resolveConfig`'s consumer normalises once:

```ts
export interface NormalisedLayer {
  readonly source: string | Record<string, unknown>;
  readonly mode: 'extend' | 'replace';
  /** 0-based position in the declared stack, after the implicit base. Used for notice `detail`. */
  readonly index: number;
}

export function normaliseRulePackStack(cfg: SteAiConfig): readonly NormalisedLayer[] {
  if (cfg.rulePack !== undefined) return [{ source: cfg.rulePack, mode: 'replace', index: 0 }];
  return (cfg.rulePacks ?? []).map((entry, index) =>
    typeof entry === 'object' && entry !== null && 'source' in entry
      ? { source: entry.source, mode: entry.mode ?? 'extend', index }
      : { source: entry as string | Record<string, unknown>, mode: 'extend' as const, index },
  );
}
```

Equivalences this fixes in place (all three must hold, and all three are today's behaviour):

| config                    | composed result        | today's code path                              |
| ------------------------- | ---------------------- | ---------------------------------------------- |
| neither key               | bundled pack alone     | `loader.ts:53`                                 |
| `rulePack: "./p.json"`    | `./p.json` alone       | `loader.ts:54`                                 |
| `rulePack: {…}`           | that object alone      | `loader.ts:55`                                 |
| `rulePacks: []`           | bundled pack alone     | new; allowed, silent                           |
| `rulePacks: ["./p.json"]` | **bundled ∪ ./p.json** | new — _not_ the same as `rulePack: "./p.json"` |

That last row is the one that will bite people. It is intentional: `extend` is the default because
layering is the point, and `replace` must be spelled out because losing 61 unapproved entries and 35
contractions should require typing the word.

### Validation rules, complete list

| #   | rule                                                           | outcome                                                                                       |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| C1  | `rulePack` and `rulePacks` both set                            | zod error (config invalid)                                                                    |
| C2  | `mode: "replace"` at index > 0                                 | zod error                                                                                     |
| C3  | `rulePacks: []`                                                | valid; bundled pack alone                                                                     |
| C4  | duplicate `source` string in the stack                         | valid; `info` notice `rule-pack-layer-repeated`                                               |
| C5  | a layer's file cannot be read / is not JSON / fails its schema | `RulePackError` throw, as today (`loader.ts:26-41`), message names the layer index and source |
| C6  | a `replace` layer fails full `rulePackSchema`                  | `RulePackError` — a replace layer becomes the base and must be complete (see below)           |

### Two pack schemas, not one

A `replace` layer becomes the base, so it must supply everything the base contract requires —
notably all five `limits` (`schema.ts:58-77` has no defaults). An `extend` layer must be allowed to
say _only_ what it changes. So:

```ts
// src/rule-pack/schema.ts

/** Unchanged. The contract a base pack satisfies. Existing packs keep parsing. */
export const rulePackSchema = z.object({/* …as today… */});

/** What an `extend` layer may be. Everything optional except metadata. */
export const rulePackLayerContentSchema = z.object({
  metadata: rulePackMetadataSchema,
  limits: rulePackLimitsSchema.partial().optional(),
  dictionary: z
    .object({
      approved: z.array(approvedTermSchema).default([]),
      unapproved: z.array(unapprovedTermSchema).default([]),
      preferred: z.array(preferredTermSchema).default([]),
    })
    .prefault({}),
  contractions: z.array(preferredTermSchema).default([]),
  approvedTechnicalTerms: z.array(z.string()).default([]),
  rules: z.array(rulePackRuleSpecSchema.partial().required({ ruleId: true })).default([]),
  retract: retractionSchema.optional(), // §Retraction
});
```

`metadata` stays required on a layer — a layer that cannot say who it is and under what licence has
no business contributing normative-looking data, and the authority spec needs the per-layer record.

`rules` entries become partial-except-`ruleId` for layers, because a locale layer that only wants to
flip `enabled` should not have to restate `status` and `sourceRef` (which are the two fields the
authority spec cares most about — restating them is precisely the escalation nobody wants).
A `replace`/base layer still needs the full `rulePackRuleSpecSchema`.

---

## Per-field merge table

Applied per layer, in this **fixed field order** (which also fixes notice emission order):
`limits`, `dictionary.approved`, `dictionary.unapproved`, `dictionary.preferred`, `contractions`,
`approvedTechnicalTerms`, `rules`, then `metadata` (synthesised last).

Key normalisation functions — three of them, because the matchers differ:

```ts
/** Vocabulary key: mirrors termPattern (helpers.ts:5-11) — case-insensitive, whitespace-collapsing. */
const vocabKey = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Contraction key: vocabKey plus the apostrophe fold the matcher already performs
 *  (vocabulary.ts:280-283 maps U+0027 and U+2019 onto one entry). */
const contractionKey = (s: string): string => vocabKey(s).replace(/’/g, "'");

/** Technical-term key: the exact string. protected-regions.ts's approvedTermPass matches
 *  case-sensitively with no whitespace normalisation, so "Abort" and "abort" are genuinely
 *  different entries. */
const technicalKey = (s: string): string => s;
```

Deliberately **not** applying `String.prototype.normalize('NFC')`: `termPattern`
(`helpers.ts:5-11`) does not normalise either, so an NFC merge key would fuse two entries the
matcher treats as distinct — a silently-lost ban. Recorded as an open question, not fixed here.

| field                    | merge key                                                                | merge rule                                      | collision behaviour                                                                                 | notice                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `metadata`               | —                                                                        | not merged; **synthesised** from the layer list | n/a                                                                                                 | — **[AUTHORITY-SEAM]**                                                                                        |
| `limits`                 | field name                                                               | **per-key last-wins** over the five scalars     | later layer's value applies                                                                         | `rule-pack-limit-overridden`, `info` if the new value is stricter-or-equal, `warning` if it loosens (§limits) |
| `dictionary.approved`    | `vocabKey(term)`                                                         | keyed upsert, **whole-entry replace**           | later entry replaces earlier entirely (including dropping `senses`/`partsOfSpeech` the earlier had) | counted into the aggregate override notice                                                                    |
| `dictionary.unapproved`  | `vocabKey(term)`                                                         | keyed upsert, **whole-entry replace**           | later entry replaces earlier entirely                                                               | aggregate override notice; plus `rule-pack-fix-safety-escalated` if `safeSubstitution` goes false→true        |
| `dictionary.preferred`   | `vocabKey(from)`                                                         | keyed upsert, **whole-entry replace**           | later entry replaces earlier entirely                                                               | as above                                                                                                      |
| `contractions`           | `contractionKey(from)`                                                   | keyed upsert, **whole-entry replace**           | later entry replaces earlier entirely                                                               | as above                                                                                                      |
| `approvedTechnicalTerms` | `technicalKey(s)` (exact)                                                | **set union**, first-insertion order preserved  | duplicate is a no-op                                                                                | none                                                                                                          |
| `rules`                  | `ruleId` (exact; ids are code-owned, `runner.ts:51` keys on the literal) | keyed upsert, **field-by-field merge**          | see below                                                                                           | aggregate override notice; `status` change is **[AUTHORITY-SEAM]**                                            |

### Why whole-entry replace for the four term lists

The alternative — field-by-field merge, so a layer could set `safeSubstitution: true` while
inheriting `alternatives` — reads attractive and is wrong here. `alternatives`, `safeSubstitution`
and `note` are one semantic unit: `safeSubstitution` is a claim _about `alternatives[0]`_
specifically (`schema.ts:43-47`, and the fix is built from `alternatives[0]` at
`vocabulary.ts:76-84`). Letting one layer supply the alternatives and another supply the safety
claim produces an autofix nobody authored. Whole-entry replace means the layer that asserts
`safeSubstitution: true` is the layer that also wrote the alternative it is vouching for. The cost
is verbosity — a layer that only wants to add a `note` must restate the entry — and that is the
correct trade for a field that authorises source mutation.

`dictionary.approved` follows the same rule for consistency, but see the caveat: nothing reads it
today, so the choice is currently unobservable and cheap to revisit.

### `rules`: field-by-field, with `options` shallow

```ts
function mergeRuleSpec(base: RulePackRuleSpec, layer: Partial<RulePackRuleSpec>): RulePackRuleSpec {
  return {
    ...base,
    ...definedOnly(layer), // ruleId/status/sourceRef/enabled/severity
    ...(layer.options === undefined ? {} : { options: { ...base.options, ...layer.options } }), // SHALLOW, one level
  };
}
```

Field-by-field rather than whole-spec replace, because a layer partial-by-schema (above) that only
sets `enabled: false` would otherwise wipe `status` and `sourceRef` — and `sourceRef` is what a
diagnostic prints (`runner.ts:110`). Whole-spec replace would make "turn this rule off for our
locale" silently erase the rule's citation.

`options` is shallow-merged, one level, **because that is what the runtime already does**:
`runner.ts:60-63` composes `{...packSpec?.options, ...stripControlKeys(userConfig)}` — a shallow
spread — and `docs/configuration.md:150-159` documents the user-facing precedence as "merged key by
key". A deep merge in composition would give pack layers a different combining rule than the one the
config layer immediately above them uses, for the same object. Two different merge depths on one
value is a bug generator. Concretely, with shallow merge a layer that sets
`{"unapproved-vocabulary": {"allow": ["x"]}}` **replaces** the array rather than appending to it —
correct, since array-append semantics are unrepresentable in the schema (`options` is
`z.record(z.string(), z.unknown())`, `schema.ts:90`) and would require guessing per key.

Because `options` is `unknown`-valued, composition performs no validation of it. Invalid options
still surface exactly as today: at rule-run time, as a `rule-options-invalid` error notice
(`runner.ts:66-75`).

### Metadata of the composed pack

The composed value must satisfy `RulePackMetadata` (`types.ts:412-425`), so _something_ has to be
produced. The merge core produces this much and no more:

```ts
export interface LayerDescriptor {
  readonly index: number; // 0 = base
  readonly mode: 'extend' | 'replace';
  readonly origin: string; // resolved path, or 'inline configuration'
  readonly metadata: RulePackMetadata; // verbatim, as declared by that layer
}

export interface RulePackComposition {
  readonly pack: RulePack; // satisfies the existing interface exactly
  readonly layers: readonly LayerDescriptor[]; // ordered, base first
  readonly notices: readonly RunNotice[];
  readonly provenance: EntryProvenance; // see §Seams
}
```

Core-owned defaults for `pack.metadata`, deliberately conservative and explicitly provisional until
the authority spec lands:

- `id`: `"composed:" + layers.map(l => l.metadata.id).join("+")` — deterministic, and it never
  collides with a single pack's own id, so it can never accidentally match a `trustedRulePackIds`
  entry.
- `name`, `version`, `licence`, `source`, `retrievedAt`, `notice`: taken from the **last** layer.
  This is a placeholder, and a poor one for `licence` in particular — a composed pack that mixes an
  MIT bundled pack with a share-alike org pack has no single correct licence string.
  **[AUTHORITY-SEAM]** — the licence/notice composition question belongs to the authority spec;
  `layers[]` gives it everything it needs.
- `authority`, `conformanceClaim`: **[AUTHORITY-SEAM]**. The core sets `authority` to the weakest
  value present across layers and `conformanceClaim: 'none'` if any layer says `none`, purely so
  that a half-implemented stack cannot _gain_ authority by being composed. Note the code declares no
  ordering over `ruleStatusSchema` (`schema.ts:14` is a bare enum); "weakest" is my proposal, not an
  existing fact, and the authority spec should either ratify it or replace it.

---

## `limits` policy

**Recommendation: per-key last-wins, plus partial `limits` on `extend` layers, plus an override
notice whose level depends on direction.**

### Why not "most restrictive wins"

All five limits are monotone in the same direction — lower is stricter. `proceduralMaxGradeLevel`,
`descriptiveMaxGradeLevel`, `maxNounClusterLength` and `maxSentencesPerProceduralStep` are ceilings
(`sentence-length.ts:28-29`, `candidate-rules.ts:331`, `structure-rules.ts:43`), and
`sentenceReadabilityFloorWords` is a floor below which the check is skipped entirely
(`sentence-length.ts:30`, and `schema.ts:68-73` explains why), so a _lower_ floor means _more_
sentences are checked. So `min()` is well-defined. It is still wrong, for a decisive structural
reason:

`limits` is **required** in `rulePackSchema` (`schema.ts:58-77` — five required numbers, no
defaults). Under `min()`, the bundled pack's values become a permanent ceiling that no organisation
can ever raise, because the bundled pack is always layer 0 unless replaced. `proceduralMaxGradeLevel`
would be pinned at 7 forever. That does not restrain a rogue product layer; it makes the org layer
impotent. The only escape would be `mode: "replace"` — which throws away the 61 unapproved entries
and 35 contractions, i.e. exactly the problem this design exists to solve. "Most restrictive wins"
would push every organisation back onto `replace`.

Second, `min()` and required-`limits` interact badly even in the honest case: a locale layer that
only wants to change `maxNounClusterLength` must declare all five, and any of the other four it
writes "wrong" (looser) is silently discarded. Silent discard of authored configuration is worse
than a visible override.

### What the recommendation costs

1. **A product layer can loosen an org limit, and nothing structurally prevents it.** That is real.
   The mitigations are (a) the override notice, (b) the declaration order requirement — the org layer
   must be listed before the product layer, so the loosening is at least _visible_ in one config
   file, and (c) a future `lockedLimits` / policy mechanism, which I am explicitly **not** speccing:
   "which layer may override which" is an authority question, not a merge question.
2. **The `info`-level override notice is invisible in textlint.** Per `adapter.ts:298-299`, `info`
   notices are dropped. An operator running textlint sees nothing; only `ste-ai` CLI users
   (`cli/main.ts:246-249`) and programmatic callers see it. This is why the notice level is
   direction-dependent rather than uniformly `info`:

```ts
const STRICTER_IS_LOWER = [
  'proceduralMaxGradeLevel',
  'descriptiveMaxGradeLevel',
  'sentenceReadabilityFloorWords',
  'maxNounClusterLength',
  'maxSentencesPerProceduralStep',
] as const;

// level = 'warning' when next > prev (looser), 'info' when next <= prev (stricter or equal)
```

A locale layer that tightens limits every run does not nag. A layer that loosens one produces a
`warning` notice, which the textlint adapter _does_ surface, at document position 0
(`adapter.ts:300-305`). That is the cheapest honest answer to "a product layer can loosen an org
limit": it cannot do it quietly.

3. **`limits.partial()` on layers is a schema divergence** — two pack schemas to keep in step
   (§"Two pack schemas"). Accepted: the alternative is forcing every layer to restate five numbers,
   which reintroduces problem 2 above.

---

## Retraction design

### Requirement

A lower layer must be able to un-ban a term an upper layer banned. Union cannot express removal.

### Decision: a new top-level `retract` field on layer packs, keyed by merge key

```ts
export const retractionSchema = z.object({
  dictionary: z
    .object({
      approved: z.array(z.string()).default([]),
      unapproved: z.array(z.string()).default([]),
      preferred: z.array(z.string()).default([]), // keyed on `from`
    })
    .prefault({}),
  contractions: z.array(z.string()).default([]), // keyed on `from`
  approvedTechnicalTerms: z.array(z.string()).default([]),
  rules: z.array(z.string()).default([]), // keyed on ruleId
});
```

```jsonc
// ./locale-en-gb.json
{
  "metadata": { "id": "acme-locale-en-gb", "…": "…" },
  "retract": {
    "dictionary": { "unapproved": ["whilst"] },
    "contractions": ["don't"],
  },
  "dictionary": { "unapproved": [{ "term": "whilst", "alternatives": ["while"], "note": "…" }] },
}
```

Values are **merge keys**, normalised by the same per-field function as the merge itself
(`vocabKey` / `contractionKey` / `technicalKey` / exact `ruleId`). A retraction that names a key not
present in the accumulator is a no-op and emits `rule-pack-retraction-inert` at `warning` — inert
retractions are almost always a typo or a layer that got reordered, and the failure mode (a ban you
thought you removed is still live) is silent otherwise, which is exactly the "silence means
compliance" failure `docs/diagnostic-policy.md` exists to prevent. `warning`, not `info`,
specifically so the textlint adapter surfaces it.

### Ordering within a layer: retract first, then upsert

A layer's `retract` block applies to the accumulator **before** that layer's own entries are
upserted. Consequences, both wanted:

- `retract` + re-add of the same key is a well-defined "redefine from scratch" idiom (the example
  above): the old entry's `alternatives`, `note` and `safeSubstitution` are gone, not inherited.
  Without the ordering rule, whole-entry replace would already achieve this, but the explicit retract
  documents the intent and makes the `rule-pack-entry-overridden` accounting honest.
- A layer can never erase its own additions.
- Layer application is idempotent: applying the same layer twice in a row yields the same
  accumulator.

### Rejected: sentinel values in the existing arrays

E.g. `{"term": "whilst", "retracted": true}` or `alternatives: null`. Rejected because the composed
value is consumed directly by rules that iterate these arrays with no notion of a non-entry:
`vocabulary.ts:53-61` builds its working list straight from `pack.dictionary.unapproved`,
`:164-172` from `pack.dictionary.preferred`, `:242` from `pack.contractions`. A sentinel is a _layer_
operation smuggled into _pack data_; it would either have to survive into the composed pack (forcing
every consumer to learn to skip it, and `RulePack` in `types.ts:428-440` to gain an optional flag
that is meaningless post-composition) or be stripped, in which case it is a separate concept wearing
an entry's clothes. Keeping it in its own field means **the composed pack contains only live
entries** and `RulePack` is untouched. That is the decisive argument.

### Rejected as the mechanism: reuse `options.allow`

The precedent is real — `unapprovedVocabularyRule` filters pack entries against `options.allow`
(`vocabulary.ts:20,51,61`), and `preferredTerminologyRule` (`:140,163,172`) and `noContractionsRule`
(`:219,241-242`) each have their own. It is the right _escape hatch_ and it stays exactly as it is.
It is the wrong _layer mechanism_, for three verified reasons:

1. **It is per-rule, not per-layer.** Each of the three rules has a separate `allow` array
   (`vocabulary.ts:20`, `:140`, `:219`). Un-banning `don't` requires an `allow` on `no-contractions`;
   un-banning `whilst` requires a different `allow` on `unapproved-vocabulary`. A locale team would
   have to know which rule owns which word list.
2. **It is configuration, not pack data.** `allow` reaches a rule through
   `{...packSpec?.options, ...stripControlKeys(userConfig)}` (`runner.ts:60-63`) — it lives in the
   operator's `.ste-ai.json` or in the pack's own `rules[].options`. A locale layer that ships as a
   pack and wants to retract an _org_ pack's entry would have to write into
   `rules["unapproved-vocabulary"].options.allow`, which — under the shallow `options` merge —
   **replaces** the org layer's `allow` array wholesale. Retraction would clobber allow-listing.
   And `docs/rule-pack-import.md:153-156` explicitly warns against smuggling data through
   `rules[].options`.
3. **It cannot reach three of the seven fields.** There is no `allow` for
   `approvedTechnicalTerms`, for `dictionary.approved`, or for `limits`. A locale layer cannot
   un-protect a technical term through it at all.

The two compose cleanly and in a fixed order: `retract` runs at **composition** time, `allow` runs at
**rule-run** time (`vocabulary.ts:61`), over whatever composition produced. A term retracted by a
layer is simply absent when `allow` is applied; an `allow` naming an already-retracted term is inert
and — note — produces no notice today, and this spec does not add one (that would be a change to
rule behaviour, outside the composition core).

---

## Conflict detection and classification

Detection runs **once, on the composed pack**, after the fold. Running it on the composed value
rather than pairwise between layers means (a) a conflict introduced and then repaired by a later
layer is correctly not reported, and (b) the check also covers single-layer configs — including the
bundled pack and today's `rulePack: X` path.

I verified the bundled `provisionalRulePack` is clean against every check below (script run under
`npx tsx` against `src/rule-pack/provisional-pack.ts`: zero cycles, zero `preferred.to` that is
unapproved, zero unapproved-alternatives that are themselves unapproved, zero technical-term shadows,
zero terms both approved and unapproved). So adding these checks does not break the default path.
An imported pack that is already deployed _could_ newly fail a hard check — that is a migration
question and belongs to the migration spec, but the merge core should flag it as a known blast
radius.

### The detectable field pairs

| #   | code                                       | what is detected                                                                                                                                                                                                      | classification                                  |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| K1  | `rule-pack-rewrite-cycle`                  | a cycle in the directed graph over `vocabKey`, edges `from → to` drawn from `dictionary.preferred` ∪ `contractions` (both are `PreferredTermEntry`, `types.ts:442-447`). Includes the 2-cycle `job→task`, `task→job`. | **hard error** (`RulePackError`)                |
| K2  | `rule-pack-prescribes-banned-term`         | `vocabKey(entry.to) ∈ keys(dictionary.unapproved)` for any `preferred` or `contractions` entry                                                                                                                        | **hard error**                                  |
| K3  | `rule-pack-unsafe-alternative`             | an `unapproved` entry with `safeSubstitution: true` whose `alternatives[0]` is itself an unapproved key                                                                                                               | **hard error**                                  |
| K4  | `rule-pack-advisory-alternative-banned`    | an `unapproved` entry with `safeSubstitution: false` any of whose `alternatives` is an unapproved key                                                                                                                 | run-level notice, `warning`                     |
| K5  | `rule-pack-ban-shadowed-by-protected-term` | a `dictionary.unapproved` key equals `vocabKey(t)` for some `t ∈ approvedTechnicalTerms`                                                                                                                              | run-level notice, `warning`                     |
| K6  | `rule-pack-term-approved-and-unapproved`   | the same `vocabKey` appears in `dictionary.approved` and `dictionary.unapproved`                                                                                                                                      | run-level notice, `info` (see caveat)           |
| K7  | `rule-pack-fix-safety-escalated`           | an upsert changed `safeSubstitution` from `false` to `true` for an existing key                                                                                                                                       | run-level notice, `warning`                     |
| K8  | `rule-pack-limit-overridden`               | a later layer changed a `limits` value                                                                                                                                                                                | notice, `info`/`warning` by direction (§limits) |
| K9  | `rule-pack-entries-overridden`             | aggregate count of keyed upserts that replaced an existing key, across `dictionary.*`, `contractions`, `rules`                                                                                                        | one aggregate notice, `info`                    |
| K10 | `rule-pack-layer-repeated`                 | the same string `source` appears twice in the stack                                                                                                                                                                   | notice, `info`                                  |
| K11 | `rule-pack-retraction-inert`               | a `retract` key not present in the accumulator                                                                                                                                                                        | notice, `warning`                               |
| —   | `rules[].status` raised by a later layer   | recorded in `provenance`, not classified here                                                                                                                                                                         | **[AUTHORITY-SEAM]**                            |

### Why K1–K3 are hard errors

**K1 (cycle).** This is not aesthetics. `preferredTerminologyRule` rewrites every match of `from`
into `to` (`vocabulary.ts:179-198`) and attaches a `TextFix` whenever `safeSubstitution` is set
(`:184-191`). With `job→task` and `task→job` both live, the entries are sorted by `from.length`
descending (`:173`) and the first to claim a range wins (`:180-182`), so the run flags one direction;
applying the fix produces text the _other_ entry flags on the next run. `--fix` never converges. No
run-time policy can make that sane, and there is no defensible "last wins" — the two layers are
asserting incompatible house styles and a human has to choose. The failure must land on whoever
assembled the stack, at load time, with both layer origins named.

**K2 (prescribes a banned term).** The merged pack instructs the author, in a diagnostic message
(`vocabulary.ts:195`: `Use "X" instead of "Y"`), to write a word the same pack bans and will flag on
the next pass. The document cannot be made compliant by following the tool's own advice. Loading is
the right place to refuse.

**K3 (unsafe alternative under `safeSubstitution`).** `safeSubstitution: true` authorises an
automatic source rewrite (`vocabulary.ts:77-84`). If `alternatives[0]` is itself banned, the
autofixer edits the file into a fresh violation. The schema's own comment
(`schema.ts:43-47`) says the flag means substitution "cannot change technical meaning" — a
substitution that introduces a violation has already broken that contract. Note the autofix gates
still run afterwards (`docs/rule-pack-import.md:142-146`), but they check meaning-preservation, not
vocabulary compliance, so they do not catch this.

### Why K4–K7 are notices rather than errors

**K4** differs from K3 only in that `alternatives[1..n]` (and `alternatives[0]` when
`safeSubstitution` is false) are _advice_ — they reach the author as `suggestions`
(`vocabulary.ts:97`) and as message text (`:86-89`), never as an applied edit. Bad advice is a defect
worth reporting; it does not make the pack unusable. `warning`, so textlint shows it.

**K5** is a genuine, legitimate layering idiom: a product layer whose product is literally called
`Abort` adds it to `approvedTechnicalTerms`, and the org's ban on `abort` then does nothing, because
vocabulary matching runs against `sentence.masked` and a protected term is masked out
(`helpers.ts:18-23`, `approvedTermPass` in `protected-regions.ts`). Erroring would forbid the idiom.
But the ban is now dead data, and dead bans are exactly what an audit needs to see. One subtlety the
notice message must carry: technical-term protection is case-**sensitive** (`approvedTermPass`,
flags `gu`) while the ban is case-**insensitive** (`helpers.ts:10`, flags `giu`), so `approvedTechnicalTerms:
["Abort"]` shadows only `Abort`; lowercase `abort` in prose is still flagged. The shadowing is
partial, and the notice should say so rather than claiming the ban is fully dead.

**K6** is `info` and flagged as uncertain: `dictionary.approved` has **no production reader at this
commit** (see Current behaviour), so a term being in both lists has no observable effect today. If
and when the `approved-word-sense` evaluator is wired to `permittedSenses`, this should be
re-classified — plausibly to `warning` or to a hard error, because at that point the pack would be
telling the adjudicator that a banned word has permitted senses. Recording it now, at `info`, keeps
the audit trail without asserting a consequence I cannot demonstrate.

**K7** — a lower layer raising `safeSubstitution` to `true` is a legitimate thing for a team with
narrower domain knowledge to do ("in our product, `abort → stop` really is safe"). It is also the
single highest-consequence thing a layer can do, because it converts a report into a file edit. It
must never be silent. `warning`, so it survives the textlint adapter's `info` filter.

### Why K8–K11 are the low tier

These are the ordinary mechanics of layering. K9 in particular is high-cardinality: a product pack
overriding 200 org entries would emit 200 notices, which is noise, not signal. It follows the
`withRunTotal` precedent (`analysis/analyse.ts:515-518`) — one notice, counts in `detail`:

```ts
{
  code: 'rule-pack-entries-overridden',
  level: 'info',
  message: '3 layers composed; 214 entries overridden by a later layer.',
  detail: { layers: 3, unapproved: 180, preferred: 12, contractions: 0, approved: 2, rules: 20 },
}
```

`RunNotice.detail` is `Record<string, string | number | boolean>` (`types.ts:257`), so counts fit
without a type change.

### Delivery: composition needs a notice channel it does not have

`resolveRulePack` returns a bare `RulePack` (`loader.ts:49-52`) and both callers bind it directly
(`analyse.ts:244`, `evaluate.ts:227`). Notices produced during composition currently have nowhere to
go. Minimal change:

```ts
// src/rule-pack/loader.ts
export function composeRulePacks(
  layers: readonly NormalisedLayer[],
  baseDir = process.cwd(),
): RulePackComposition;

/** Retained. Same signature, same behaviour, notices discarded. */
export function resolveRulePack(
  spec: string | Record<string, unknown> | undefined,
  baseDir = process.cwd(),
): RulePack;
```

`prepareRun` (`analyse.ts:243-277`) calls `composeRulePacks` and threads `composition.notices` into
the notice list it already assembles at `analyse.ts:314` and `:634`. `evaluate.ts:227` can keep using
`resolveRulePack` — the evaluation harness has no notice sink — but it then silently drops merge
notices, which is acceptable for a measurement harness and should be stated in a comment rather than
left implicit.

Hard errors keep using the existing `RulePackError` (`loader.ts:7-12`), with the layer index and
resolved origin in the message, matching the existing style of `loader.ts:21,32,38`.

---

## Order and determinism

### Declaration order, not semantic order

Layers apply strictly left-to-right in declaration order. The conceptual stack
(bundled → organisation → department → product → tech stack → industry → locale) is a _convention
the operator expresses by ordering the array_, not something the code infers.

Reason: nothing in the pack schema names a tier. `rulePackMetadataSchema` (`schema.ts:17-31`) has
`id`, `name`, `version`, `authority`, `licence`, `source`, `retrievedAt`, `conformanceClaim`,
`notice` — none of which identifies a layer's position in an organisational hierarchy. Sorting by
`authority` would conflate "how normative is this" with "how specific is this", which are orthogonal
(a locale layer is the most specific and the least normative). Inferring a tier from `metadata.id`
would be string-guessing. Declaration order is the only ordering the configuration actually carries,
so it is the ordering used.

If a `tier` field is added later (an authority-spec question), it should be _validated against_
declaration order — "your layers are declared out of tier order" — rather than replacing it. Keeping
apply-order and declared-order identical is what makes a config file readable as the thing it does.

### Determinism requirements

1. **The fold is over an array, and every accumulator is order-preserving.** Keyed upserts use a
   `Map` keyed by the normalised merge key. `Map` preserves insertion order, so the emitted array
   order is: order of _first_ insertion per key. An upsert **replaces the value in place and does not
   move the key to the end.** This is required, not incidental — see the `sort`-stability argument in
   the Summary: composed array position decides which of two equal-length terms claims an
   overlapping match (`vocabulary.ts:64,70-72`). Re-ordering on override would change diagnostics
   without changing any pack's content.
2. **Same config + same pack bytes ⇒ byte-identical composed pack.** This mirrors the guarantee the
   rule runner already states for itself: "rules run in registry order and diagnostics are finally
   sorted by (start, end, ruleId). Two runs over the same input therefore produce byte-identical
   output" (`runner.ts:279-282`). Composition must not weaken it, because the pack is an input to
   that run.
3. **Notice order is fixed**, by construction rather than by a sort: layers are visited in order,
   fields within a layer in the fixed order given in the merge table, keys within a field in the
   layer's own declared array order. Aggregate notices (K9) are emitted last, after the fold.
   Conflict-detection notices (K1–K6) are emitted after those, in the table's numeric order, and
   within a code, sorted by merge key with `localeCompare` — matching the tie-break style already
   used for diagnostics (`runner.ts:126-128`, `analyse.ts:307-311`).
4. **No load-graph, therefore no cycle risk.** A pack file cannot reference another pack: the schema
   (`schema.ts:93-104`) has no include/extends field, and this spec does not add one. Every layer is
   loaded independently from its declared `source`. Relative paths resolve as today, against
   `baseDir` (`loader.ts:26-27`), which for the programmatic API is `options.baseDir ?? process.cwd()`
   (`analyse.ts:244`).
5. **No filesystem-order or environment dependence.** Layers are read in declared order; nothing
   globs, nothing scans a directory, nothing consults the environment.
6. **Layer application is idempotent.** Applying the same layer twice consecutively yields the same
   accumulator (retract-then-upsert, whole-entry replace, set union and last-wins are all
   idempotent). This is what makes K10 (`rule-pack-layer-repeated`) a notice rather than an error:
   the duplicate is harmless, just probably a mistake.

---

## Open questions and recommendations

1. **Unicode normalisation of merge keys.** Recommended: none, matching `termPattern`
   (`helpers.ts:5-11`), which does not normalise. This means `café` composed as NFC and `café`
   composed as NFD are two entries — and _also_ two entries as far as the matcher is concerned, so
   the merge is at least consistent with the matcher. Fixing this properly means fixing
   `termPattern` first, which is a rule-behaviour change outside this spec. Flagged, not fixed.
2. **`dictionary.approved` merge semantics are currently unobservable.** No production reader exists
   at this commit (grep over `src/`; `permittedSenses` is declared at `semantic/evaluators.ts:28` and
   constructed only in `test/unit/prompts.test.ts:37`). Whole-entry replace is specified for
   consistency, and K6 is `info` for the same reason. Both should be revisited when the sense
   inventory is wired up.
3. **`limits` loosening has no structural guard.** By recommendation, only a direction-sensitive
   notice. A `lockedLimits` or per-layer permission mechanism is the obvious next step and is an
   authority question, not a merge question — deliberately not specced here.
4. **Deployed single packs could newly fail K1–K3.** The checks run on the composed pack regardless
   of layer count, so a pack that has always contained a rewrite cycle would start throwing. The
   bundled pack is verified clean; third-party packs are not knowable from here. Recommend the
   migration spec decide whether K1–K3 are errors from day one or errors-after-a-deprecation-window.
5. **`rules[].options` array semantics.** Shallow merge means a layer setting `allow: [...]` replaces
   rather than appends. Recommended, because append-vs-replace cannot be expressed in
   `z.record(z.string(), z.unknown())` (`schema.ts:90`) without a per-key policy, and because it
   matches `runner.ts:60-63`. If append is later wanted, it should be an explicit key convention in
   the retraction/merge vocabulary, not a guess made by the merger.
6. **Should K6 and K9 be `info` given `adapter.ts:298-299` drops them?** Recommended yes: they are
   audit-trail entries and are fully available via the CLI (`cli/main.ts:246-249`) and
   `AnalysisResult.notices`. But note this makes textlint a strictly lower-fidelity surface for merge
   diagnostics than the CLI. If that is unacceptable, the fix is a config knob on
   `diagnosticPolicySchema` (`config.ts:6-34`) rather than inflating every notice to `warning`.
7. **`evaluate.ts:227` drops merge notices.** Recommended: leave it, with a comment. Alternative is
   plumbing a notice sink through the evaluation harness for no measurement benefit.

---

## Seams with the authority spec

The merge core hands the authority spec structured data and makes no trust decisions. Four seams:

1. **`RulePackComposition.layers`** (`LayerDescriptor[]`, defined above) — ordered, base first, each
   carrying that layer's verbatim `metadata`, its `mode`, and its resolved `origin`. Today
   `verifiedAuthority` and `packPermitsConformanceClaim` (`loader.ts:76-98`) ask one question of one
   pack: "is `pack.metadata.id` in `trustedRulePackIds`?" With N layers that becomes N questions with
   an aggregation rule. `layers[]` is the input to whatever aggregation the authority spec chooses;
   the core does not choose it.

2. **`pack.metadata` of the composed pack** — the core's defaults (`id` = `composed:a+b+c`,
   last-layer for the descriptive fields, weakest-authority, `conformanceClaim: 'none'` if any layer
   says `none`) are placeholders chosen so that composition can never _gain_ authority. The
   `composed:` id prefix specifically guarantees a composed pack's id cannot accidentally match a
   `trustedRulePackIds` entry. `licence` in particular has no correct single value when layers differ
   and needs an authority answer.

3. **`rules[].status` and `sourceRef` across layers.** Field-by-field merge means a later layer can
   raise `status` from `provisional` to `normative` while inheriting an earlier layer's `sourceRef`,
   or replace the `sourceRef` while inheriting the status. `runner.ts:93-113` uses both — `status`
   through `verifiedRuleStatus` (`runner.ts:99`) and `sourceRef` verbatim on the diagnostic
   (`runner.ts:110`). The merge core records every such change in `provenance` and classifies none of
   them. Whether a layer may raise `status` at all, and whether raising it while inheriting someone
   else's `sourceRef` is legitimate, is the authority spec's call.

4. **`EntryProvenance` — the free hook.** The keyed-upsert fold already knows, at the moment of every
   write, which layer index wrote it. Capturing it costs nothing:

   ```ts
   export type PackField =
     | 'limits'
     | 'dictionary.approved'
     | 'dictionary.unapproved'
     | 'dictionary.preferred'
     | 'contractions'
     | 'approvedTechnicalTerms'
     | 'rules';

   /** field → merge key → ordered layer indices that wrote it (last is the winner). */
   export type EntryProvenance = ReadonlyMap<PackField, ReadonlyMap<string, readonly number[]>>;
   ```

   The core populates this and uses it only for the notices in the conflict table. **What a
   diagnostic reports about an entry's source is entirely the authority spec's design** — this spec
   asserts only that the data is available and that the winning layer is `at(-1)`.

A fifth, smaller seam: **retraction and trust interact.** An untrusted low layer can retract a
trusted org layer's ban, and the merge core will let it, because the core has no concept of trust.
Whether `retract` should be constrained by layer authority is an authority question. The core-side
hook is that every retraction is already recorded in `provenance` and in the
`rule-pack-retraction-inert` accounting, so the authority spec can gate retractions without changing
the fold.
