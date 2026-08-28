# Layered rule packs — consolidated design and open decisions

Design record for [issue #64](https://github.com/Jamie-BitFlight/textlint-rule-preset-ste-ai/issues/64).
Three specs were produced independently against commit `9d78a8b`. Each spec had a scope boundary, so
they would not design across each other:

| Spec                                                             | Scope                                                                                     |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`01-merge-core.md`](./01-merge-core.md)                         | Config shape<br>Per-field merge algorithm<br>Retraction<br>Conflict detection<br>Ordering |
| [`02-authority-trust.md`](./02-authority-trust.md)               | Per-entry authority, the trust boundary under composition, provenance                     |
| [`03-migration-verification.md`](./03-migration-verification.md) | Blast radius, back-compatibility, test strategy, staged rollout                           |

This file records what the three agree on, where two of them disagreed, and what remains for a human
to decide. The specs hold the detail and the citations. They are **not** rewritten to match this record. Where
the two differ, this file wins. Four things it overturns, each still asserted
unqualified in the spec that proposed it:

| Overturned                                   | Still asserted in                       |
| -------------------------------------------- | --------------------------------------- |
| `rulePacks` as a new config key              | `01:186`, the config table, conflict C1 |
| Composed output satisfies `RulePack` exactly | `01:22-23`, its opening premise         |
| `replace` mode, and replace-only-at-index-0  | `01` (C2, C6) — depended on by `02`     |
| Conformance claims are in scope              | most of `02`                            |

Each spec carries a banner pointing here. A reader who opens one directly is not led into an
overturned design.

## Framing correction: this is a defect, not a feature

At `9d78a8b`, `README.md:74-75` stated that `rulePack` and `approvedTerms` let a repository supply its
own vocabulary. The exact phrase was **"on top of the bundled provisional pack"**. `resolveRulePack`
(`loader.ts:49-56`) substitutes instead — its three branches each return one pack, and none combines
them.

So the documented behaviour and the implemented behaviour disagreed at that commit. One qualifier
applied: that `README.md` sentence named two keys, but only one of them layered. `config.approvedTerms`
really is spread together with `pack.approvedTechnicalTerms` at `analyse.ts:264`. `rulePack` is the
half that substitutes. `03:494-495` states this precisely. The claim there is the same one, narrowed
to the key it actually applies to. Layering closes that gap rather than adding something new.

**This part is now fixed.** `README.md` was corrected by commit `17b5ce7`, which fixed the `rulePack`
layering claim. It now says `rulePack` replaces the bundled provisional pack entirely, rather than
adding to it. It separately says `approvedTerms` layers on top of whichever pack is active. Both
statements now match the implementation described above. `resolveRulePack` still substitutes. Only the
documentation claim has changed. `03` found a second instance of the same drift in a different file.
The reconciliation list in that spec names the rest. That part is unverified here.

## Resolved: the two places the specs disagreed

### 1. The composed output type — the authority requirement wins

`01` proposed that composition output satisfy the existing `RulePack` interface exactly, so no rule
or consumer would change. `02` requires a distinct `ComposedRulePack` in which every entry carries a
required `EntryProvenance`.

These cannot both hold. `RulePack` has nowhere to put per-entry authority — `approvedTechnicalTerms`
is `readonly string[]` (`types.ts:489`), and a string cannot carry provenance.

**Decision: `02` wins — `01`'s zero-consumer-change property is what gives.**

The reason is the concrete attack `02` documents. An untrusted layer adds a technical term. That term
is protected before any rule runs (`analyse.ts:263-266`). A normative dictionary entry then never
matches. Without per-entry provenance nothing distinguishes that entry from a trusted one. The cost —
a breaking type change and a wider blast radius — is real and belongs to `03`'s inventory.

### 2. The config key — widen `rulePack`, do not add `rulePacks`

`01` proposed a new `rulePacks` key alongside `rulePack`. `03` proposed widening the existing
`rulePack` key to accept an array.

**Decision: `03` wins, on measured behaviour.** Executed against the config schema at `9d78a8b`:

```
new key `rulePacks` on schema at `9d78a8b` → ACCEPTED, and the key is SILENTLY STRIPPED
array passed to existing `rulePack`        → REJECTED (fails loud)
```

At that commit, `steAiConfigSchema` was a plain `z.object`, so it stripped unknown keys. Consider a
config written for a newer linter and then run against an older one. It would therefore lose its
entire layer stack. It would then lint against the bundled pack with no signal. Widening the existing
key converted that same version skew into a loud parse failure.

**This measurement is now stale.** Commit `6667a02` changed `steAiConfigSchema` (`config.ts:144`) to
`z.strictObject`, so it now rejects an unrecognised key instead of stripping it. Re-running the same
test today gives a different result:

```
new key `rulePacks` on the current schema → REJECTED (fails loud)
array passed to existing `rulePack`       → REJECTED (fails loud)
```

Both paths now fail loud. The silent-strip risk that drove this decision no longer distinguishes the
two options. This record does not revisit the decision. It flags the drift so a reader does not treat
the first command block as still current.

This is a design decision that surfaced only from asking a migration question. That is the argument
for having produced `03` at all.

## Agreed across specs

- **The bundled pack becomes layer 0**, rather than a fallback used when nothing is configured.
  ~~present unless displaced by a `replace` entry~~ — struck: `replace` is removed by "Superseded by
  project stage" below. As a result, nothing displaces it.
- ~~**`replace` is legal only as the first layer.**~~ Struck for the same reason. The specs agreed on
  this validation rule. It has no subject now that the mode is gone. It is recorded here because the
  agreement was real, and it would need reinstating along with the mode.
- **Merge keys are per-field, not global.** Verified: `termPattern` matches with flags `giu` and
  collapses whitespace. This is confirmed at `helpers.ts:10`. `approvedTerms` protection matches with
  flags `gu`, case-sensitively and without folding. This is confirmed by `approvedTermPass` in
  `protected-regions.ts`. A single normaliser would therefore be wrong for one of them.
- **Override direction is one-way.** The overriding layer owns the resulting entry's provenance
  entirely. That provenance is never inherited from the layer being overridden.
- **Retraction needs its own syntax.** Union alone cannot express a locale layer un-banning a term an
  organisation layer banned. `01` specifies a `retract` block and records why `options.allow` is not
  the mechanism.
- **Characterisation tests come first.** Both `02` and `03` found independently that no test imports
  `src/rule-pack/loader.ts`. Run `grep -rln "authority\|conformance\|rulePack" test/` to check whether
  that gap is still open. Nothing else should merge before it closes.

## Decided by the maintainer

### A. `limits` merge policy — last-wins

**Decided: last-wins**, matching how ESLint and Ruff resolve overlapping configuration. A later
layer's limit replaces an earlier one. There is no organisation-set floor that lower layers cannot
loosen.

This follows `01`'s recommendation. Its argument stands: `limits` is required in `rulePackSchema`. A
most-restrictive-wins rule would therefore pin the bundled pack's values (see
`provisionalRulePack.limits` in `src/rule-pack/provisional-pack.ts`) as a ceiling. No organisation
could raise that ceiling.

This is an accepted cost, recorded here so it is not rediscovered as a surprise. A product or locale
layer can loosen an organisation's limit. The conventional-tooling behaviour was preferred over
enforcement.

### B. Conformance under mixed authority — not in scope

**Decided: the product does not make conformance claims, so there is nothing to protect here.**

The maintainer's framing: this is a configurable linter. It flags prose that exceeds a threshold and
suggests the prose could be tighter. It is a per-repository capability that may import organisation-level
dictionaries, stay local-only, or mix the two. Conformance standing for a supplied pack is not a
goal.

That resolves the question by removing it. It also removes the reason a subsystem exists, which is a
larger change than the decision it settles.

#### What this decision cascades into

The authority machinery exists to guard one path. A supplied pack can declare `normative` authority.
That claim is honoured only after an operator names the pack in `trustedRulePackIds`. With conformance out
of scope, that path has no destination. This command finds every file touching the removal
candidates. It counts occurrences in each file, so the surface can be re-derived rather than trusted
to a stated total:

```bash
for f in $(grep -rlE 'packPermitsConformanceClaim|verifiedAuthority|verifiedRuleStatus|trustedRulePackIds|conformanceClaim|metadata\.authority' src/); do
  n=$(grep -vE '^\s*(//|\*|/\*)' "$f" \
    | grep -oE 'packPermitsConformanceClaim|verifiedAuthority|verifiedRuleStatus|trustedRulePackIds|conformanceClaim|metadata\.authority' \
    | wc -l)
  echo "$n $f"
done
```

Counts are occurrences of the removal candidates, with comment-only lines excluded. This distinction
is worth stating: counting matching _lines_ instead, or leaving comments in, gives a materially
different total. The `| wc -l` is the load-bearing part: `grep -c` counts matching **lines** and
ignores `-o`, which undercounts files with more than one match per line.

Candidates for removal, each serving only the conformance path:

- `packPermitsConformanceClaim`
- `verifiedAuthority`
- `verifiedRuleStatus`
- the `trustedRulePackIds` config key
- `metadata.authority` / `metadata.conformanceClaim` in the pack schema

**What is kept, and what each protects when working correctly:**

- **`provisional` rule status and the `[provisional]` tag** — tells a reader a finding comes from an
  authored heuristic rather than a standard. Honest, cheap, and independent of the conformance path.
- **`sourceRef` per rule** — says where a rule is documented. With authority elevation gone this
  becomes pure provenance, which is the same thing layered packs need per entry.
- **`DISCLAIMER.md`'s trademark and non-implementation statements** — these describe what the package
  is not, and remain true. Its "supplying authorised material" section describes the removed path and
  would need reconciling.
- **The disclaimer line in CLI output** — states plainly that the tool certifies nothing.

This also shrinks the `sourceRef` defect (#66). Without an authority-elevation path, there is no
trusted-versus-untrusted distinction for a citation to cross. Attributing a `sourceRef` to the pack
that supplied it is then the same work as per-entry provenance. It is not a separate fix.

## Superseded by project stage

The maintainer has confirmed the repository is a prototype with no users. Two conclusions recorded
above lose their supporting argument:

- **The `rulePack` versus `rulePacks` decision.** The measured version-skew argument requires users on
  old versions. It describes a config written for a newer linter that silently loses its layer stack
  on an older one. The weaker argument for widening the existing key (one key is less confusing than
  two) is unaffected.
- **`replace` mode.** It was specified to preserve the current substituting behaviour for configs
  already in use. Without such configs to preserve, packs can always compose. That removes a config
  mode, the "`replace` only at index 0" validation rule, and its test cases.

Spec `03`'s back-compatibility analysis should be read with this in mind. Its blast-radius inventory,
test strategy, and staged rollout remain applicable. Its back-compat reasoning does not.

## Related defects found while specifying

Both were independent of layering, tracked separately, and are now fixed for the single-pack case
this repository ships today:

- **`sourceRef` passed through untrusted (#66, fixed, two rounds).** `runner.ts` first withheld a
  citation only when a downgrade actually occurred. A pack could dodge that check. It only had to
  declare a non-`normative` status directly. The check moved to gating on the declared status
  instead. That gate still had a hole. Every shipped rule's own status is `provisional`. A pack
  could declare `provisional` and still supply a fabricated citation. The check now gates on the
  citation text itself. A pack entry's `sourceRef` is honoured only when it repeats
  `rule.meta.sourceRef` verbatim, or the pack is trusted. `rule.meta.sourceRef` is the rule's own
  built-in citation. Matching the status proved nothing about the citation. Matching the text does.
  Layering still leaves one gap open: attributing a claim to _which_ layer supplied it, once several
  packs stack. See attack 5 in `02-authority-trust.md`.
- **The rule-pack loader had no test coverage (#67, fixed).** `test/integration/rule-pack.test.ts`
  and `test/unit/rule-pack-loader.test.ts` now cover it directly, as above.

## Documentation already inaccurate, before any of this lands

`02` and `03` found the same drift independently:

- `rule-pack-import.md:51` and `:135` describe `packPermitsConformanceClaim()` with two conditions.
  `loader.ts:76-83` enforces three — the third being membership in `trustedRulePackIds`. The docs
  describe the gate as more permissive than the code.
- `DISCLAIMER.md:64-65` states that a pack "changes the `ruleStatus` on diagnostics to whatever the
  pack declares." That statement holds only once an operator has trusted the pack.
- `README.md:74-75` — this one is fixed now. See "Framing correction" above.

## Method note

The specs were produced by three agents, each working in an isolated worktree from `9d78a8b`. Each
agent was instructed to cite a file and line for every claim about current behaviour. It was also
instructed to state uncertainty rather than guess. Claims reproduced in this file were re-verified directly before being recorded here. Sometimes a
spec labelled something as its own proposal rather than an existing fact. `01` does this for "weakest
authority wins", since `ruleStatusSchema` declares no ordering. That label is preserved here.

`03` recorded that it could not run the test suite (no `node_modules` in its worktree) and flagged
"main is green at `9d78a8b`" as unconfirmed. Confirmed since, and the answer needs its commit
naming: at `9d78a8b` the suite is green under `vp test`. At `ebcc623` — the commit this branch was
cut from, and a different tree — one corpus assertion was failing. That assertion was pre-existing
from #56, and it was fixed by #58. `03`'s Stage 0 precondition is therefore discharged only against
a tree that has #58 in it.
