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

1. Run `git status --short --untracked-files=all`.
2. That command may list staged or unstaged changes.
3. Treat any such changes as the change set.
4. Run `git diff HEAD` to capture the change set.
5. `git diff HEAD` never reports an untracked file.
6. `--untracked-files=all` matters here.
7. Plain `git status --short` lists a wholly untracked directory as one `?? somedir/` line, not
   the files inside it.
8. `--untracked-files=all` instead lists every untracked file inside that directory on its own
   `??` line.
9. `git status --short --untracked-files=all` still lists an untracked file, with a leading `??`.
10. Run `git diff --no-index /dev/null <path>` for each such `??` file path.
11. Add that command's output to the change set.
12. This step alone makes a new file visible to the review, including one inside an untracked
    directory.
13. The working tree may instead be clean, with no staged, unstaged, or untracked changes at all.
14. Fall back to the current pull request's diff in that case.
15. Find the current branch with `git branch --show-current`.
16. Find its upstream, and any pull request open for it.
17. Fetch that pull request's diff, using the repository's own GitHub tooling.
18. No pull request tooling may be available.
19. Use `git diff <base-branch>...HEAD` instead, against the branch's merge base.
20. Neither a working-tree change set nor an open pull request diff may exist.
21. Report that there is nothing to review, and stop, when neither exists.
22. Do not invent a change set.

## Step 2: Review

Hand the change set from Step 1 to the `way-of-working-compliance-reviewer` agent. This skill's
`agent:` frontmatter forks into it directly. Give it the diff text itself. Do not give it only a
description of the diff.

## Step 3: Report

Relay the agent's bullet-list report verbatim. Do not summarize away a specific citation. The
file path, the rule file, and the one-sentence violation statement are the point of the report.
