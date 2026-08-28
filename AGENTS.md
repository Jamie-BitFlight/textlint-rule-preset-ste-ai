# Agent instructions

This file lists instructions for AI (artificial intelligence) agents in this repository. Claude
Code reads `CLAUDE.md`, not this file. So `CLAUDE.md` in this repository is a bare `@AGENTS.md`
import. Every instruction lives here, in one place.

## Documentation hygiene

1. Do not document derivable values as manually maintained facts.
   - Examples include test totals, coverage percentages, file counts, and generated inventories.
   - Include a derivable value only when a live source generates or displays it.
2. When a human guide needs a derivable value, document the command or procedure that derives it.
   - Do not document the current result.
   - Omit the value and the derivation instructions from documentation for AI agents.
   - Include the derivation only when the agent's task requires it.
3. Before pushing code, review the readme file, project docs, and code comments affected by the change.
   - Also review examples and agent instructions affected by the change.
   - Update stale behavior descriptions.
   - Replace or remove commands, paths, and claims that the change invalidates.
   - Also replace or remove any manually maintained, derivable data that the change invalidates.
4. Do not cite a line number as a reference into source code, in a document that gets committed.
   - A line number drifts on the next unrelated edit to that file. The citation is often stale
     before review even finishes, let alone by the time a future reader opens it.
   - Cite a symbol instead: the file path plus the function, type, constant, or export name it
     names. `src/core/runner.ts`'s `runDeterministicRules`, not `runner.ts:44`.
   - No symbol fits some claims — a doc comment's exact wording, an error message, a schema field.
     Quote the identifying text itself instead of pointing at a line.
   - This rule governs a document that gets committed. A line number is fine in chat. It is also
     fine in a dispatched subagent's prompt. Any exchange that does not get checked in is fine too.

Prose-style rules for this repository live in `.claude/skills/ste-ai-prose-style/SKILL.md`.

## A doc that describes runtime behaviour needs an executable pin

A careful sentence is not enough, when a change touches a doc that describes behaviour:

- **Pin the claim. Do not just reword it.** `test/integration/rule-pack.test.ts` is the model. It
  exists to make documentation claims fail CI, not to prove a module works.
- **Generate any exhaustive list.** A claim like "it controls only X, Y and Z" goes stale.
  The next schema change breaks it. Prose can only answer that finding once. Derive the list
  instead. Assert it, as `test/architecture/doc-pack-control-surface.test.ts` does.
- **Grep for the claim before fixing it in one place.** A behavioural assertion is usually
  duplicated. It can appear across `README.md`, `docs/`, and a doc comment near the code.
- **Verify the replacement claim empirically before writing it.** Run the thing.

Review findings can stop converging: each fix draws a new or reshaped one. That is the signal that
the artefact under review is the wrong one. Stop editing the prose. Go fix what makes the prose
unverifiable instead.

## Notice a problem, log it — never silently skip it

**Out of scope for the current change is never a reason to leave a verified problem
unrecorded.**

Fixing an unrelated pull request (PR) is one place this comes up. Work on one task can
surface a confirmed problem outside that task's scope. A pre-existing test
failure. A stale doc. A lint error unrelated to the current diff. A design gap. A security
concern. File it before moving on:

1. Confirm the problem is real and pre-existing.
   - Check it against `git show HEAD:<path>` before attributing it elsewhere.
   - A `git stash` also works, for a change not yet committed.
2. Open a GitHub issue.
   - Name the file and line.
   - Quote the exact error or symptom.
   - State how it was found.
   - Give a reproduction command.
   - Use the `bug` label, or the closest fit.
3. Reference the new issue number from wherever the discovery happened.
   - A PR comment works. A commit message works too.
4. Do not fix it inline as part of the unrelated change.
   - An exception applies only when the fix is small and safe.
   - The fix must also sit directly next to work already touching that exact file.
   - This matches the general rule against widening a change beyond what was asked.

## Discover docs and tests before a functional change

Before changing behavior, find what already describes or covers the system being touched. Search
`README.md`, `docs/`, and code comments for references. Search `test/` **and `scripts/ci/`** for
coverage of the same code paths — `.github/workflows/ci.yml` runs `scripts/ci/*.sh` as assertions,
separate from the test suite. A change that only reconciles `test/` can still leave one of those
scripts stale, and that leaves CI broken. Do this search before writing the change, not after — the
discovery is what the post-change reconciliation checks against.

After the change, treat that discovery list as part of the work. It is not a follow-up task. Update
or remove whichever of those docs actually describe the changed behavior. Update or remove whichever
of those tests or CI assertion scripts now assert the old behavior. Update only the files the change
actually affects, not every file discovery turned up. Definition of done includes removing or
updating stale tests, CI assertion scripts, and documentation. It is not enough to only add new ones.

## Delegation gotchas

Read this before dispatching subagents in bulk.

### Use `isolation: "worktree"` for every dispatch

Give every `Agent`-tool call `isolation: "worktree"`. Do not manually run `git worktree add`. Do not
reuse that directory across separate dispatches. A prior incident shared one worktree directory
across two agents. The result was misattributed agent behavior, a wrongful `TaskStop`, and real
work destroyed by a reset.
`isolation: "worktree"` rules this out. Each dispatch gets its own directory. Reserve manual
`git worktree add` for work the orchestrator does directly. Never use it through `Agent`.

Exception: an agent needs to see the orchestrator's own uncommitted changes. Those changes need
committing first, or transferring some other way. A worktree builds from a real git ref.
Uncommitted state does not travel into it on its own.

A fresh worktree does not sit on the source branch by default. It can default to the repository's
main branch instead. Tell a dispatched agent to check out the source commit the task builds on. Do
not name the source branch instead. Use detached-HEAD (a checkout with no branch attached) state, or
a new branch created at that commit. Git refuses to check out a branch already checked out in
another worktree, including the orchestrator's own. That is the common case when work is
distributed off a branch the orchestrator is actively using.

### Gitignored files do not reach a worktree

`isolation: "worktree"` builds each worktree from a real git ref. Anything not committed stays in
the orchestrator's own checkout, including every file under `.tmp/`. Give a dispatched agent an
absolute path back to the orchestrator's checkout instead. A committed file also works, if every
dispatch checks out that commit.

### Scratch files must stay inside the repository

A path outside the repository root needs harness permission, which a dispatched agent does not
have. Use a repository-relative, gitignored path instead, for example `.tmp/scratch/`.

### The concurrent-subagent cap is a hard ceiling

Check the `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` environment variable for the configured limit. A
dispatch past the cap fails immediately, with an explicit "do not retry" instruction. Queue the
remaining dispatches instead. Send the queued ones once a slot frees.

### A session-limit failure is shared and retryable

A subagent's session-limit or token-limit failure is retryable. It is not a real task failure. It
shares this session's budget. The account's session limit applies across the orchestrator and every
dispatched agent together, not per agent. A dispatched agent can fail mid-task purely because the
account is over budget at that moment.

Resume the agent by name through `SendMessage`, once budget returns, if the orchestrator can still
run tool calls. Do not redo its work directly. Do not redispatch a fresh agent over one that already
made progress. The orchestrator has no capability advantage over an agent, only a higher cost per
action. Absorbing an agent's work is strictly worse than retrying it.

### The permission classifier can deny a dispatch before it starts

No agent identifier returns in that case, and the reason given does not always track the task's
actual content. Retrying the identical dispatch has worked in practice.

### A worktree with zero file changes can be cleaned up mid-session

This automatic cleanup is not limited to an agent's very first stop. It can also fire when a
resumed but still unedited agent's session ends again. Hitting the session limit before the
agent's first `Write` or `Edit` call is one example. The agent's own conversation and analysis
survive, and stay resumable by name. Its worktree directory is gone, though, and needs rebuilding.

Run `git worktree add --detach <same-path> <same-commit>` before the agent continues. This is the
orchestrator's own direct action, at the same path the same agent already owned. It is not a new
`Agent`-tool dispatch. So it stays inside the exception above for orchestrator-performed worktree
recovery. This differs from a worktree that has real uncommitted edits destroyed outright. Here,
there is nothing to lose but the empty directory.

## Verifying what an agent did: query its session log, not git state

A decision can depend on knowing exactly what an agent did. Stop it? Discard its work? Believe a
disputed claim? Check its session transcript for that, not git state. That transcript is the
`.output` file in JSONL (JSON Lines) format, from its dispatch or notification result. A diff shows
only the end result, not the sequence that produced it. The "do not read or tail this file" warning
on that path is about full-file ingestion overflowing context. The file itself is not off-limits.
Query it with `Grep`, a pattern match. Or query it with `jq`, on structured fields like `.type`,
`.name`, and `.input`. Do not read the whole file.

A positive match is strong evidence. The literal input string is right there. An absent match is
not proof of a negative, though. Indirect access can hide the real evidence: a shell variable, a
glob, a helper script, a child process. None of these may put the literal filename in the recorded
tool input. Read the relevant tool calls in full instead, when a negative claim actually matters.
Do not trust an absent pattern match alone.

## Draft pull requests and automated review

Un-drafting a pull request is what makes it visible to automated review. That reviewer is
`chatgpt-codex-connector` on this repository — see pull request #32. Un-draft, then wait a real
interval before merging. Never merge in the same action as un-drafting. This holds even on a change
that looks obviously safe.

**Independent review is required before every merge.** It does not depend on the external reviewer
being available. The routes below satisfy the requirement equally: the automated external
reviewer, or a local subagent review. Merging with neither is never acceptable.

The external reviewer fails in more than one way, and one of them is quiet. It declines when the account is over its usage limit. It then replies with a usage-limit message
instead of a review. That failure is visible. It can also simply stay silent, which is easy to
read as approval. Treat both as "no
review has happened." Check for a real review. Do not check only for the absence of complaints.

Dispatch a subagent before merging, when the external reviewer has not produced one:

- **Code changes** — the `dh:code-reviewer` agent. It detects the stack and loads the matching
  `dh:code-review-{stack}` skill, `dh:code-review-typescript` here.
- **Docs and design changes** — a fact-check instead of a code review. Documents in this repository
  cite files and line numbers. A design doc that misdescribes the code is worse than none, because
  implementers trust it. Ask for every citation to be opened and verified.
- **Substantial or risky changes** — a set of reviewers rather than one, via
  `dh:multi-perspective-review`. It runs security, quality, performance, and accessibility
  perspectives in parallel. It returns a verdict per perspective. One reviewer sees one way.
  Several reviewing independently is the point.

Dispatch with `isolation: "worktree"` per the section above. Tell the agent to `git checkout
--detach` the pull request head commit first. Give it the base commit, so it can diff. Tell it
explicitly that it is the review of record, so it reviews critically rather than confirming.
Require the same evidence discipline the rest of this file demands. Cite the file and line. State
uncertainty rather than guessing. Say what was checked when nothing was found. An empty review is
otherwise indistinguishable from no review at all.

Then address the findings, the same as for a human or Codex review.

## Local verification tools

Use `npx tsx` for ad hoc TypeScript checks. Bare `tsx` is not a project dependency. Or rebuild
`dist/` immediately before using it. Never run stale `dist/` output with plain `node`.

**Use the repository-pinned Vite+ toolchain.** Do not use a standalone formatter, linter, compiler,
or test command. Once `node_modules/.bin/vp` exists, use `vp check`, `vp test`, and `vp pack`.
Never use a bare `vitest`, `oxlint`, or `tsc`. Never use `npm test` — this repository has no such
script. Bare `vitest` can also discover `vite.config.ts` and run the suite. But `vp` is the
supported wrapper the toolchain is pinned around. Going around it forfeits what `vp` adds on top.
That includes its own bundled Vitest version resolution, the `check` and `pack` integration, and
`vp staged`. A
fresh worktree has no `node_modules`. Run `vp install --frozen-lockfile` there instead. An
alternative: invoke the main checkout's pinned `vp` binary by path, rather than installing a second
copy.

**Bootstrapping `vp` itself, from nothing.** `vp install` is the `vp` command-line interface's own
subcommand. It cannot run before `node_modules/.bin/vp` exists, and this environment has no global
`vp`. The one correct use of `npx` in this repository is to fetch that first binary. Read the
pinned version from `package.json`'s `devDependencies.vite-plus`. Then run `npx -p vite-plus@<that
version> vp install --frozen-lockfile` from the repository root. Verify with `git diff
package-lock.json`, which must be empty under `--frozen-lockfile`, and with `node_modules/.bin/vp
toolchain`. Do not fall back to `npm ci` or `npm install` for this step. They produce a working
`node_modules`, but they skip whatever `vp install` does beyond dependency resolution. See `vp
config` below.

**Pre-commit formatting and linting run through `vp`'s own hook dispatcher, not Husky.** This
repository has no Husky dependency. `vite.config.ts`'s `staged` block defines what runs.
`.vite-hooks/pre-commit` is committed, and it invokes `vp staged`, which reads that block. The
generated dispatcher itself, `.vite-hooks/_`, is gitignored and local to the machine. `npm
install`'s `prepare` lifecycle script calls `vp config` to reinstall it. So a fresh clone activates
hooks automatically. Never hand-edit `.vite-hooks/_`. Change `.vite-hooks/pre-commit` or the
`staged` block instead. Run `vp hooks status` to confirm `core.hooksPath` points at the dispatcher,
before trusting that a commit was checked.

## `send_later` (self-scheduled check-ins)

This works without approval friction in this environment. Confirm registration via `list_triggers`
whenever a schedule matters.

## Chat tone

Write chat message responses embodying either of the authors Douglas Adams, or Terry Pratchett.
