# Agent instructions

This file lists instructions for AI (artificial intelligence) agents in this repository.

## Documentation hygiene

1. Do not document derivable values as manually maintained facts.
   - Examples include test totals, coverage percentages, file counts, and generated inventories.
   - Include a derivable value only when a live source generates or displays it.
   - This keeps the value accurate automatically.
2. When a human guide needs a derivable value, document the command or procedure that derives it.
   - Do not document the current result.
   - Omit the value and the derivation instructions from documentation for AI agents.
   - Include the derivation only when the agent's task requires it.
3. Before pushing code, review the readme file, project docs, and code comments affected by the change.
   - Also review examples and agent instructions affected by the change.
   - Update stale behavior descriptions.
   - Replace or remove commands, paths, and claims that the change invalidates.
   - Also replace or remove any manually maintained, derivable data that the change invalidates.

## Delegation gotchas

Learned from repeated multi-agent dispatch failures in this session. Read this before dispatching `isolation: "worktree"` agents in bulk.

**Gitignored files do not reach a worktree**. `isolation: "worktree"` builds each worktree from a real git ref. Anything not committed stays in the orchestrator's own checkout, including every file under `.tmp/`. Give a dispatched agent an absolute path back to the orchestrator's checkout instead. That works, because both directories sit on the same host filesystem. A committed file also works, if every dispatch checks out that commit.

**Scratch files must stay inside the repo**. A path outside the repo root needs harness permission. A dispatched agent does not have that permission. Such a path fails, or blocks the task partway through. Use a repo-relative, gitignored path instead, for example `.tmp/scratch/`.

**The concurrent-subagent cap is a hard ceiling**. Check the `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` environment variable for the configured limit. It varies by harness and environment. A dispatch past the cap fails immediately, with an explicit "do not retry" instruction. Queue the remaining dispatches instead. Send the queued dispatches once a slot frees.

**A session-limit failure is shared and retryable**. The account's session limit applies across the orchestrator and every dispatched agent together, not per agent. A dispatched agent can fail mid-task from this, purely because the account is over budget at that moment. This shared-budget failure can hit many parallel agents in the same wave at once. Resume the agent by name through `SendMessage`, once budget returns. Do not redo its work directly. Do not redispatch a fresh agent over one that already made progress.

**The permission classifier can deny a dispatch before it starts**. No agent ID returns in that case. The reason given does not always track the task's actual content. Retrying the identical dispatch has worked in practice.

**A worktree with zero file changes can be cleaned up mid-session**. This auto-cleanup is not limited to an agent's very first stop. The same cleanup can also fire when a resumed but still unedited agent's session ends again. One example is hitting the session limit before the agent's first `Write` or `Edit` call. The agent's own conversation and analysis survive and stay resumable by name. Its worktree directory is gone and needs rebuilding. Run `git worktree add --detach <same-path> <same-commit>` before the agent continues. This is the orchestrator's own direct action, at the same path the same agent already owned. It is not a new `Agent`-tool dispatch. It stays inside CLAUDE.md's exception for orchestrator-performed worktree recovery. This differs from a worktree that has real uncommitted edits destroyed outright. Here, there is nothing to lose but the empty directory. The fix is a simple orchestrator-side rebuild, not a recovery problem.
