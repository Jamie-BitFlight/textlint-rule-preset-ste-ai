# Working on this repo

## Documentation stays in sync with code — no confirmation needed

Standing pre-approval: whenever a task changes functionality, update the documentation that
describes it as part of the same task, without asking first. Stale documentation is never
acceptable output. A task that changes behavior but leaves the docs describing the old behavior is
an incomplete task, not a finished one with a follow-up.

This covers `README.md`, everything under `docs/`, doc comments on changed code, and any other
file whose job is to describe current behavior to a human or an agent reading it later. It does not
require a separate confirmation step, a separate PR, or asking whether documentation should be
updated — that question is already answered.

## Repo name

This repo was renamed on GitHub from `textlint-ASD-ai` to `textlint-rule-preset-ste-ai`. Git-level
operations (`git push`, `git fetch`) and most REST-backed GitHub tool calls redirect transparently
under the old name. GraphQL-backed calls do not — a review-thread node ID fetched under one repo
name will be rejected by a mutation declared under the other (`resolve_review_thread` specifically:
the old name gets "does not belong to the declared repo," the new name gets "not configured for this
session"). If a GraphQL-shaped call fails on a repo-identity error, that is very likely this, not a
real permissions problem — try the other name before concluding the operation is blocked.

## Agents share this session's rate limit — retry, don't substitute

A subagent that fails with a session/token-limit error is not reporting a real task failure. It
shares the same underlying budget as the orchestrating session; if the orchestrator is still able to
run tool calls, the budget has recovered and the agent should be resumed (`SendMessage` to its
agent id) to pick back up from its own transcript, not re-done directly by the orchestrator. Doing
the work directly "to save time" defeats the reason agents were delegated to in the first place —
the orchestrator has no capability advantage over an agent, only a higher cost per action, so
absorbing an agent's work is strictly worse than retrying it.

## Parallel agents need real isolation, not just a promise not to collide

Running two agents against this repo at once is only safe if they cannot both mutate the same
working tree at the same time. `git checkout`/`git checkout -b` in the shared clone changes what is
on disk out from under any other agent still reading or writing there — including the orchestrator
itself.

For any agent dispatched via the `Agent` tool, pass `isolation: "worktree"` rather than manually
creating and tracking a `git worktree add` directory yourself. The tool creates and owns the
isolated worktree (under `.claude/worktrees/<name>/` inside the repo by default — documented at
https://code.claude.com/docs/en/worktrees.md — matched by `.gitignore` here, not something to
relocate). This is a hard-learned correction, not a preference: a real incident on this repo
involved manually reusing one hand-created worktree directory across four separate agent dispatches
for the same task. That reuse — not any individual agent's behavior — caused a cascade: a false
"another agent is already active here" report from one dispatch, a real agent's in-progress work
misattributed to a different, actually-contaminated dispatch, a wrongful `TaskStop` against the
agent that was doing the task correctly, and that agent's real work destroyed by a `git reset --hard`
run while a second agent was independently still active in the same directory. `isolation:
"worktree"` makes this whole failure class structurally impossible — each dispatch gets its own
directory, so there is no shared state left for the orchestrator to mismanage. Reserve manual
`git worktree add` for work the orchestrator itself does directly (not through the `Agent` tool),
and reserve the shared clone for whichever single task currently owns it.

## Verifying what an agent actually did: query its session log, not git state

When a real decision — stopping an agent, discarding its work, believing a disputed claim about what
it did — depends on knowing exactly what an agent did or did not do, check its own session transcript
(the `.output` JSONL file referenced in its dispatch/notification result), not git state. Git state
is a weak, indirect proxy: a diff shows the *end result* of a sequence of actions, not the sequence
itself, and "no trace of X in the current diff" does not prove "never did X" — especially if a
worktree was later reset or shared with another agent. The transcript is the primary source; git
state is, at best, a secondary inference from it, and inferring backwards from a weaker signal when
a stronger one is directly available is how a real agent got wrongly blamed and stopped on this repo
once already (see above).

The tool result that returns a `.output` path warns not to `Read` or `tail` that file directly via
the shell — it is the agent's full JSONL transcript and can be large enough to overflow context if
ingested whole. That warning is about full-file ingestion, not about the file being off-limits: use
a targeted query instead of reading the whole thing. `Grep` against the file (a specific pattern,
e.g. a filename you want to confirm was or wasn't read) returns only matching lines. `jq` is stronger
still, since the transcript is structured JSONL: filter on fields like `.type`/`.name`/`.input` (e.g.
every `Read` or `Bash` tool call whose input mentions a given path, in order) to get an exact,
ordered answer instead of a pattern-matched guess. This is not something to do routinely — most
questions about a session don't need it — but when a decision is actually going to be based on "did
the agent do X," the transcript is where that gets verified, not inferred.

## Draft PRs and automated review

Taking a PR out of draft is what makes it visible to automated review (this repo has picked up
`chatgpt-codex-connector` review comments on past PRs, sometimes with real, correct findings — see
PR #32's history). CI passing and no requested human reviewers is not the same as "nothing left to
wait for" — un-drafting and merging in the same action gives automated review no window to run at
all. Un-draft, then wait a real interval before merging, even on a change that looks obviously safe.

## Local verification tools

Use `npx tsx` (or the compiled `dist/` only via `npm run build` immediately beforehand) to run or
reproduce TypeScript behavior ad hoc — never invoke stale `dist/` output with plain `node` without
rebuilding first; this project's own history includes a real bug investigation that went sideways
from exactly that stale-build confusion. `tsx` is deliberately not a project dependency, so `npx`
(which fetches it on demand) is the form that actually works in a clean checkout — plain `tsx`
assumes a global install that may not exist.

## `send_later` (self-scheduled check-ins)

Contradicts an earlier note in this file that claimed `send_later` requires manual approval in this
environment — directly observed otherwise: a call this session registered immediately, with no
approval prompt, and was independently confirmed via `list_triggers` (real `trigger_id`, correct
`next_run_at`). Don't carry forward the old claim. The one part of the original note still worth
keeping is the underlying discipline, not the specific claim it was attached to: confirm a
schedule actually registered via `list_triggers` when it matters, rather than trusting the call
succeeded from its return value alone — that's good practice regardless of whether approval friction
exists, not evidence that it does.
