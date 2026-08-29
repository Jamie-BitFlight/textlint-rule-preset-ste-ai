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

If `git stash` is refused, use this fallback. Scope it to an already-tracked, non-binary file
only.

`git stash push -u` already handles a new or a binary file correctly. Exhaust that path first.
Escalate to a human for either case, instead of extending this fallback.

Save two separate diffs, not one. Store them in the gitignored `.tmp/scratch/` directory. Never
store them inside `<files>` itself. A patch file inside that selection gets caught up in the
checkout and apply steps below.

Run `mkdir -p .tmp/scratch` first. A fresh clone or worktree has no `.tmp/` directory yet. A shell
redirection into a missing directory fails outright, before the command behind it ever runs.

Run `git diff --cached -- <files> > .tmp/scratch/staged.patch` for what was staged. Run
`git diff -- <files> > .tmp/scratch/unstaged.patch` for what was not. Then revert the files with
`git checkout HEAD -- <files>`. Do the intervening work.

Restore both, in this order. Run `git apply --index --allow-empty .tmp/scratch/staged.patch`
first. Run `git apply --allow-empty .tmp/scratch/unstaged.patch` second.

Use `git apply --index` on the staged patch itself. Do not follow it with a broad
`git add -- <files>`. The intervening work can touch other files under the same path. A broad add
stages that unrelated work too, not just the restored patch. Verified directly: an unrelated file
touched during the intervening step came back staged under the broad-add version. `git apply
--index` on just the staged patch left that file correctly unstaged instead.

A single combined patch from `git diff HEAD` loses the staged-and-unstaged split. Restoring it
with a plain `git apply --index` loses that split too. Verified directly: a file staged and then
further modified came back merely staged, not staged and modified. Plain `git stash pop`, without
`--index`, causes the same loss.

`--allow-empty` matters too. It keeps either apply from failing outright. A file with only one
kind of change leaves its other patch empty.

Delete both scratch patch files once restoration succeeds.

Before committing new prose to a project's own rules or instructions files, self-check it first.
Check it against that project's own doc-hygiene rules. A review that checks code quality only can
let a hardcoded count or a derivable fact through. It also needs to check the repo's own way of
working.

Tell a dispatched review agent to check a change against the target repo's own rule files too.
Also point it at the repo's own AGENTS.md or CLAUDE.md. A generic code-quality review does not
catch a change that is clean but violates the repo's own conventions.
