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

The rules this check looks for live in a small set of files, each nearest to the changed file:

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
2. Find its upstream, and any pull request open for it.
3. Fetch that pull request's diff with `gh pr diff`, a read-only lookup.
4. No pull request tooling may be available, or no pull request may exist yet.
5. Use `git diff <base-branch>...HEAD` instead, against the branch's merge base.
6. Add whichever diff this finds to the change set.
7. This source can be empty.
8. That happens when the branch is not ahead of that base at all.
9. It is not an error — it just contributes nothing.

**Source B — the working tree.**

10. Run `git status --short --untracked-files=all`.
11. That command may list staged or unstaged changes.
12. Treat any such changes as part of the change set.
13. Run `git diff HEAD` to capture them.
14. `git diff HEAD` never reports an untracked file.
15. `--untracked-files=all` matters here.
16. Plain `git status --short` lists a wholly untracked directory as one `?? somedir/` line, not
    the files inside it.
17. `--untracked-files=all` instead lists every untracked file inside that directory on its own
    `??` line.
18. `git status --short --untracked-files=all` still lists an untracked file, with a leading `??`.
19. Run `git diff --no-index -- /dev/null <path>` for each such `??` file path.
20. The `--` matters: an untracked filename that starts with a dash otherwise parses as an
    option, not a path.
21. Add that command's output to the change set too.
22. This source can be empty too.
23. That happens when the working tree is clean.
24. A clean tree is the ordinary state right before a push, a pull request, or a merge.
25. The intended change is already committed by then.
26. An empty working tree is not a reason to skip Source A.

**Combine, or stop.**

27. Combine Source A and Source B into one change set.
28. Report that there is nothing to review, and stop, only when both sources are empty.
29. Do not invent a change set.

## Step 2: Review

Hand the change set from Step 1 to the `way-of-working-compliance-reviewer` agent. This skill's
`agent:` frontmatter forks into it directly. Give it the diff text itself. Do not give it only a
description of the diff.

## Step 3: Report

Relay the agent's bullet-list report verbatim. Do not summarize away a specific citation. The
file path, the rule file, and the one-sentence violation statement are the point of the report.
