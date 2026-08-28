# Review-cycle gotchas

An anomalous mutation-test pass is the bug report, even for an "unrelated" mutation. Fix the
assertion immediately. Do not shelve it for a narrower mutation that happens to fail.

Fetch opaque GitHub IDs, such as a comment or thread ID, immediately before use. Never use one
from memory. Grep a file for an identifier before binding a new top-level `const` or `function`
with that name.

Dispatch a plan's independent nodes as parallel `isolation: "worktree"` agents from the start of
the wave.

Try `git stash push -u` first. Do not assume it is blocked. An earlier note here called it
blocked. That turned out to be wrong at the time. Whether it works can vary by environment and
permission policy. Verify it fresh each time instead of trusting either claim from memory. Do the
intervening work once it succeeds. Then run `git stash pop --index` to restore what it hid. Plain
`git stash pop`, without `--index`, drops a staged file back to merely modified. A file with both
staged and unstaged changes needs `--index` to come back exactly as it was, not just to come back.

If `git stash` is refused, use this fallback instead. First, save two separate diffs, not one:
`git diff --cached -- <files> > staged.patch` for what was staged, and
`git diff -- <files> > unstaged.patch` for what was not. Next, revert the files:
`git checkout HEAD -- <files>`. Do the intervening work. Then restore both, in this order:
`git apply --allow-empty staged.patch`, then `git add -- <files>`, then
`git apply --allow-empty unstaged.patch`. A single combined patch from `git diff HEAD` loses that
split instead. Restoring it with `git apply --index` does too. Verified directly: a file staged and
then further modified came back merely staged, not staged-and-modified. `git stash pop` without
`--index` causes the same loss. `--allow-empty` matters too. It keeps either apply from failing
outright. A file with only one kind of change leaves its other patch empty.

Before committing new prose to a project's own rules or instructions files, self-check it first.
Check it against that project's own doc-hygiene rules. A review that checks code quality only can
let a hardcoded count or a derivable fact through. It also needs to check the repo's own way of
working.

Tell a dispatched review agent to check a change against the target repo's own rule files too.
Also point it at the repo's own AGENTS.md or CLAUDE.md. A generic code-quality review does not
catch a change that is clean but violates the repo's own conventions.
