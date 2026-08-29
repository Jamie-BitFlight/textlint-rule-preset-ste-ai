---
name: pre-push-review
description: Runs the way-of-working compliance reviewer against the current change set before a push, a pull request, or a merge. Combines the branch's committed-but-unpushed history with any staged, unstaged, or untracked working-tree edit, so neither half of a pending push goes unreviewed. Use before pushing, opening a pull request, or merging. Also use when asked to check way-of-working compliance.
context: fork
agent: way-of-working-compliance-reviewer
user-invocable: true
---

# Pre-push review

Check the current change set for breaches of this project's own way-of-working rules. Run this
check before the change gets pushed. Run it before the change becomes a pull request. Run it
before the change gets merged.

The rules this check looks for live in a small set of file categories. Each is resolved along the
changed file's own directory ancestry, not only its nearest match:

- `.claude/rules/*.md`
- `.cursor/rules/*.md` and `.cursor/rules/*.mdc`
- `.agents/rules/*.md`
- `AGENTS.md`
- `CLAUDE.md`

## Step 1: Find the change set to review

Build the change set from two sources. Combine both — never only one of them. A branch can carry
committed-but-unpushed commits. It can carry a working-tree edit at the same time too. A push sends
both. Skipping either source lets part of the real push go unreviewed.

**Source A — the branch's own committed history.**

1. Find the current branch with `git branch --show-current`.
2. Find an open pull request for this branch with `gh pr view --json baseRefName`, a read-only
   lookup.
3. Use that pull request's own base branch as the diff base.
4. No open pull request may exist for this branch.
5. Use `git symbolic-ref refs/remotes/origin/HEAD --short` instead, in that case.
6. That resolves the repository's own default branch, such as `origin/main`.
7. Never use the branch's own upstream tracking branch as this base.
8. A branch that tracks its own upstream, fully pushed, diffs against itself as empty.
9. That loses the whole feature diff, even though the pull request still holds it.
10. Use `git diff <base-branch>...HEAD` against whichever base this finds, always.
11. Never use `gh pr diff` as this source.
12. `gh pr diff` only ever reflects what was last pushed to the remote pull request.
13. A local commit made after that push stays invisible to it.
14. `git diff <base-branch>...HEAD` reflects the real local state instead, every local commit
    included.
15. Add whichever diff this finds to the change set.
16. This source can be empty.
17. That happens when the branch is not ahead of that base at all.
18. It is not an error — it just contributes nothing.
19. Neither an open pull request nor a resolvable default branch may exist either.
20. This source is then simply unavailable, the same as if it were empty.

**Source B — the working tree.**

21. Run `git status --short --untracked-files=all`.
22. That command may list staged or unstaged changes.
23. Treat any such changes as part of the change set.
24. Run `git diff HEAD` to capture them.
25. `git diff HEAD` never reports an untracked file.
26. `--untracked-files=all` matters here.
27. Plain `git status --short` lists a wholly untracked directory as one `?? somedir/` line, not
    the files inside it.
28. `--untracked-files=all` instead lists every untracked file inside that directory on its own
    `??` line.
29. `git status --short --untracked-files=all` still lists an untracked file, with a leading `??`.
30. Run `git diff --no-index -- /dev/null <path>` for each such `??` file path.
31. The `--` matters here.
32. Without it, an untracked path starting with `-` (`-dash.md`) parses as an option instead of a
    path.
33. The command fails outright in that case.
34. Add that command's output to the change set too.
35. This source can be empty too.
36. That happens when the working tree is clean.
37. A clean tree is the ordinary state right before a push, a pull request, or a merge.
38. The intended change is already committed by then.
39. An empty working tree is not a reason to skip Source A.

**Combine, or stop.**

40. Combine Source A and Source B into one change set.
41. Report that there is nothing to review, and stop, only when both sources are empty.
42. Do not invent a change set.

## Step 2: Review

Hand the change set from Step 1 to the `way-of-working-compliance-reviewer` agent. This skill's
`agent:` frontmatter forks into it directly. Give it the diff text itself. Do not give it only a
description of the diff.

## Step 3: Report

Relay the agent's bullet-list report verbatim. Do not summarize away a specific citation. The
file path, the rule file, and the one-sentence violation statement are the point of the report.
