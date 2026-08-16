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
to decide. It supersedes nothing in the specs; they hold the detail and the citations.

## Framing correction: this is a defect, not a feature

`README.md:74-75` already states that `rulePack` and `approvedTerms` let a repository supply its own
vocabulary **"on top of the bundled provisional pack"**. `resolveRulePack` (`loader.ts:49-56`)
substitutes instead — its three branches each return one pack, and none combines them.

So the documented behaviour and the implemented behaviour already disagree. Layering closes that gap
rather than adding something new. `03` found a second instance of the same drift: `README.md` is not
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

## Open — needs a human decision

### A. `limits` merge policy

`01` recommends **last-wins**, with this argument: `limits` is required in `rulePackSchema`, so a
most-restrictive-wins rule would pin the bundled pack's values (procedural grade level 7) as a
ceiling no organisation could raise, pushing every such operator back onto `replace` — which is the
defect this work exists to fix.

Stated cost: a product layer can loosen an organisation's limit, guarded only by a notice.

The alternative is an organisation-set floor that lower layers cannot loosen, which blocks a locale
or product layer from a legitimate override. **Not decided.**

### B. Conformance claims under mixed authority

`02` proposes splitting `packPermitsConformanceClaim` into:

- `entryPermitsConformanceClaim` — per entry, so a finding from a trusted normative layer keeps its
  standing even in a mixed stack;
- `stackPermitsConformanceClaim` — run level, requiring **unanimity** across contributing layers.

The asymmetry driving it: a positive finding is attributable to one entry, whereas silence is a
property of the whole stack. Unanimity is deliberately strict — one untrusted layer anywhere disables
run-level conformance claims. **Not decided.**

`02` also closes a self-attack worth preserving: defining "contributing layer" as "has a surviving
entry" would let a pure-retraction untrusted layer escape the unanimity check entirely.

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
"main is green at `9d78a8b`" as unconfirmed. The full suite was run separately at that commit:
545 tests, all passing.
