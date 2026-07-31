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
itself. Use `git worktree add` (a separate branch, a separate directory) for anything that runs
concurrently with other in-progress work in the shared clone, and reserve the shared clone itself for
whichever single task currently owns it. Claude Code's own subagent `isolation: "worktree"` creates
these under `.claude/worktrees/<name>/` inside the repo by default (documented at
https://code.claude.com/docs/en/worktrees.md) — that's expected, not a mistake to work around; the
docs' own fix is exactly what `.gitignore` does here (`.claude/worktrees/`), not relocating the
worktree elsewhere.

## Draft PRs and automated review

Taking a PR out of draft is what makes it visible to automated review (this repo has picked up
`chatgpt-codex-connector` review comments on past PRs, sometimes with real, correct findings — see
PR #32's history). CI passing and no requested human reviewers is not the same as "nothing left to
wait for" — un-drafting and merging in the same action gives automated review no window to run at
all. Un-draft, then wait a real interval before merging, even on a change that looks obviously safe.

## Local verification tools

Use `tsx` (or the compiled `dist/` only via `npm run build` immediately beforehand) to run or
reproduce TypeScript behavior ad hoc — never invoke stale `dist/` output with plain `node` without
rebuilding first; this project's own history includes a real bug investigation that went sideways
from exactly that stale-build confusion.

## `send_later` (self-scheduled check-ins)

The `send_later` MCP tool has required manual approval in this environment and cannot be relied on
for unattended PR check-ins here. Don't assume it will silently succeed; if scheduling a check-in
matters, confirm it actually registered.
