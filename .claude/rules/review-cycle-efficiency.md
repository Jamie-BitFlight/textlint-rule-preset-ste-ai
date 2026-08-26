# Reducing review-cycle turns

Lessons from the vitest-suite-quality-perf effort (PRs #77-#84, #103): every extra Codex
review round in that work traced back to the same mistake — noticing a signal something was
wrong and routing around it instead of stopping on it. These rules exist to make that stop
happen earlier, before a reviewer has to find it instead.

## An anomalous mutation-test result is the finding, not noise to route around

If a mutation makes an assertion pass when it should have failed — including an "unrelated"
mutation you were not specifically testing for, like swapping a message string for a placeholder
that has nothing to do with the mutation you meant to check — that result **is** the bug report.
Stop and fix the assertion immediately. Do not set it aside in favor of a narrower mutation that
happens to fail and call the test covered; the narrower mutation failing does not un-happen the
wider one succeeding.

Concrete instance this cost a full extra round on: a `SuppressionRecord.message` assertion still
passed after being swapped to an unrelated placeholder. That was set aside in favor of a
different, narrower mutation that did fail — so the test shipped, Codex caught the real gap on
review, and the fix needed a second commit and a second review round. The information needed to
catch it pre-push was already in hand at the first mutation run.

## Fetch opaque IDs immediately before use — never guess or reuse one from memory

GitHub comment IDs, thread node IDs, and similar opaque identifiers are not derivable or
predictable. Call the read API (`get_review_comments`, etc.) immediately before the call that
consumes the ID, in the same task, rather than reusing an ID recalled from earlier context. A
guessed ID fails validation and costs a full extra round-trip to fetch the real one anyway — the
fetch is unavoidable, so do it first and skip the failed attempt.

## Grep a file's existing bindings before naming a new one in it

Before adding a new top-level `const`/`function` to a file you're editing, check whether that
name is already bound elsewhere in the same file (a quick `Grep` for the identifier). A collision
surfaces as a lint failure (`no-shadow`) after the fact, which is a fully avoidable extra
edit-and-rerun cycle for a one-line check.

## Partition and dispatch independent work in parallel from the start of a wave

If a plan's own conflict-set analysis already shows which nodes are independent, treat that as
the dispatch instruction for that wave, not as documentation to revisit after being asked to
parallelize. Work out the independent partition once, at plan formation, then dispatch every node
in a wave's independent set as parallel `isolation: "worktree"` agents together — don't default to
sequential execution and wait for a prompt to switch modes.

## `git stash` is blocked here — use the patch-file technique from the start

This environment's auto-mode permission classifier denies `git stash`. For mutation-test
verification that needs a clean revert-then-restore cycle, use the patch-file technique directly
instead of discovering the block reactively:

```sh
git diff -- <files> > /tmp/.../patch   # save the diff
git checkout -- <files>                 # revert cleanly
# ...run the test against the reverted state...
git apply /tmp/.../patch                # restore
```
