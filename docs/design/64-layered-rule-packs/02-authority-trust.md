# Layered rule packs: the trust model

> **Read [`00-decisions.md`](./00-decisions.md) first.** This spec is one of three produced
> independently, and the decision record overturns part of it: conformance claims are out of scope
> for this project stage, which removes the destination `stackPermitsConformanceClaim` was built to
> guard, and `replace` mode — which several sections here depend on — is dropped. Nothing below has
> been rewritten to match, on purpose — the specs are the reasoning, `00` is the conclusion.

Spec owner: authority, trust, and provenance. The merge algorithm, per-field merge keys, retraction
syntax, conflict detection and the config zod shape are **out of scope** and are referenced here as
given. Where this spec depends on a decision the merge-algorithm spec owns, it is flagged as a
dependency, not designed.

All line citations are against commit `9d78a8b`.

---

## Summary

Layering breaks the current trust model because that model attaches authority to _the run_ via a
single `RulePack`, and every consumer reads it that way. Under composition the merged artefact holds
data of mixed provenance, so "the authority of the run" stops being a well-formed question.

The design in this spec:

1. **Authority becomes a property of an entry, not of a run.** Every entry in the composed pack
   carries a required, undefaulted `EntryProvenance` record naming the layer that put it there, that
   layer's declared authority, and the authority the operator's trust list actually permits it.
2. **Provenance is compositor-written and supplier-unwritable.** It lives on a new
   `ComposedRulePack` type. The on-disk `rulePackSchema` is unchanged, so no supplier can assert a
   provenance for itself.
3. **`verifiedAuthority` moves down a level** — it becomes a per-layer function evaluated once
   during composition, and its per-run export is removed because there is no per-run authority.
4. **`packPermitsConformanceClaim` splits in two.** Per-entry: an entry from a trusted normative
   layer permits a claim regardless of what other layers did. Run-level: the composed stack permits
   a claim only under **unanimity** across every contributing layer.
5. **Override direction is fixed: the overriding layer owns the resulting entry's provenance,
   always.** No inheritance from below, in either direction. Where the merge algorithm merges fields
   from several layers into one entry, the composite entry takes the **weakest** verified authority
   of any contributing layer.
6. **Retraction and protection are the dangerous operations,** because they act on silence rather
   than on output, and silence carries no diagnostic to attach provenance to. Both get explicit
   policy gates and run notices.

The asymmetry that drives the whole design:

> **A positive finding is attributable to one entry; silence is a property of the whole stack.**

That is why per-entry authority is sound for diagnostics, and why the run-level conformance claim
still needs unanimity.

---

## The current trust boundary (quoted, with citations)

### The principle, as stated in the code

`src/rule-pack/loader.ts:58-83`:

> ```
>  * True when output is allowed to describe findings as conformance with a standard.
>  *
>  * Three conditions, all required:
>  *
>  * 1. the pack declares `normative` authority;
>  * 2. it declares a conformance claim other than `none`;
>  * 3. **the operator has named the pack in `trustedRulePackIds`.**
>  *
>  * The third is the trust boundary. Schema validation proves a pack's shape, not its provenance:
>  * any JSON file can assert `authority: "normative"`, so a pack cannot elevate itself. Authority is
>  * supplier-*declared* metadata until an operator makes an explicit, auditable decision to accept
>  * it. The bundled pack fails condition 1 regardless.
>  *
>  * There is no signature verification here. If you need cryptographic provenance rather than an
>  * operator allowlist, verify the pack before handing it to this package and keep the allowlist as
>  * the final gate.
> ```

`src/rule-pack/loader.ts:85-98`:

> ```
>  * The authority the linter will act on, as distinct from the authority the pack claims.
>  *
>  * An untrusted pack's diagnostics report `supplementary` — its rule data is used, but its claim to
>  * normative standing is not honoured. The pack's own assertion stays visible in
>  * `metadata.authority` for the audit trail.
> ```

The same principle is restated in config: `src/core/config.ts:126-132`:

> ```
>    * Packs the operator has decided to trust, by `metadata.id`.
>    *
>    * Schema validation proves a pack's *shape*, never its *authority*. Any JSON file can declare
>    * `authority: "normative"`, so an imported pack is untrusted by default and its self-declared
>    * authority is reported as supplier-declared metadata only. A pack must be named here before the
>    * linter treats its authority as application-verified.
> ```

### Where it is enforced today

| Site                            | Code                                                 | What it caps                                                                    |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| `src/rule-pack/loader.ts:80-82` | `packPermitsConformanceClaim`                        | whether output may use conformance wording                                      |
| `src/rule-pack/loader.ts:96-97` | `verifiedAuthority`                                  | run-level authority scalar                                                      |
| `src/core/runner.ts:139-146`    | `verifiedRuleStatus` (private)                       | the `ruleStatus` on a pack-supplied rule's diagnostics                          |
| `src/analysis/analyse.ts:292`   | `verifiedAuthority(pack, config.trustedRulePackIds)` | `ruleStatus` on `review-required` diagnostics                                   |
| `src/analysis/analyse.ts:607`   | `verifiedAuthority(pack, config.trustedRulePackIds)` | `ruleStatus` on every semantic diagnostic                                       |
| `src/cli/main.ts:190-196`       | both loader functions                                | `packAuthority`, `declaredAuthority`, `conformanceClaim` per file in CLI output |

All four enforcement points take a single `RulePack`. `resolveRulePack` returns exactly one
(`src/rule-pack/loader.ts:49-56`), and `prepareRun` binds it once for the run
(`src/analysis/analyse.ts:244`), passing it into every rule as `RuleInput.pack`
(`src/core/runner.ts:81-89`).

### Structural facts that matter for what follows

- `RulePack.metadata` is one record with one `id`, one `authority`, one `conformanceClaim`
  (`src/core/types.ts:412-426`). Trust is matched on `metadata.id` by plain string inclusion
  (`loader.ts:82`, `loader.ts:97`, `runner.ts:145`). Nothing binds an `id` to a file path, a
  version, or a signature. `id`, `name` and `version` are all `z.string().min(1)`
  (`src/rule-pack/schema.ts:18-20`).
- Dictionary entries are bare data objects with no origin field at all
  (`src/core/types.ts:428-455`, `src/rule-pack/schema.ts:33-56`).
- `approvedTechnicalTerms` is `readonly string[]` (`src/core/types.ts:484`) — a bare string array,
  structurally incapable of carrying provenance. It is spread together with operator-config terms
  into one undifferentiated protection list at `src/analysis/analyse.ts:255` and
  `src/evaluation/evaluate.ts:244`.
- `RulePackLimits` is five scalars (`src/core/types.ts:457-463`) consumed directly by rules with no
  authority tracking: `src/deterministic/rules/sentence-length.ts:28-30`,
  `src/deterministic/rules/structure-rules.ts:43`,
  `src/deterministic/rules/candidate-rules.ts:331`.
- `rulePackRuleSpecSchema` already carries a per-rule `sourceRef` (`src/rule-pack/schema.ts:79-91`).
  This is the existing precedent for per-record attribution, and the model this spec extends.
- `Diagnostic.meta` is `Readonly<Record<string, string | number | boolean>>`
  (`src/core/types.ts:249`) — flat scalars only, so a structured provenance record cannot be smuggled
  through it.
- `rulePackSchema` uses plain `z.object` (`src/rule-pack/schema.ts:93-104`) with zod `^4.4.3`
  (`package.json:110`). Verified by execution: `z.object({a: z.string()}).parse({a:'x',
provenance:{...}})` yields `{"a":"x"}` — unknown keys are **stripped**, silently.

### Existing weaknesses this spec inherits (not introduced by layering)

These are real today, with a single pack, and layering multiplies each of them. Flagged here because
they are inside the trust boundary I own.

1. **An untrusted pack's `sourceRef` is written to diagnostics verbatim.** `src/core/runner.ts:96-112`
   caps `status` through `verifiedRuleStatus` but assigns
   `meta: { ...processed.meta, sourceRef: packSpec?.sourceRef ?? '' }` (line 110) **unconditionally**
   whenever `packSpec !== undefined`. An untrusted pack can therefore put the string
   `"ASD-STE100 Issue 8, Writing Rule 3.1"` onto a diagnostic that reports `supplementary`. The
   authority scalar is capped; the citation is not.
2. **Documentation understates the trust condition.** `docs/rule-pack-import.md:51` says
   "`packPermitsConformanceClaim()` returns true only for 'normative' + not 'none'." and the table at
   `docs/rule-pack-import.md:135` gives `true` if `conformanceClaim !== 'none'`. Both omit condition
   3 — the `trustedRulePackIds` requirement — i.e. the documented function is _more permissive than
   the implemented one_. Safe in practice (the code is stricter than the doc), wrong as a contract.
3. **No test covers the trust boundary.** `grep -rln "authority\|conformance\|rulePack" test/`
   returns nothing across all 27 files under `test/`. `verifiedAuthority`,
   `packPermitsConformanceClaim` and `verifiedRuleStatus` are unexercised. (Testing is out of scope
   for this spec; recording the gap is not.)
4. **Config already overrides pack limits with no record.** `options.maxSentencesPerStep ??
pack.limits.maxSentencesPerProceduralStep` (`structure-rules.ts:43`) and the equivalents in
   `sentence-length.ts:28-30` and `candidate-rules.ts:331` let operator config silently displace a
   normative limit. Local today; a supply-chain issue once layers can do the same.

---

## What layering breaks

`resolveRulePack` returning one pack (`loader.ts:49-56`) is load-bearing for four distinct
assumptions, each of which fails independently:

**1. "The pack" is a well-defined referent.** `verifiedAuthority(pack, …)` asks a question about a
singular object. With seven layers there is no single `metadata.authority` and no single
`metadata.id` to match against `trustedRulePackIds`. Every one of the six enforcement sites above
would have to be handed _something_, and any scalar chosen is a summary that is false for some
entries.

**2. Trusting one layer would launder the rest.** If the compositor produced a merged `RulePack` with
one synthesised `metadata` block, the natural implementation picks the top layer's or the most
authoritative layer's metadata — and `verifiedAuthority` then reports one answer for every entry in
the merged dictionary. A single trusted normative layer would elevate every other layer's entries to
`normative` on output. That is the privilege-escalation bug the brief names, and it is the _default_
outcome of naive composition, not an edge case.

**3. Silence becomes composable, and nothing tracks it.** Today the only way an entry stops firing is
operator config (`options.allow`, `vocabulary.ts:51,61,172`) or a protected literal. Under layering,
a higher layer can retract a lower layer's entry, or add a protected literal that neutralises it. A
retracted entry produces no diagnostic and therefore has nowhere to hang provenance. The reader sees
a clean run and cannot distinguish "the normative check passed" from "an unauthorised layer removed
the normative check".

**4. Limits and protection lists have no per-entry granularity at all.** `RulePackLimits` is five
scalars; `approvedTechnicalTerms` is `string[]`. Both are consumed pre-merge-agnostically
(`analyse.ts:255`, `sentence-length.ts:28-30`). Neither can express "this value came from layer 4"
without a type change. A limit is the highest-leverage laundering target in the system: raising
`proceduralMaxGradeLevel` from 7 to 20 disables a rule that will still report `normative` status,
because status comes from `rules[].status` (`runner.ts:96-99`) and the limit comes from somewhere
else entirely.

---

## Per-entry authority design

### The record

New type, in `src/core/types.ts`, beside `RulePack`:

```ts
/** Position in the layer stack. Fixed order, lowest precedence first. */
export type PackLayer =
  'bundled' | 'organisation' | 'department' | 'product' | 'tech-stack' | 'industry' | 'locale';

/** Where a contribution came from, when it did not come from a rule pack layer. */
export type ContributionOrigin = 'pack' | 'operator-config' | 'builtin';

/**
 * Why an entry in the composed pack is in the composed pack, and what authority it may claim.
 *
 * Written **only** by the compositor. No supplier can assert this: it does not exist in
 * `rulePackSchema`, and it lives on `ComposedRulePack`, a type no parse path produces.
 *
 * Required and deliberately not defaulted, on the same principle as `reviewerKind` in
 * `src/fixture-tools/annotation-schema.ts` (which arrives with #59, not in this tree): an optional
 * origin makes "nothing produced this" indistinguishable from "we forgot to record what produced
 * this".
 */
export interface EntryProvenance {
  readonly origin: ContributionOrigin;
  /** `metadata.id` of the contributing layer. Absent only when `origin !== 'pack'`. */
  readonly packId: string;
  /** `metadata.version` of the contributing layer, verbatim. */
  readonly packVersion: string;
  readonly layer: PackLayer | 'operator-config' | 'builtin';
  /** Precedence index in the resolved stack. Lower = lower layer. */
  readonly layerIndex: number;
  /** What that layer asserted about itself. Supplier-declared metadata, never acted on directly. */
  readonly declaredAuthority: RuleStatus;
  /** What the operator's trust list permits this layer to claim. Never stronger than declared. */
  readonly verifiedAuthority: RuleStatus;
  /** Whether the operator named this layer in `trustedRulePackIds`. */
  readonly trusted: boolean;
  /** What the layer's supplier claims, for the audit trail only. */
  readonly conformanceClaim: RulePackMetadata['conformanceClaim'];
  /** The layer's citation for this entry, when it supplied one. Attributed, never asserted. */
  readonly sourceRef?: string;
  /**
   * Entries this one displaced, top-down. Present when a higher layer overrode or merged over a
   * lower layer's entry. Empty array means "this entry displaced nothing", which is a different
   * fact from "we did not check".
   */
  readonly displaces: readonly DisplacedEntry[];
}

export interface DisplacedEntry {
  readonly packId: string;
  readonly packVersion: string;
  readonly layer: PackLayer | 'operator-config' | 'builtin';
  readonly verifiedAuthority: RuleStatus;
  /** `override` = whole entry replaced. `field-merge` = some fields survived from below. */
  readonly kind: 'override' | 'field-merge' | 'retraction';
}
```

### Where it attaches

A new composed type, distinct from `RulePack`. `RulePack` stays exactly as it is — it describes one
parsed layer, and the import boundary contract in `docs/rule-pack-import.md` stays true of a layer.

```ts
/** One entry of type `T`, plus the compositor's record of how it got here. */
export type Provenanced<T> = T & { readonly provenance: EntryProvenance };

export interface ComposedRulePack {
  /** Every layer that was resolved, in precedence order. Replaces the singular `metadata`. */
  readonly layers: readonly ResolvedLayer[];

  readonly limits: {
    readonly [K in keyof RulePackLimits]: Provenanced<{ readonly value: RulePackLimits[K] }>;
  };

  readonly dictionary: {
    readonly approved: readonly Provenanced<ApprovedTermEntry>[];
    readonly unapproved: readonly Provenanced<UnapprovedTermEntry>[];
    readonly preferred: readonly Provenanced<PreferredTermEntry>[];
  };
  readonly contractions: readonly Provenanced<PreferredTermEntry>[];

  /** Was `readonly string[]`. See "breaking changes" below — a string cannot carry provenance. */
  readonly approvedTechnicalTerms: readonly Provenanced<{ readonly term: string }>[];

  readonly rules: readonly Provenanced<RulePackRuleSpec>[];

  /** Retractions that were applied, and by whom. Silence needs a record too. */
  readonly retractions: readonly AppliedRetraction[];
}

export interface ResolvedLayer {
  readonly layer: PackLayer;
  readonly layerIndex: number;
  readonly metadata: RulePackMetadata;
  readonly verifiedAuthority: RuleStatus;
  readonly trusted: boolean;
  /** Contributed at least one surviving entry, override, or retraction. See unanimity, below. */
  readonly contributing: boolean;
}
```

`RuleInput.pack` (`src/core/rule.ts`, supplied at `src/core/runner.ts:84`) changes from `RulePack` to
`ComposedRulePack`. Rules read `entry.provenance` where they already read `entry.term`,
`entry.alternatives` etc. and pass it through to `buildDiagnostic`.

The single-layer case is not special-cased: with no layers configured, the compositor produces a
`ComposedRulePack` of exactly one layer (`bundled`), every entry provenanced to
`ste-ai-provisional@0.1.0` with `declaredAuthority: 'provisional'`, `trusted: false`,
`verifiedAuthority: 'provisional'` (from `src/rule-pack/provisional-pack.ts:24-33`). One code path,
no "layered mode" flag.

### Attachment rules at merge time

The merge algorithm is another agent's. These are the constraints it must satisfy; they are about
authority only, not about _which_ entry wins.

- **A1.** Every entry in `ComposedRulePack` has exactly one `provenance`. It is not optional and has
  no default. A compositor that cannot name an entry's origin must fail, not guess.
- **A2.** `provenance` is written by the compositor and by nothing else. No parse path can produce
  it: it is absent from `rulePackSchema`, and zod v4 strips unknown keys (verified above), so a pack
  that ships a `provenance` key has it discarded at `parseRulePack` (`loader.ts:15-24`). **Harden
  this**: switch the entry schemas in `src/rule-pack/schema.ts` to `z.strictObject` so a pack that
  attempts it fails loudly rather than being quietly cleaned. Silent stripping is the right
  behaviour for correctness and the wrong behaviour for an audit trail.
- **A3.** `verifiedAuthority` on a provenance record is computed once, per layer, at composition,
  from that layer's own `metadata` and the operator's trust list. It is never recomputed downstream
  and never derived from a neighbouring layer.
- **A4.** Whole-entry override: the surviving entry's provenance is the **overriding layer's**,
  entire, with the displaced entry recorded in `displaces` with `kind: 'override'`. Nothing is
  inherited from below.
- **A5.** Field-level merge (if the merge algorithm does any): the composite entry's
  `verifiedAuthority` is the **weakest** across every layer that contributed any surviving field,
  under the lattice `normative > supplementary > provisional` — which is a proposal, not an existing
  fact: `ruleStatusSchema` (`schema.ts:14`) is a bare `z.enum` and declares no ordering. `01:435`
  carries the same caveat. `packId`/`packVersion`/`layer` name
  the top contributing layer; every other contributor appears in `displaces` with
  `kind: 'field-merge'`.
- **A6.** Operator-config contributions (`rules.*.additional` at `vocabulary.ts:55-60` and
  `vocabulary.ts:166-171`; `config.approvedTerms` at `analyse.ts:255`) get a synthetic provenance:
  `origin: 'operator-config'`, `declaredAuthority: 'supplementary'`, `verifiedAuthority:
'supplementary'`, `trusted: true`. Trusted because the operator wrote it; never `normative`
  because config is not a licensed rule pack and is not covered by `trustedRulePackIds`. This closes
  the hole where config-supplied entries would be the one class with no provenance.
- **A7.** Retractions are recorded in `ComposedRulePack.retractions` with the retracting layer's
  provenance and the retracted entry's provenance. A retraction is a contribution: a layer that
  contributes nothing but retractions is `contributing: true`.

### Breaking changes this implies

Stated plainly rather than buried:

- `approvedTechnicalTerms: readonly string[]` → `readonly Provenanced<{term: string}>[]`. Public via
  the `./rule-pack` and `./core` exports (`package.json:20-27`). Unavoidable: a `string` cannot carry
  provenance, and this list is the single highest-value laundering target (see attack 3).
- `RuleInput.pack` type change — affects every rule and any third-party rule.
- `Diagnostic` gains a required field (below).
- `verifiedAuthority` and `packPermitsConformanceClaim` are exported from `src/rule-pack/index.ts`
  (`export * from './loader.js'`). Their replacement is an API break.

---

## Changes to `verifiedAuthority` and `packPermitsConformanceClaim`

### `verifiedAuthority`

The existing body is correct; only its scope is wrong. It becomes a **per-layer** function, applied
once for each layer during composition, and its run-level export is **removed**.

```ts
/**
 * The authority a single layer will be acted on with, as distinct from the authority it claims.
 *
 * Unchanged in substance from the pre-layering `verifiedAuthority`
 * (`src/rule-pack/loader.ts:92-98`). What changed is when it runs: once per layer at composition,
 * not once per run. There is no per-run authority any more, because a composed stack does not have
 * one — asking for it is the question that laundered every other layer's entries.
 */
export function verifiedLayerAuthority(
  metadata: RulePackMetadata,
  trustedRulePackIds: readonly string[] = [],
): RuleStatus {
  if (metadata.authority !== 'normative') return metadata.authority;
  return isTrustedLayer(metadata, trustedRulePackIds) ? 'normative' : 'supplementary';
}

/** Read the already-verified authority off an entry. Total, cheap, and the only downstream form. */
export function entryAuthority(provenance: EntryProvenance): RuleStatus {
  return provenance.verifiedAuthority;
}
```

`src/core/runner.ts:139-146` (`verifiedRuleStatus`) is deleted: a composed `rules[]` entry already
carries `provenance.verifiedAuthority`, computed at composition. The unconditional `sourceRef`
assignment at `runner.ts:110` is replaced by the attributed form (see attack 5).

The two `analyse.ts` call sites (`:292`, `:607`) currently pass a run-level scalar into
`undecidedCandidateDiagnostics` and `analyseSemantically`. Both are handled per-candidate instead —
see "Semantic and review-required diagnostics" below.

**Optional convenience only**, and explicitly not a trust primitive:

```ts
/**
 * The weakest verified authority among contributing layers. A conservative one-line summary for
 * human-facing output. NEVER the input to a trust decision: it is a summary, and summarising is
 * exactly what this design removed. Use `entryAuthority` for anything load-bearing.
 */
export function effectiveStackAuthority(composed: ComposedRulePack): RuleStatus;
```

### `packPermitsConformanceClaim`

Splits into two functions with genuinely different semantics.

```ts
/**
 * True when a finding produced by this entry may be described as non-conformance with a standard.
 *
 * The same three conditions as before, evaluated against the entry's own layer:
 * 1. the layer declares `normative` authority;
 * 2. it declares a conformance claim other than `none`;
 * 3. the operator has named the layer in `trustedRulePackIds`.
 *
 * A positive finding is attributable to one entry, so a trusted normative layer's finding keeps its
 * standing even in a stack containing untrusted layers. The finding says "entry E from pack P fired
 * on this span", and that statement is unaffected by what layer 6 declares about a different word.
 */
export function entryPermitsConformanceClaim(p: EntryProvenance): boolean {
  return p.trusted && p.declaredAuthority === 'normative' && p.conformanceClaim !== 'none';
}

/**
 * True when the RUN as a whole may be described as a conformance check.
 *
 * Requires **unanimity**: every contributing layer must independently satisfy all three conditions.
 *
 * The asymmetry with `entryPermitsConformanceClaim` is deliberate and is the crux of this design. A
 * run-level claim is a statement about SILENCE — "this document was checked against the standard and
 * nothing fired". Silence is a property of the whole stack, not of any entry: an untrusted layer can
 * retract a normative entry, protect a literal, or raise a limit, and the check that would have
 * fired never runs. There is no diagnostic to attribute, and no way to detect the absence without
 * counterfactual evaluation. So one untrusted or non-normative contributing layer disqualifies the
 * run-level claim entirely, while leaving every trusted layer's individual findings intact.
 */
export function stackPermitsConformanceClaim(composed: ComposedRulePack): boolean {
  const contributing = composed.layers.filter((l) => l.contributing);
  return (
    contributing.length > 0 &&
    contributing.every(
      (l) =>
        l.trusted && l.metadata.authority === 'normative' && l.metadata.conformanceClaim !== 'none',
    )
  );
}
```

**"Contributing" is defined to include retractions and overrides**, not only surviving entries. A
layer whose entire contribution is `retract: ["utilise"]` contributes nothing that survives as an
entry but changes what the run is silent about — the exact case unanimity exists to catch. Defining
"contributing" as "has a surviving entry" would let a pure-retraction untrusted layer escape the
check completely. (This is a hole in the obvious definition; it is closed here deliberately.)

**Consequence the merge-algorithm spec must accommodate:** the bundled provisional layer declares
`authority: 'provisional'` and `conformanceClaim: 'none'`
(`src/rule-pack/provisional-pack.ts:27,31`). Under unanimity, if the bundled layer contributes
anything at all, no run-level conformance claim is ever reachable. An operator holding a licensed
pack must therefore be able to **fully replace** the bundled layer, not merely extend it. This is a
dependency on the merge spec's `replace` mode, flagged, not designed here. If `replace` cannot
evacuate the bundled layer entirely, `stackPermitsConformanceClaim` is permanently `false` and
should be documented as such rather than weakened.

### Answering the three options in the brief, explicitly

- _All layers trusted and normative?_ — Yes, for the **run-level** claim. That is
  `stackPermitsConformanceClaim`.
- _Any layer untrusted poisons the whole run?_ — Yes, for the **run-level** claim, and for nothing
  else. It does not poison individual findings.
- _Per-entry, so a diagnostic from a trusted layer may claim conformance while one from an untrusted
  layer may not?_ — Yes, for **diagnostics**. That is `entryPermitsConformanceClaim`.

The three are not alternatives; they answer two different questions that the current single-pack API
conflates because with one pack they coincide.

---

## `trustedRulePackIds` semantics

### Per-layer, evaluated at composition

The operator trusts **each layer individually**. `trustedRulePackIds` keeps its meaning — an
allowlist of pack ids the operator has decided to accept — and its matching predicate is evaluated
once per layer against that layer's `metadata.id`, rather than once per run.

A layer not named is untrusted. Untrusted is the default, unchanged
(`src/core/config.ts:133`, `.default([])`).

### Override direction — the precise rule

> **When a higher layer overrides a lower layer's entry, the resulting entry's authority and
> provenance are the OVERRIDING layer's, entirely. Nothing is inherited from below, in either
> direction.**

Worked, in both directions:

| Below                                                                                                           | Above                                                          | Result                                                                                                     | Why                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| trusted normative `@acme/std` bans "utilise"                                                                    | untrusted `@team/vocab` overrides the entry (new alternatives) | entry reports **supplementary**, provenance `@team/vocab`, `displaces: [{@acme/std, normative, override}]` | the surviving entry is the untrusted layer's work; inheriting `normative` from below is the privilege escalation                                                                           |
| untrusted `@team/vocab` bans "utilise"                                                                          | trusted normative `@acme/std` overrides it                     | entry reports **normative**, provenance `@acme/std`                                                        | the surviving entry is entirely the trusted layer's; an override is not contaminated by what it replaced                                                                                   |
| trusted normative supplies `{term, alternatives}`; untrusted supplies `{safeSubstitution: true}` merged onto it | —                                                              | entry reports **supplementary** (A5, weakest wins), both layers in `displaces`                             | a composite entry is only as trustworthy as its weakest contributor — and `safeSubstitution` gates autofix (`vocabulary.ts:77-84`), so this is precisely where weakest-wins earns its keep |

**A downgrade must be visible, not merely correct.** An untrusted layer overriding a normative entry
produces a correct `supplementary` — and a reader scanning a mostly-normative run will not notice one
downgraded line. So the compositor emits a run notice:

```
code:    'authority-downgraded-by-layer'
level:   'warning'
message: '3 entr(ies) from a normative layer were overridden by a layer of lower verified
          authority. Findings for those entries report the overriding layer's authority.'
detail:  { entries: 3, byPackId: '@team/vocab', displacedPackId: '@acme/std' }
```

`RunNotice.detail` is `Readonly<Record<string, string | number | boolean>>`
(`src/core/types.ts:257`), so the detail must be flat scalars — one notice per (overriding layer,
displaced layer) pair rather than one carrying a nested list.

### Retraction: the case with no diagnostic to attach to

A higher layer removing a lower layer's entry is the one operation that produces _nothing_. It is
therefore gated by policy, not merely recorded:

- **Default policy: a layer may not retract an entry whose verified authority is stronger than its
  own.** The retraction is refused, the entry survives, and a notice is emitted:
  `retraction-refused-weaker-layer` (`level: 'error'`).
- Opt-in config key `allowWeakerLayerRetraction: boolean`, default `false`. When enabled, the
  retraction applies and the notice becomes `retraction-of-stronger-entry` (`level: 'warning'`),
  still recorded in `ComposedRulePack.retractions`.
- A retraction of an equal-or-weaker entry applies normally, recorded, notice at `level: 'info'`.

Retraction _syntax_ is the merge spec's; whether a given retraction is _permitted_ is this spec's.

### Recommended hardening (owner decision required)

Both are recommendations, not settled design. I flag rather than decide because they change the
config contract, which another agent owns.

1. **Version pinning.** Today trust is `trustedRulePackIds.includes(pack.metadata.id)` — a plain
   string match on a free-text field (`schema.ts:18`, `loader.ts:82`). A supplier can ship v3.0 with
   entirely different content under a trusted id and inherit trust with no operator action. With one
   pack the operator points at one file and the exposure is bounded; with seven independently-owned
   layers it is a supply-chain hole. Recommend accepting `"@acme/std@2.1.0"` alongside bare
   `"@acme/std"` (bare = any version), and documenting the bare form as the weaker choice.
2. **Duplicate-id rejection.** Two layers in one stack declaring the same `metadata.id` make trust
   ambiguous and enable id squatting (attack 6). Recommend the compositor throws `RulePackError` on
   a duplicate id within a stack. Cheap, and it closes the squat completely.

---

## Per-entry provenance and diagnostic output

### The diagnostic field

`Diagnostic` gains a **required** field:

```ts
export interface Diagnostic {
  // …existing fields…
  readonly ruleStatus: RuleStatus;
  /**
   * What put the rule data behind this finding into the run.
   *
   * Required and not defaulted, on the `reviewerKind` principle
   * (`src/fixture-tools/annotation-schema.ts`, arriving with #59): "record what produced a record, on the
   * record". An optional field makes "this finding has no pack origin" and "we forgot to set it"
   * the same value, and the second is the one that laundered authority.
   *
   * `ruleStatus` and `provenance.verifiedAuthority` must agree; the invariant is asserted at
   * construction.
   */
  readonly provenance: EntryProvenance;
}
```

Every diagnostic has one. `origin` is the discriminator that makes "no pack entry" a _stated value_
rather than an absence:

| Producer                                             | `origin`          | provenance is                                                     |
| ---------------------------------------------------- | ----------------- | ----------------------------------------------------------------- |
| a dictionary entry (`vocabulary.ts:91-105`)          | `pack`            | the entry's own                                                   |
| operator-config `additional` (`vocabulary.ts:55-60`) | `operator-config` | synthetic, per A6                                                 |
| a limit-consuming rule (`sentence-length.ts:28-30`)  | `pack`            | the **weakest** of the rule spec's and the limit's — see attack 4 |
| a hard-coded heuristic with no pack input            | `builtin`         | synthetic `builtin` layer, `verifiedAuthority: 'provisional'`     |
| `review-required` (`analyse.ts:543-555`)             | inherited         | the originating candidate's entry provenance                      |
| semantic (`analyse.ts:607`)                          | inherited         | the originating candidate's entry provenance                      |

`buildDiagnostic` (`src/core/rule.ts:205-224`) gains a required `provenance` parameter (or a required
`draft.provenance`), so a rule that omits it fails to compile. Compile-time enforcement is the point:
the field is required so it cannot be silently absent, and required-at-the-constructor is where that
is actually enforced.

### Semantic and review-required diagnostics

Both currently take a **run-level** authority scalar: `analyse.ts:292` and `analyse.ts:607` both pass
`verifiedAuthority(pack, config.trustedRulePackIds)`. Under layering both become per-candidate.

`CandidatePassage` (raised by rules at e.g. `vocabulary.ts:108-124`) gains
`readonly provenance: EntryProvenance`, copied from the entry that raised it. Then:

- `undecidedCandidateDiagnostics` (`analyse.ts:535-556`) sets `ruleStatus:
candidate.provenance.verifiedAuthority` and `provenance: candidate.provenance` per candidate,
  dropping its `ruleStatus` parameter.
- `analyseSemantically` (`analyse.ts:598-609`) likewise drops its `ruleStatus` argument and reads it
  off each candidate.

This is strictly more correct than today even before layering: a semantic verdict on a passage raised
by a provisional heuristic currently reports the _pack's_ run-level authority, not the heuristic's.

### Human-readable output

`formatMessage` (`src/textlint/adapter.ts:190-193`) is currently:

```ts
const status = diagnostic.ruleStatus === 'normative' ? 'normative' : diagnostic.ruleStatus;
return `[${diagnostic.category}][${status}] ${diagnostic.message}`;
```

Proposed:

```ts
`[${category}][${status}] ${message}${attribution}`;
```

where `attribution` is `` ` (flagged by ${packId}@${packVersion})` `` **only when the composed stack
has more than one contributing layer**, and empty otherwise.

Two reasons for the conditional. First, a single-layer run's output stays byte-identical to today, so
layering costs nothing to existing users and does not churn
`test/integration/cli-output.test.ts` / `test/e2e/textlint-tester.test.ts`. Second, in a one-layer run
the attribution carries no information: there is only one candidate.

**Render `packId@packVersion`, never `metadata.name`.** `name` is free text
(`src/rule-pack/schema.ts:19`) and a pack could set it to
`"ASD STEMG — certified conformant"`. See attack 9 — this is my own design's new attack surface.

CLI text mode (`src/cli/main.ts:236-245`) gets the same attribution appended to the message line.

### JSON output

`src/cli/main.ts:145-155` builds per-file result entries with three scalars, populated at
`main.ts:190-196`:

```ts
packAuthority: verifiedAuthority(analysis.pack, analysis.config.trustedRulePackIds),
declaredAuthority: analysis.pack.metadata.authority,
conformanceClaim: packPermitsConformanceClaim(…) ? analysis.pack.metadata.conformanceClaim : 'none',
```

All three are single-pack scalars and all three become false under layering. Replaced by:

```jsonc
{
  "file": "…",
  "diagnostics": [
    {
      "…": "…",
      "provenance": {
        "packId": "…",
        "packVersion": "…",
        "layer": "…",
        "declaredAuthority": "…",
        "verifiedAuthority": "…",
        "trusted": true,
        "sourceRef": "…",
        "displaces": [],
      },
    },
  ],
  "layers": [
    {
      "layer": "bundled",
      "layerIndex": 0,
      "packId": "ste-ai-provisional",
      "packVersion": "0.1.0",
      "declaredAuthority": "provisional",
      "verifiedAuthority": "provisional",
      "trusted": false,
      "conformanceClaim": "none",
      "contributing": true,
    },
  ],
  "effectiveAuthority": "provisional", // weakest contributing layer; a summary, not a decision
  "conformanceClaim": "none", // stackPermitsConformanceClaim(); 'none' otherwise
}
```

`retractions` appears once at the top level alongside `conformance`, since it is a stack property,
not a per-file one.

The top-level `conformance` block (`main.ts:218-220`) keeps `disclaimer` verbatim and takes
`claim`/`packAuthority` from the composed stack rather than `results[0]`.

**Separately**: `main.ts:266` prints, unconditionally,
`"Provisional rules only; no conformance claim."` — regardless of the pack. That is already
inaccurate today for a trusted normative pack, though it errs conservatively (under-claims), so it is
not a soundness bug. Under layering it should be derived: emit the fixed sentence when
`stackPermitsConformanceClaim` is false, and when true emit the layer summary plus the disclaimer
that the tool certifies nothing. `docs/DISCLAIMER.md:40-41` promises the current wording — see
"Disclaimer impact".

---

## Adversarial review of this proposal

Each case: the attack, whether it works, what stops it, and what residual risk remains.

### 1. Silent retraction of a normative entry by an untrusted layer

_Attack._ Org layer (untrusted) retracts the normative pack's ban on "utilise". Document uses
"utilise" freely. Run is clean. Reader reads clean as conformant.

_Naively:_ works completely, and is invisible — no diagnostic, no entry, nothing to attribute.

_Stopped by:_ default refusal of retractions that target a stronger-authority entry, the
`retraction-refused-weaker-layer` notice, `ComposedRulePack.retractions` as a durable record, and
`allowWeakerLayerRetraction` defaulting to `false`. Even with the opt-in enabled, the retracting layer
is `contributing: true` (per the definition above), so `stackPermitsConformanceClaim` is false.

_Residual._ An operator who sets `allowWeakerLayerRetraction: true` and ignores warnings is not
protected. That is an operator decision, made explicitly, and recorded — which is the whole shape of
the existing trust boundary.

### 2. Override laundering

_Attack._ Untrusted layer overrides a trusted normative entry, keeps its provenance, reports
`normative`.

_Naively:_ this is the **default** outcome of merging entries and picking metadata from the strongest
layer.

_Stopped by:_ A4 — the overriding layer owns the resulting provenance, entire — plus A5's
weakest-wins for field-level merges, plus the `authority-downgraded-by-layer` notice so the downgrade
is visible rather than merely correct.

_Residual._ None I can find for whole-entry override. Field-level merge depends on the merge
algorithm reporting _which_ layers contributed _which_ surviving fields. If it cannot, A5 cannot be
computed and the entry must fall back to the weakest authority among all layers touching that merge
key. **Dependency on the merge spec.**

### 3. Protection-list laundering via `approvedTechnicalTerms`

_Attack._ Untrusted layer adds `"utilise"` — or a whole phrase — to `approvedTechnicalTerms`. The
term is protected as a literal name **before any rule runs**
(`analyse.ts:254-257`, `evaluate.ts:243-245`), so the trusted normative dictionary entry never
matches. No diagnostic. No override. No retraction. Nothing in the merged dictionary changed.

_Naively:_ works perfectly and is the cleanest attack in the set, because it never touches the thing
being protected. It is also currently structurally undetectable: `approvedTechnicalTerms` is
`readonly string[]` (`types.ts:484`) spread into an undifferentiated list with `config.approvedTerms`.

_Stopped by:_ the `approvedTechnicalTerms` type change to `Provenanced<{term}>[]`, plus a run notice
when a protection entry's verified authority is weaker than any contributing normative layer's:

```
code:    'protection-weaker-than-normative-layer'
level:   'warning'
message: '7 protected literal(s) were supplied by a layer of lower authority than a contributing
          normative layer. Text matching them was exempt from every vocabulary check.'
```

The notice lists counts and the supplying pack id; it does **not** claim which findings were
suppressed, because knowing that needs counterfactual evaluation and this design does not do
counterfactuals. Unanimity also fails, so the run-level claim is off.

_Residual._ The notice is a warning about a _possibility_, not a detection. An operator can
legitimately have many protected literals. Honest statement of limit: this design makes the
protection auditable, not verified. Verifying it would require running the vocabulary rules twice —
once with the weaker layer's protections and once without — and diffing. That is a real option and I
am deliberately not specifying it: it doubles rule execution cost and the trade-off is the merge/
performance owner's call. **Flagged as an open question.**

### 4. Limit laundering

_Attack._ Untrusted tech-stack layer sets `proceduralMaxGradeLevel: 20`. The normative
`sentence-length-procedural` rule spec still declares `status: normative` and is still trusted, so
its diagnostics — the ones that still fire — report `normative`. But the limit that decides whether
it fires at all came from an untrusted layer, and now almost nothing fires.

_Naively:_ works, and is invisible: `runner.ts:96-99` derives status from `rules[].status`, while the
limit is read separately by the rule at `sentence-length.ts:28-30`. The two have no connection in the
current code.

_Stopped by:_ per-field limit provenance in `ComposedRulePack.limits` (each limit is a
`Provenanced<{value}>`), plus the rule-side rule that **a diagnostic gated by a limit takes the
weaker of the rule spec's verified authority and the limit's verified authority**. The three
limit-consuming sites (`sentence-length.ts:28-30`, `structure-rules.ts:43`,
`candidate-rules.ts:331`) each read the provenance alongside the value and pass the weaker to
`buildDiagnostic`.

_Residual._ Loosening a limit reduces the _number_ of findings; the weaker-of rule only marks the
findings that survive. It does not surface the suppression. A limit whose provenance is weaker than a
contributing normative layer's should also emit `limit-weaker-than-normative-layer` — same shape as
attack 3's notice, same honest limit. Note also that operator config already does this to limits with
no record at all (`structure-rules.ts:43`, `sentence-length.ts:28-30`) — pre-existing, and A6's
`operator-config` provenance closes it as a side effect.

### 5. Fabricated `sourceRef`

_Attack._ Untrusted layer supplies `rules: [{ruleId: "sentence-length-procedural", status:
"normative", sourceRef: "ASD-STE100 Issue 8, Writing Rule 3.1"}]`. Status is capped to
`supplementary` by `verifiedRuleStatus` (`runner.ts:139-146`) — but `runner.ts:110` assigns
`meta.sourceRef` **unconditionally** whenever `packSpec !== undefined`. The fabricated citation lands
on the diagnostic verbatim, next to a `supplementary` tag that most readers will not weigh against a
specific-looking standard citation.

_Naively:_ works **today**, with one pack. Layering adds six more suppliers who can do it.

_Stopped by:_ `sourceRef` becomes attributed, not asserted. It moves onto `EntryProvenance.sourceRef`
(where it sits beside `packId`, `trusted`, and `verifiedAuthority`) and is rendered as
`claimed by @team/vocab@1.4.0: "ASD-STE100 Issue 8, Writing Rule 3.1"` when the supplying layer is
untrusted, and plainly when trusted. Additionally: an untrusted layer's `sourceRef` never silently
replaces a trusted layer's `sourceRef` for the same rule id without the
`authority-downgraded-by-layer` notice.

_Residual._ A trusted layer can still cite anything it likes. That is correct and intended — trust is
exactly the operator's decision to accept a supplier's citations. The trust boundary's own doc
comment already says so: "Authority is supplier-_declared_ metadata until an operator makes an
explicit, auditable decision to accept it" (`loader.ts:68-70`).

### 6. Id squatting

_Attack._ Operator trusts `@acme/std`. The locale layer — a different file, a different supplier —
declares `metadata.id: "@acme/std"`. Trust is a plain `includes` on a free-text field
(`loader.ts:82,97`, `schema.ts:18`), so the locale layer is trusted and every entry it contributes
reports `normative`.

_Naively:_ works. With one pack the operator points at one file so the exposure is bounded; with
seven independently-sourced layers it is a real supply-chain hole.

_Stopped by:_ the duplicate-id rejection recommended above (`RulePackError` on two layers sharing an
id in one stack). That closes the _collision_ case completely and cheaply.

_Residual._ It does **not** close the case where the squatting layer is the _only_ one with that id —
e.g. the operator trusts `@acme/std` intending the org layer, and the industry layer claims the name
while the real `@acme/std` is not in the stack. Layer-qualified trust entries
(`"industry:@acme/std@2.1.0"`) would close it. **Flagged as an open question**, because it changes
the config contract that another agent owns. Note that even the collision fix has a cost: a
legitimate stack that includes the same pack at two layers becomes an error. I judge that acceptable
— a pack appearing twice in one stack is already a config smell — but it is a real behavioural
constraint, not a free win.

### 7. Mixed-authority run read as normative

_Attack._ No forgery at all. Six of seven layers are trusted and normative; one is not. A reader
scans output that is overwhelmingly `[normative]`, sees a handful of `[supplementary]` lines, and
reads the run as a conformance check.

_Naively:_ works, because the current output has no run-level statement that would contradict it —
and `packAuthority` (`main.ts:190`) is a single scalar that would report `normative`.

_Stopped by:_ `stackPermitsConformanceClaim` returns false (unanimity), the JSON `conformanceClaim`
is `none`, `effectiveAuthority` is the **weakest** contributing layer, `layers[]` names every layer
with its trust flag, and the CLI summary line states it in words. The reader is not asked to infer
the run's standing from a scan of individual lines.

_Residual._ This is a human-factors mitigation, and human-factors mitigations degrade. It is the same
class of risk the existing `[provisional]` tag already carries.

### 8. Pure-retraction layer escaping unanimity

_Attack on my own design._ Define "contributing" as "has at least one surviving entry" — the obvious
definition. A layer whose entire content is retractions then contributes zero surviving entries, is
`contributing: false`, is excluded from the unanimity check, and an untrusted layer that does nothing
but delete normative checks leaves `stackPermitsConformanceClaim` returning `true`.

_Stopped by:_ the definition given above — contributing means a surviving entry **or** an override
**or** a retraction. Recorded here explicitly because the obvious definition is wrong in exactly the
direction that matters, and an implementer reaching for the natural one would reintroduce it.

### 9. Provenance strings as an output channel (attack on my own design)

_Attack._ This design puts pack-controlled strings into human-facing output next to authority
wording. `metadata.name`, `id` and `version` are all unconstrained `z.string().min(1)`
(`schema.ts:18-20`). A pack sets `name: "ASD STEMG — certified conformant (Issue 8)"` and every
message in a mixed run reads `… (flagged by ASD STEMG — certified conformant (Issue 8))`.

_Stopped by:_ render `id@version` only, never `name`; cap the rendered length; never place a
pack-supplied string adjacent to the word "conformance". `id` and `version` are still supplier-
controlled, so an id like `"asd-ste100-official"` is possible — but an id is understood as a name,
not as a claim, and the `trusted: false` flag travels with it in JSON.

_Residual._ Real but small, and it is a genuinely new surface this design creates. Worth a schema
constraint on `id`/`version` character sets, which I am not specifying because it touches the import
boundary schema that `docs/rule-pack-import.md` documents.

### 10. Supplier-written provenance

_Attack._ A pack ships `"provenance": {"trusted": true, "verifiedAuthority": "normative"}` on each
dictionary entry.

_Stopped by:_ two independent barriers. `provenance` does not exist in `rulePackSchema`
(`schema.ts:33-104`), and zod v4 `z.object` strips unknown keys — verified by execution against the
repo's `zod@^4.4.3` (`package.json:110`). And `ComposedRulePack` is a distinct type produced only by
the compositor; no parse path returns it. A2 additionally recommends `z.strictObject` so the attempt
fails loudly instead of being silently cleaned — silent stripping is correct behaviour and a poor
audit trail.

_Residual._ None, provided the compositor never spreads a raw parsed object into a composed entry
(`{...parsedEntry, provenance}` is safe _because_ zod already stripped; `{...rawJson, provenance}`
would not be). Worth an architecture test.

### 11. Trust-list drift across versions

_Attack._ Operator trusts `@acme/std` at v2.1 after review. Supplier ships v3.0 with a different
dictionary. Trust is matched on `id` only (`loader.ts:82`), so v3.0 is trusted with no operator
action.

_Stopped by:_ nothing in the current design. Version pinning (recommended above) would close it.

_Residual._ Open. This exists today; layering multiplies it by seven independently-owned suppliers on
independent release cadences. **Flagged as an open question** rather than decided, because it changes
the config contract.

---

## Disclaimer impact

`docs/DISCLAIMER.md` has four passages that layering makes inaccurate. Quoted exactly, with what
changes.

### 1. "the active rule pack" — singular referent (lines 32-38)

> `provisional` status is not cosmetic. It is carried in:
>
> - each rule's `meta.status` and `meta.sourceRef`;
> - every diagnostic, as the `[provisional]` tag in the message and the `ruleStatus` field in the
>   programmatic and JSON output;
> - **the active rule pack's `metadata.authority` and `metadata.conformanceClaim`, which the bundled
>   pack sets to `provisional` and `none` respectively.**

"the active rule pack's `metadata`" presumes one pack. Under layering there is no singular active
pack. The third bullet must become the layer stack: each contributing layer's declared and verified
authority, and the composed stack's conformance answer. The first two bullets stay true and should
gain the per-entry provenance field as a fourth carrier.

### 2. The `packPermitsConformanceClaim` promise (lines 40-41)

> `packPermitsConformanceClaim()` returns `false` for the bundled pack, and the CLI prints
> `Provisional rules only; no conformance claim.` on every run.

Two problems. The function is being replaced by `entryPermitsConformanceClaim` /
`stackPermitsConformanceClaim`, so the name must change. And "on every run" is a promise about the
unconditional line at `src/cli/main.ts:266` — which this spec proposes to derive rather than
hard-code. The replacement must state the derived behaviour: the sentence is printed whenever
`stackPermitsConformanceClaim` is false, which is every run of the shipped configuration, because the
bundled layer declares `provisional`/`none` (`src/rule-pack/provisional-pack.ts:27,31`).

### 3. "What a passing run means" (lines 44-47) — the most important change

> A clean run means: _this document did not trigger the provisional checks that were enabled._ It
> does not mean the document is Simplified Technical English, and it does not mean the document is
> correct, safe, or complete.

The sentence survives, but "the checks that were enabled" is now doing work it cannot do. Under
layering, _which checks were enabled_ is a composition outcome: a higher layer may have retracted a
lower layer's check, protected a literal that exempts text from it, or raised a limit so it no longer
fires. The disclaimer must add, in substance:

> Which checks were enabled is itself an outcome of composing the configured layers. A higher layer
> can retract a lower layer's entry, exempt text from it by protecting a literal, or relax a limit so
> the check no longer fires. A clean run therefore says nothing about checks that composition
> removed. The run's `layers` and `retractions` output records what each layer contributed and what
> it removed.

This is the sentence the whole spec exists to protect. It is also the sentence that stops being true
by itself, because it was written when one pack governed a run.

### 4. "Supplying authorised material" (lines 60-66)

> If you hold a licence that permits it, an authorised rule pack can supply normative limits, a
> controlled dictionary, and per-rule authority through the documented import boundary — see
> [`rule-pack-import.md`](./rule-pack-import.md). **Doing so changes the `ruleStatus` on diagnostics
> to whatever the pack declares.**

The bolded sentence is **already inaccurate before layering**: `ruleStatus` changes to whatever
`verifiedAuthority` permits, not to whatever the pack declares. An untrusted pack declaring
`normative` yields `supplementary` (`loader.ts:96-97`, `runner.ts:144-145`). Under layering it
becomes actively misleading, because "the pack" is plural and the answer is per-entry. Replacement:

> Doing so changes the `ruleStatus` on diagnostics to the authority the operator has verified for the
> layer that supplied the entry behind each finding — which is the layer's declared authority only
> when the operator has named that layer in `trustedRulePackIds`, and `supplementary` otherwise.

Also singular: "an authorised rule pack can supply" becomes "one or more authorised layers can
supply".

### Unaffected

Line 26 — "Every rule this package ships is classified `provisional`." — is a statement about shipped
rule _code_, which layering does not change. `scripts/ci/assert-rules-provisional.mjs` continues to
assert exactly this and needs no change from this spec.

### Also inaccurate, outside `DISCLAIMER.md`

Not my file to change, but inside the authority contract I own, so recorded:

- `docs/rule-pack-import.md:51` — "`packPermitsConformanceClaim()` returns true only for 'normative'
  - not 'none'." — omits the `trustedRulePackIds` condition (`loader.ts:82`). Already wrong.
- `docs/rule-pack-import.md:135` — table row `packPermitsConformanceClaim()` | `false` | `true` if
  `conformanceClaim !== 'none'` — same omission. Both describe a **more permissive** function than
  exists. Errs in the safe direction (code stricter than doc) but is a false contract, and layering
  makes the table's two-column shape wrong anyway.
- `README.md:248-249` — "term mappings, contractions and per-rule authority all come from the active
  pack. Supply a licensed pack and diagnostics report its authority and citations instead of
  `provisional`." — same singular-pack framing and same omission of the trust gate.

---

## Open questions

1. **Can the bundled layer be fully evacuated?** Unanimity plus the bundled layer's
   `provisional`/`none` metadata (`provisional-pack.ts:27,31`) means no run-level conformance claim
   is reachable unless `replace` at the bundled layer removes it entirely. **Dependency on the merge
   spec.** If it cannot, `stackPermitsConformanceClaim` is permanently `false` and should be
   documented as such rather than weakened.
2. **Does the merge algorithm report per-field contributors?** A5 (weakest-wins for field-level
   merges) needs to know which layers contributed which surviving fields. If the merge output cannot
   express that, the fallback is weakest-authority-among-all-layers-touching-the-key, which is
   correct but coarse. **Dependency on the merge spec.**
3. **Version-pinned trust entries?** Recommended (attacks 6, 11), not decided — changes the config
   contract another agent owns.
4. **Layer-qualified trust entries** (`"industry:@acme/std@2.1.0"`)? Closes the residual squat in
   attack 6 that duplicate-id rejection does not. Same config-contract dependency.
5. **`Diagnostic.provenance` required or optional?** I specify **required**, on the `reviewerKind`
   principle. The cost is real: it is a breaking change to a public type, and every rule and
   `buildDiagnostic` call site changes. An optional field is cheaper and reintroduces exactly the
   ambiguity the precedent exists to remove.
6. **Counterfactual verification of protection and limit suppression?** Attacks 3 and 4 are made
   auditable, not detected. Detection would need a double run (with and without the weaker layer's
   protections/limits) and a diff. That is a real design option with a real cost; I have deliberately
   not specified it, because the cost is a performance/merge decision.
7. **Do operator-config contributions become a real layer?** A6 gives them synthetic provenance. It
   may be cleaner to model them as an explicit top layer in the stack rather than a synthetic origin.
   Touches the config schema another agent owns.
8. **`approvedTechnicalTerms` breaking change acceptable?** `string[]` →
   `Provenanced<{term: string}>[]` is required for attack 3 and is a public API break
   (`package.json:20-27`). No workaround exists: a string cannot carry provenance.
