# Working on this repo

## Discover docs and tests before a functional change; reconcile both after — no confirmation needed

Before changing behavior, find what already describes or covers the system being touched: search
`README.md`, `docs/`, and doc comments for references, and search `test/` **and `scripts/ci/`** for
coverage of the same code paths — `.github/workflows/ci.yml` runs `scripts/ci/*.sh` as assertions
separate from `npm test` (e.g. `check-rules-provisional.sh` hard-codes the expected rule count), so
a change that only reconciles `test/` can still leave one of those scripts stale and fail CI. Do
this before writing the change, not after — the discovery is what the post-change reconciliation
checks against.

After the change, treat that discovery list as part of the work, not a follow-up: update or remove
whichever of those docs actually describe the changed behavior, and update or remove whichever of
those tests or CI assertion scripts now assert the old behavior — not every file discovery turned up
regardless of relevance. Definition of done includes removing or updating stale tests, CI assertion
scripts, and documentation, not just adding new ones; a task that changes behavior but leaves a doc,
a test, or a `scripts/ci/*.sh` check describing the old behavior in place is incomplete, not
finished-with-a-follow-up.

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

Exception: if the agent needs to see the orchestrator's own current uncommitted (staged or unstaged)
changes, commit them (or otherwise transfer them) before dispatching — an isolated worktree is built
from a real ref, so uncommitted state does not travel into it on its own, and the agent would
silently evaluate stale code.

A fresh worktree does not necessarily already sit on the branch or commit the work is meant to build
on — it can default to the repository's default branch. Unless the agent is meant to work directly
off the default branch, its first instruction must be to check out the specific source commit the
task is being distributed from — in detached-HEAD state, or on a new branch created at that commit.
Do not tell it to switch to the source branch by name: Git refuses to check out a branch that is
already checked out in another worktree (including the orchestrator's own), which is the common
case when work is being distributed off a branch the orchestrator is actively using.

## Verifying what an agent did: query its session log, not git state

When a decision depends on knowing exactly what an agent did (stop it? discard its work? believe a
disputed claim?), check its session transcript (the `.output` JSONL path from its dispatch/notification
result), not git state — a diff shows only the end result, not the sequence. The "don't read/tail
this file" warning on that path is about full-file ingestion overflowing context, not the file being
off-limits: query it with `Grep` (pattern match) or `jq` (structured fields — `.type`/`.name`/`.input`)
instead of reading it whole.

A positive match is strong evidence (the literal input string is right there). An absent match is
not proof of a negative: indirect access — a shell variable, a glob, a helper script, a child
process — may never put the literal filename in the recorded tool input. Treating "no match" as "did
not happen" can reproduce the same false-negative mistake this section exists to prevent. If a
negative claim actually matters, read the relevant tool calls in full rather than trusting an absent
pattern match.

## Draft PRs and automated review

Un-drafting a PR is what makes it visible to automated review (`chatgpt-codex-connector` on this
repo — see PR #32). Un-draft, then wait a real interval before merging — never merge in the same
action as un-drafting, even on a change that looks obviously safe.

**If the automated reviewer cannot review, substitute a subagent review — never skip the review.**
Codex declines when the account is over its usage limit, replying "You have reached your Codex usage
limits for code reviews" instead of a review; it can also stay silent. Either way the PR has had no
independent look, and merging it means merging unreviewed work.

When that happens, dispatch a subagent to review it before merging:

- **Code changes** — the `dh:code-reviewer` agent, which detects the stack and loads the matching
  `dh:code-review-{stack}` skill (`dh:code-review-typescript` here).
- **Docs and design changes** — a fact-check instead of a code review. Documents in this repo cite
  files and line numbers, and a design doc that misdescribes the code is worse than none, because
  implementers trust it. Ask for every citation to be opened and verified.

Dispatch with `isolation: "worktree"` per the section above, tell the agent to `git checkout --detach`
the PR head commit first, give it the base commit so it can diff, and tell it explicitly that it is
the review of record so it reviews critically rather than confirming. Require the same evidence
discipline the rest of this file demands: cite the file and line, state uncertainty rather than
guessing, and say what was checked when nothing was found — otherwise an empty review is
indistinguishable from no review.

Then address the findings, the same as for a human or Codex review.

## Local verification tools

Use `npx tsx` (not bare `tsx` — not a project dependency) for ad hoc TypeScript checks, or rebuild
`dist/` immediately before using it. Never run stale `dist/` output with plain `node`.

## `send_later` (self-scheduled check-ins)

Works without approval friction in this environment — verified: a call this session registered
immediately, confirmed via `list_triggers`. Confirm registration via `list_triggers` whenever a
schedule matters, regardless.

## Chat tone

Write chat message responses embodying either of the authors Douglas Adams, or Terry Pratchett.
