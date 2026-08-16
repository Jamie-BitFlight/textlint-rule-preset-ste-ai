# Layered rule packs — consolidated design and open decisions

Design record for [issue #64](https://github.com/Jamie-BitFlight/textlint-rule-preset-ste-ai/issues/64).
Three specs were produced independently against commit `9d78a8b`, each with a scope boundary so they
would not design across each other:

| Spec                                                             | Scope                                                                             |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`01-merge-core.md`](./01-merge-core.md)                         | Config shape, per-field merge algorithm, retraction, conflict detection, ordering |
| [`02-authority-trust.md`](./02-authority-trust.md)               | Per-entry authority, the trust boundary under composition, provenance             |
| [`03-migration-verification.md`](./03-migration-verification.md) | Blast radius, back-compatibility, test strategy, staged rollout                   |

This file records what the three agree on, where two of them disagreed, and what remains for a human
to decide. The specs hold the detail and the citations, and they are **not** rewritten to match this
record — so where the two differ, this file wins. Four things it overturns, each still asserted
unqualified in the spec that proposed it:

| Overturned                                   | Still asserted in                       |
| -------------------------------------------- | --------------------------------------- |
| `rulePacks` as a new config key              | `01:178`, the config table, conflict C1 |
| Composed output satisfies `RulePack` exactly | `01:14`, its opening premise            |
| `replace` mode, and replace-only-at-index-0  | `01` (C2, C5, C6); depended on by `02`  |
| Conformance claims are in scope              | most of `02`                            |

Each spec carries a banner pointing here, so a reader who opens one directly is not led into an
overturned design.

## Framing correction: this is a defect, not a feature

`README.md:74-75` already states that `rulePack` and `approvedTerms` let a repository supply its own
vocabulary **"on top of the bundled provisional pack"**. `resolveRulePack` (`loader.ts:49-56`)
substitutes instead — its three branches each return one pack, and none combines them.

So the documented behaviour and the implemented behaviour already disagree — with one qualifier that
sentence conjoins two keys and only one of them layers today: `config.approvedTerms` really is spread
together with `pack.approvedTechnicalTerms` at `analyse.ts:255`. `rulePack` is the half that
substitutes. `03:477` states this precisely; the claim here is the same one, narrowed to the key it
actually applies to. Layering closes that gap rather than adding something new. `03` found a second instance of the same drift: `README.md` is not
alone, and the reconciliation list in that spec names the rest.

## Resolved: the two places the specs disagreed

### 1. The composed output type — the authority requirement wins

`01` proposed that composition output satisfy the existing `RulePack` interface exactly, so no rule
or consumer would change. `02` requires a distinct `ComposedRulePack` in which every entry carries a
required `EntryProvenance`.

These cannot both hold. `RulePack` has nowhere to put per-entry authority — `approvedTechnicalTerms`
is `readonly string[]` (`types.ts:484`), and a string cannot carry provenance.

**Decision: `02` wins; `01`'s zero-consumer-change property is what gives.**

The reason is the concrete attack `02` documents: an untrusted layer adds a technical term, that term
is protected before any rule runs (`analyse.ts:254-257`), and a normative dictionary entry then never
matches. Without per-entry provenance nothing distinguishes that entry from a trusted one. The cost —
a breaking type change and a wider blast radius — is real and belongs to `03`'s inventory.

### 2. The config key — widen `rulePack`, do not add `rulePacks`

`01` proposed a new `rulePacks` key alongside `rulePack`. `03` proposed widening the existing
`rulePack` key to accept an array.

**Decision: `03` wins, on measured behaviour.** Executed against the config schema at this commit:

```
new key `rulePacks` on current schema → ACCEPTED, and the key is SILENTLY STRIPPED
array passed to existing `rulePack`  → REJECTED (fails loud)
```

`steAiConfigSchema` (`config.ts:119`) is a plain `z.object`, so it strips unknown keys. A config
written for a newer linter and run against an older one would therefore lose its entire layer stack
and lint against the bundled pack with no signal. Widening the existing key converts that same
version skew into a loud parse failure.

This is a design decision that surfaced only from asking a migration question, which is the argument
for having produced `03` at all.

## Agreed across specs

- **The bundled pack becomes layer 0**, present unless displaced by a `replace` entry, rather than a
  fallback used when nothing is configured.
- **`replace` is legal only as the first layer.** A later `replace` makes every preceding entry dead
  config, which is better rejected than honoured.
- **Merge keys are per-field, not global.** Verified: `termPattern` (`helpers.ts:10`) matches with
  flags `giu` and collapses whitespace, while `approvedTerms` protection
  (`protected-regions.ts:552`) matches with flags `gu`, case-sensitively and without folding. A single
  normaliser would therefore be wrong for one of them.
- **Override direction is one-way.** The overriding layer owns the resulting entry's provenance
  entirely; it is never inherited from the layer being overridden.
- **Retraction needs its own syntax.** Union alone cannot express a locale layer un-banning a term an
  organisation layer banned. `01` specifies a `retract` block and records why `options.allow` is not
  the mechanism.
- **Characterisation tests come first.** Both `02` and `03` found independently that no test imports
  `src/rule-pack/loader.ts`; `grep -rln "authority\|conformance\|rulePack" test/` returns zero files.
  Nothing else should merge before that gap is closed.

## Decided by the maintainer

### A. `limits` merge policy — last-wins

**Decided: last-wins**, matching how ESLint and Ruff resolve overlapping configuration. A later
layer's limit replaces an earlier one; there is no organisation-set floor that lower layers cannot
loosen.

This follows `01`'s recommendation. Its argument stands: `limits` is required in `rulePackSchema`, so
a most-restrictive-wins rule would pin the bundled pack's values (procedural grade level 7) as a
ceiling no organisation could raise.

Accepted cost, recorded so it is not rediscovered as a surprise: a product or locale layer can loosen
an organisation's limit. The conventional-tooling behaviour was preferred over enforcement.

### B. Conformance under mixed authority — not in scope

**Decided: the product does not make conformance claims, so there is nothing to protect here.**

The maintainer's framing: this is a configurable linter that flags prose exceeding a threshold and
suggests it could be tighter. It is a per-repository capability that may import organisation-level
dictionaries, stay local-only, or mix the two. Conformance standing for a supplied pack is not a
goal.

That resolves the question by removing it. It also removes the reason a subsystem exists, which is a
larger change than the decision it settles.

#### What this decision cascades into

The authority machinery exists to guard one path: a supplied pack declaring `normative` authority and
having that claim honoured after an operator names it in `trustedRulePackIds`. With conformance out
of scope, that path has no destination. The surface is 35 references across 8 files, counted by this
exact command so the number can be re-derived rather than trusted:

```bash
grep -vE '^\s*(//|\*|/\*)' <file> \
  | grep -coE 'packPermitsConformanceClaim|verifiedAuthority|verifiedRuleStatus|trustedRulePackIds|conformanceClaim|metadata\.authority'
```

That is occurrences of the removal candidates, with comment-only lines excluded — a rule worth
stating, because counting matching _lines_ instead, or leaving comments in, gives materially
different totals, and the scope of the proposed removal is argued from this table.

| File                                | References |
| ----------------------------------- | ---------: |
| `src/cli/main.ts`                   |         11 |
| `src/rule-pack/loader.ts`           |         10 |
| `src/core/runner.ts`                |          5 |
| `src/analysis/analyse.ts`           |          5 |
| `src/rule-pack/provisional-pack.ts` |          1 |
| `src/rule-pack/schema.ts`           |          1 |
| `src/core/types.ts`                 |          1 |
| `src/core/config.ts`                |          1 |

Candidates for removal, each serving only the conformance path: `packPermitsConformanceClaim`,
`verifiedAuthority`, `verifiedRuleStatus`, the `trustedRulePackIds` config key, and
`metadata.authority` / `metadata.conformanceClaim` in the pack schema.

**What is kept, and what each protects when working correctly:**

- **`provisional` rule status and the `[provisional]` tag** — tells a reader a finding comes from an
  authored heuristic rather than a standard. Honest, cheap, and independent of the conformance path.
- **`sourceRef` per rule** — says where a rule is documented. With authority elevation gone this
  becomes pure provenance, which is the same thing layered packs need per entry.
- **`DISCLAIMER.md`'s trademark and non-implementation statements** — these describe what the package
  is not, and remain true. Its "supplying authorised material" section describes the removed path and
  would need reconciling.
- **The disclaimer line in CLI output** — states plainly that the tool certifies nothing.

This also shrinks the `sourceRef` defect (#66). Without an authority-elevation path there is no
trusted-versus-untrusted distinction for a citation to cross; attributing a `sourceRef` to the pack
that supplied it is then the same work as per-entry provenance, rather than a separate fix.

## Superseded by project stage

The maintainer has confirmed the repository is a prototype with no users. Two conclusions recorded
above lose their supporting argument:

- **The `rulePack` versus `rulePacks` decision.** The measured version-skew argument — a config
  written for a newer linter silently losing its layer stack on an older one — requires users on old
  versions. The weaker argument for widening the existing key (one key is less confusing than two)
  is unaffected.
- **`replace` mode.** It was specified to preserve the current substituting behaviour for configs
  already in use. Without such configs to preserve, packs can always compose, which removes a config
  mode, the "`replace` only at index 0" validation rule, and its test cases.

Spec `03`'s back-compatibility analysis should be read with this in mind. Its blast-radius inventory,
test strategy and staged rollout remain applicable; its back-compat reasoning does not.

## Related defects found while specifying

Both are independent of layering and are tracked separately:

- **`sourceRef` passes through untrusted.** `runner.ts:110` assigns `meta.sourceRef` from the pack
  unconditionally. `verifiedRuleStatus` caps an untrusted pack's _status_, and the citation _string_
  is copied verbatim, so an untrusted pack can print a fabricated standard citation on a diagnostic.
- **The rule-pack loader has no test coverage**, as above.

## Documentation already inaccurate, before any of this lands

`02` and `03` found the same drift independently:

- `rule-pack-import.md:51` and `:135` describe `packPermitsConformanceClaim()` with two conditions.
  `loader.ts:76-83` enforces three — the third being membership in `trustedRulePackIds`. The docs
  describe the gate as more permissive than the code.
- `DISCLAIMER.md:64-65` states a pack "changes the `ruleStatus` on diagnostics to whatever the pack
  declares", which holds only once an operator has trusted it.
- `README.md:74-75`, as above.

## Method note

The specs were produced by three agents working in isolated worktrees from `9d78a8b`, each instructed
to cite a file and line for every claim about current behaviour and to state uncertainty rather than
guess. Claims reproduced in this file were re-verified directly before being recorded here. Where a
spec labelled something as its own proposal rather than an existing fact — `01` does this for
"weakest authority wins", since `ruleStatusSchema` declares no ordering — that label is preserved.

`03` recorded that it could not run the test suite (no `node_modules` in its worktree) and flagged
"main is green at `9d78a8b`" as unconfirmed. Confirmed since, and the answer needs its commit
naming: at `9d78a8b` the suite is green (545 tests). At `ebcc623` — the commit this branch was cut
from, and a different tree — one corpus assertion was failing, pre-existing from #56 and fixed by
#58. `03`'s Stage 0 precondition is therefore discharged only against a tree that has #58 in it.
