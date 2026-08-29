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
2. Find a base branch to diff against.
3. Prefer the branch's own upstream tracking branch.
4. An upstream may not exist.
5. Find an open pull request for this branch instead.
6. `gh pr view --json baseRefName` finds it, with a read-only lookup.
7. Use that pull request's base branch.
8. Use `git diff <base-branch>...HEAD` against that base, always.
9. Never use `gh pr diff` as this source.
10. `gh pr diff` only ever reflects what was last pushed to the remote pull request.
11. A local commit made after that push stays invisible to it.
12. `git diff <base-branch>...HEAD` reflects the real local state instead, every local commit
    included.
13. Add whichever diff this finds to the change set.
14. This source can be empty.
15. That happens when the branch is not ahead of that base at all.
16. It is not an error — it just contributes nothing.
17. Neither an upstream nor an open pull request may exist either.
18. This source is then simply unavailable, the same as if it were empty.

**Source B — the working tree.**

19. Run `git status --short --untracked-files=all`.
20. That command may list staged or unstaged changes.
21. Treat any such changes as part of the change set.
22. Run `git diff HEAD` to capture them.
23. `git diff HEAD` never reports an untracked file.
24. `--untracked-files=all` matters here.
25. Plain `git status --short` lists a wholly untracked directory as one `?? somedir/` line, not
    the files inside it.
26. `--untracked-files=all` instead lists every untracked file inside that directory on its own
    `??` line.
27. `git status --short --untracked-files=all` still lists an untracked file, with a leading `??`.
28. Run `git diff --no-index /dev/null <path>` for each such `??` file path.
29. Add that command's output to the change set too.
30. This source can be empty too.
31. That happens when the working tree is clean.
32. A clean tree is the ordinary state right before a push, a pull request, or a merge.
33. The intended change is already committed by then.
34. An empty working tree is not a reason to skip Source A.

**Combine, or stop.**

35. Combine Source A and Source B into one change set.
36. Report that there is nothing to review, and stop, only when both sources are empty.
37. Do not invent a change set.

## Step 2: Review

Hand the change set from Step 1 to the `way-of-working-compliance-reviewer` agent. This skill's
`agent:` frontmatter forks into it directly. Give it the diff text itself. Do not give it only a
description of the diff.

## Step 3: Report

Relay the agent's bullet-list report verbatim. Do not summarize away a specific citation. The
file path, the rule file, and the one-sentence violation statement are the point of the report.
