---
name: pre-push-review
description: Runs the way-of-working compliance reviewer against the current change set before a push, a pull request, or a merge. Checks staged and uncommitted changes first. Checks the current pull request's diff instead when the working tree is clean. Use before pushing, opening a pull request, or merging. Also use when asked to check way-of-working compliance.
context: fork
agent: way-of-working-compliance-reviewer
user-invocable: true
---

# Pre-push review

Check the current change set for breaches of this project's own way-of-working rules. Run this
check before the change gets pushed. Run it before the change becomes a pull request. Run it
before the change gets merged.

The rules this check looks for live in a small set of files, each nearest to the changed file:

- `.claude/rules/*.md`
- `.cursor/rules/*.md`
- `.agents/rules/*.md`
- `AGENTS.md`
- `CLAUDE.md`

## Step 1: Find the change set to review

1. Run `git status --short -uall`.
2. That command lists staged and unstaged changes.
3. It also lists every untracked file on its own line.
4. Use `-uall` for this.
5. The default untracked-files mode instead collapses a wholly untracked directory to one
   `?? newdir/` line.
6. A collapsed directory line breaks a literal `git diff --no-index /dev/null newdir/` command.
7. No file lives at that exact path.
8. Treat every such change as part of the change set.
9. Treat a tracked change and an untracked change the same way.
10. Run `git diff HEAD` to capture the tracked part of the change set.
11. That command emits nothing for an untracked (`??`) path.
12. Capture each untracked path from step 3 as its own patch instead.
13. Use `git diff --no-index -- /dev/null <path>` for each one.
14. Add every such patch to the change set.
15. Do this once per untracked file.
16. Do not do it once per untracked top-level entry.
17. An untracked directory is not itself a diffable path.
18. The working tree may instead be clean.
19. It may have no staged, unstaged, or untracked entries at all.
20. Fall back to the current pull request's diff in that case.
21. Find the current branch with `git branch --show-current`.
22. Find its upstream, and any pull request open for it.
23. Fetch that pull request's diff, using the repository's own GitHub tooling.
24. No pull request tooling may be available.
25. Use `git diff <base-branch>...HEAD` instead, against the branch's merge base.
26. Neither a working-tree change set nor an open pull request diff may exist.
27. Report that there is nothing to review, and stop, when neither exists.
28. Do not invent a change set.

## Step 2: Review

Hand the change set from Step 1 to the `way-of-working-compliance-reviewer` agent. This skill's
`agent:` frontmatter forks into it directly. Give it the diff text itself. Do not give it only a
description of the diff.

## Step 3: Report

Relay the agent's bullet-list report verbatim. Do not summarize away a specific citation. The
file path, the rule file, and the one-sentence violation statement are the point of the report.
