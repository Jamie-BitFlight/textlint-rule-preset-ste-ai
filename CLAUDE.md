# Working on this repo

## Documentation stays in sync with code — no confirmation needed

Update `README.md`, everything under `docs/`, and doc comments in the same task as any functional
change, without asking first. Stale documentation is never acceptable output — a task that changes
behavior but leaves the docs describing the old behavior is incomplete, not finished-with-a-follow-up.

## Agents share this session's rate limit — retry, don't substitute

A subagent's session/token-limit failure is retryable, not a real task failure — it shares this
session's budget. If the orchestrator can still run tool calls, resume the agent (`SendMessage` to
its agent id) rather than redoing the work directly. The orchestrator has no capability advantage
over an agent, only a higher cost per action — absorbing an agent's work is strictly worse than
retrying it.

## Parallel agents: use `isolation: "worktree"`, never a manually-managed directory

Dispatch every `Agent`-tool call with `isolation: "worktree"`. Do not manually `git worktree add` a
directory and reuse it across separate dispatches — that caused a real incident (misattributed
agent behavior, a wrongful `TaskStop`, real work destroyed by a reset while another agent was still
active in the same directory). `isolation: "worktree"` makes that failure class structurally
impossible, since each dispatch gets its own directory. Reserve manual `git worktree add` for work
the orchestrator does directly, not through `Agent`.

A fresh worktree does not necessarily already sit on the branch or commit the work is meant to build
on — it can default to the repository's default branch. Unless the agent is meant to work directly
off the default branch, its first instruction must be to check out or switch to the specific
commit/branch the task is actually being distributed from.

## Verifying what an agent did: query its session log, not git state

When a decision depends on knowing exactly what an agent did (stop it? discard its work? believe a
disputed claim?), check its session transcript (the `.output` JSONL path from its dispatch/notification
result), not git state — a diff shows only the end result, not the sequence, and can't prove a
negative. The "don't read/tail this file" warning on that path is about full-file ingestion
overflowing context, not the file being off-limits: query it with `Grep` (pattern match) or `jq`
(structured fields — `.type`/`.name`/`.input`) instead of reading it whole.

## Draft PRs and automated review

Un-drafting a PR is what makes it visible to automated review (`chatgpt-codex-connector` on this
repo — see PR #32). Un-draft, then wait a real interval before merging — never merge in the same
action as un-drafting, even on a change that looks obviously safe.

## Local verification tools

Use `npx tsx` (not bare `tsx` — not a project dependency) for ad hoc TypeScript checks, or rebuild
`dist/` immediately before using it. Never run stale `dist/` output with plain `node`.

## `send_later` (self-scheduled check-ins)

Works without approval friction in this environment — verified: a call this session registered
immediately, confirmed via `list_triggers`. Confirm registration via `list_triggers` whenever a
schedule matters, regardless.
