# Working on this repo

## Discover docs and tests before a functional change, then reconcile both after — no confirmation needed

Before changing behavior, find what already describes or covers the system being touched. Search
`README.md`, `docs/`, and doc comments for references. Search `test/` **and `scripts/ci/`** for
coverage of the same code paths. `.github/workflows/ci.yml` runs `scripts/ci/*.sh` as assertions
separate from `npm test`. For example, `check-rules-provisional.sh` hard-codes the expected rule
count. A change that only reconciles `test/` can still leave one of those scripts stale. A stale
script then fails continuous integration (CI). Do this discovery before writing the change, not
after. The discovery is what the post-change reconciliation checks against.

After the change, treat that discovery list as part of the work, not as a follow-up. Update or
remove whichever of those docs actually describe the changed behavior. Update or remove whichever
of those tests or CI assertion scripts now assert the old behavior. Do not update every file the
discovery turned up — update only the ones the change actually affects. Definition of done includes
removing or updating stale tests, CI assertion scripts, and documentation. Definition of done is not
just adding new ones. A task might change behavior. It might still leave a doc, a test, or a
`scripts/ci/*.sh` check describing the old behavior. That task is incomplete. It is not
finished-with-a-follow-up.

## Agents share this session's rate limit — retry, do not substitute

A subagent's session-limit or token-limit failure is retryable, not a real task failure. The
subagent shares this session's overall budget. If the orchestrator can still run tool calls, resume the agent instead of
redoing the work directly. Resume it with `SendMessage` to its agent id. The orchestrator has no
capability advantage over an agent. The orchestrator only has a higher cost per action. Absorbing an
agent's work is strictly worse than retrying it.

## Parallel agents: use `isolation: "worktree"`, never a manually-managed directory

Dispatch every `Agent`-tool call with `isolation: "worktree"`. Do not manually `git worktree add` a
directory. Do not reuse that directory across separate dispatches. That mistake caused a real
incident. The incident misattributed agent behavior, issued a wrongful `TaskStop`, and destroyed
real work. A reset ran while another agent was still active in the same directory. Setting
`isolation: "worktree"` makes that failure class structurally impossible. Each dispatch gets its own
directory. Reserve manual `git worktree add` for work the orchestrator does directly. Do not use manual
`git worktree add` through `Agent`.

Exception: if the agent needs to see the orchestrator's own current uncommitted changes, commit them
before dispatching. The uncommitted changes can be staged or unstaged. You can also transfer them
another way instead of committing. An isolated worktree is built from a real ref. Uncommitted state
does not travel into a new worktree on its own. Without transferring it first, the agent would
silently evaluate stale code.

A fresh worktree does not necessarily sit on the branch or commit the work is meant to build on. It
can default to the repository's default branch instead. Unless the agent is meant to work directly
off the default branch, give it one first instruction. That instruction must be to check out the
specific source commit the task is being distributed from. Git's pointer to the current commit
(HEAD) can be detached from any branch. Check out that commit in a detached HEAD state, or on a new
branch created at that commit. Do not tell the agent to switch to the source branch by name. Git refuses to check
out a branch that is already checked out in another worktree. That includes the orchestrator's own
worktree. This is the common case when work is distributed off a branch the orchestrator is actively
using.

## Verifying what an agent did: query its session log, not git state

Some decisions depend on knowing exactly what an agent did. Should you stop it? Should you discard
its work? Should you believe a disputed claim? For those decisions, check its session transcript,
not git state. The session transcript is the `.output` JSON Lines (JSONL) path from its dispatch
result or notification result. A diff shows only the end result, not the sequence of actions.

The warning that says not to read or tail this file is about full-file ingestion overflowing
context. It is not about the file being off-limits. Query it with `Grep` for pattern matching, or
with `jq` for structured fields such as `.type`, `.name`, and `.input`. Use either instead of
reading the whole file.

A positive match is strong evidence. The literal input string is right there. An absent match is
not proof of a negative. Indirect access can hide the literal filename from the recorded tool
input. Examples of indirect access include a shell variable, a glob, a helper script, or a child
process. Treating a "no match" result as "did not happen" can reproduce a false-negative mistake.
This section exists to prevent that mistake. If a negative claim actually matters, read the relevant
tool calls in full. Do not trust an absent pattern match alone.

## Draft pull requests and automated review

Un-drafting a pull request (PR) is what makes it visible to automated review. The reviewer on this
repo is `chatgpt-codex-connector`. See PR #32 for an example. Un-draft the PR, then wait a real
interval before merging. Never merge in the same action as un-drafting. Do this even on a change
that looks obviously safe.

**Independent review is required before every merge.** It is not a courtesy. It is not conditional
on the external reviewer being available. Two routes satisfy the requirement equally: the automated
external reviewer, or a local subagent review. Merging with neither review is never acceptable.

The external reviewer fails in two ways. One of those ways is quiet. The visible failure happens
when the account is over its usage limit. In that case, the external
reviewer sends a reply. That reply reads "You have reached your Codex usage limits for code
reviews" instead of an actual review. The quiet failure happens
when the external reviewer simply stays silent. Silence is easy to misread as approval. Treat both failures as "no review has happened."
Check for a real review rather than for the absence of complaints.

When the external reviewer has not produced one, dispatch a subagent before merging:

- **Code changes**: use the `dh:code-reviewer` agent. It detects the stack and loads the matching
  `dh:code-review-{stack}` skill. In this repo, that skill is `dh:code-review-typescript`.
- **Docs and design changes**: use a fact-check instead of a code review. Documents in this repo
  cite files and line numbers. A design doc that misdescribes the code is worse than no design doc,
  because implementers trust the design doc. Ask for every citation to be opened and verified.
- **Substantial or risky changes**: use a set of reviewers rather than one. Run
  `dh:multi-perspective-review`. It runs security, quality, performance, and accessibility
  perspectives in parallel. It returns a verdict for each perspective. One reviewer sees one way.
  Several reviewers reviewing independently is the point of review. That is what the external
  reviewer cannot offer.

Dispatch the review with `isolation: "worktree"`, per the section above. Tell the agent to
`git checkout --detach` the PR head commit first. Give the agent the base commit, so it can diff
the PR head commit against the base commit. Tell the agent explicitly that it is the review of record. Being the review of record
means it must review critically, not confirm. Require the same evidence discipline the rest of this
file demands. Cite the file name and the line number for every finding. State uncertainty rather than guessing. Say
what was checked when nothing was found. Without that, an empty review is indistinguishable from no
review.

Then address the findings, the same as for a human or Codex review.

## Local verification tools

Use `npx tsx` for ad hoc TypeScript checks. Do not use bare `tsx` — it is not a project dependency.
As an alternative, rebuild `dist/` immediately before using it. Never run stale `dist/` output with
plain `node`.

**Use the repository-pinned Vite+ toolchain.** Do not use a standalone formatter, linter, compiler,
or test command. Once `node_modules/.bin/vp` exists, use `vp check`, `vp test`, and `vp pack`. Never
use a bare `vitest`, `oxlint`, or `tsc` command. Never use `npm test` — this repo defines no such
script. Bare `vitest` can also discover `vite.config.ts` and run the suite. The rule is not that it
cannot do this. The rule is that `vp` is the supported wrapper the toolchain is pinned around. Going
around `vp` forfeits whatever it adds on top. That includes its own bundled Vitest version
resolution, the integration between `check` and `pack`, and `vp staged`. A fresh worktree has no
`node_modules`. In a fresh worktree, run `vp install --frozen-lockfile`. Or invoke the main
checkout's pinned `vp` binary by path, instead of installing a second copy.

**Bootstrapping `vp` itself, from nothing.** `vp install` is the `vp` CLI's own subcommand. It
cannot run before `node_modules/.bin/vp` exists. This environment also has no global `vp`. The one
correct use of `npx` in this repo is to fetch that first binary. Read the pinned version from
`package.json`'s `devDependencies.vite-plus`. Then run
`npx -p vite-plus@<that version> vp install --frozen-lockfile` from the repo root. That command
installs through `vp`'s own resolver into the real `node_modules`. Verify the install with
`git diff package-lock.json`. That diff must be empty under `--frozen-lockfile`. Also verify with
`node_modules/.bin/vp toolchain`. Do not fall back to `npm ci` or `npm install` for this step. They
produce a working `node_modules`, but they skip whatever `vp install` does beyond dependency
resolution. See `vp config`, below, for what that extra step covers. Using `npm ci` or `npm install`
here is exactly the standalone command this rule exists to prevent.

**Pre-commit formatting and linting run through `vp`'s own hook dispatcher, not Husky.** This repo
has no Husky dependency. `vite.config.ts`'s `staged` block defines what runs. `.vite-hooks/pre-commit`
is committed. It invokes `vp staged`, which reads that block. The generated dispatcher itself,
`.vite-hooks/_`, is gitignored and machine-local. `npm install`'s `prepare` lifecycle script runs
`vp config` to reinstall it. That way, a fresh clone activates hooks automatically. Never hand-edit
`.vite-hooks/_`. Change `.vite-hooks/pre-commit` or the `staged` block instead. Then run
`vp hooks status` to confirm `core.hooksPath` actually points at the dispatcher. Do this before
trusting that a commit was checked.

## `send_later` (self-scheduled check-ins)

`send_later` works without approval friction in this environment. This was verified: a call this
session registered immediately, confirmed via `list_triggers`. Confirm registration via
`list_triggers` whenever a schedule matters, regardless.

## Chat tone

Write chat message responses embodying either of the authors Douglas Adams, or Terry Pratchett.
