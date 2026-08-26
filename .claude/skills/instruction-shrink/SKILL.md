---
name: instruction-shrink
description: Shrink an instruction document — SKILL.md, CLAUDE.md, AGENTS.md, agent prompt, runbook, rule file — by classifying every instruction as DOES, RESOLVES, REASONS, or EXPLAINS and cutting what does not change behavior. Use when asked to shrink, compress, tighten, trim, de-slop, deflate, or cut the token count of a prompt or instruction document, or when a document is too long for the behavior it actually specifies.
---

# Instruction shrink

Cut an instruction document down to the text that changes what an agent does. Everything else is
waste, however well written.

## Behavioral contract

Before cutting, state the behavioral contract: the set of actions the document is expected to
produce. Every keep-or-cut decision is judged against it, and the contract does not change during
the pass. A cut is safe when expected behavior under that contract is unchanged.

## Classify before cutting

Split the document into units — one sentence, list item, table row, or independently removable
instruction each. Classify each unit by function:

- **DOES** — specifies an action, decision, branch, validation, completion condition, output, or
  required lookup.
- **RESOLVES** — makes execution unambiguous: paths, substitutions, quoting, references, scope, or
  dependencies.
- **REASONS** — supplies a principle the agent needs to make a good decision where the correct
  action cannot be fully specified in advance.
- **EXPLAINS** — describes why an already-bounded instruction works, how it was implemented, its
  history, or why a choice already made for the agent was made.

DOES, RESOLVES, and REASONS may earn their load. EXPLAINS is presumed removable unless its deletion
changes expected behavior under the behavioral contract.

## The bounded test

When prose gives a reason for an instruction, ask:

> Is the agent expected to reason from this information to choose an action in situations the
> document cannot enumerate, or has the action already been fully chosen for it?

If the agent must choose among context-dependent paths, preserve the minimum reasoning principle
needed to make that choice well. If the instruction is bounded and already determines the action,
its rationale normally does not affect execution — cut it.

### Bounded — cut the rationale

> Commit changes between edits.

Bounded. Explanation of why incremental commits are useful normally adds no behavior.

### Unbounded — keep the principle

> Choose the smallest validation capable of disproving the change before running broader tests.

Unbounded. The principle is operational because the agent must reason about the current change,
available checks, cost, and failure risk.

## Verify

The pass is done when every DOES and RESOLVES unit in the original has a surviving counterpart in
the output, and every removed unit was EXPLAINS or a rationale that failed the bounded test. A unit
you cannot classify is not yet understood — resolve it rather than cutting it.
