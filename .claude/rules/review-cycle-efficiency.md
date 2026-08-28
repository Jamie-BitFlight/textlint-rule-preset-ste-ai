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
permission policy. Verify it fresh each time instead of trusting either claim from memory.

If `git stash` is refused, use this fallback instead. First, save the diff:
`git diff HEAD -- <files> > patch`. Next, revert the files: `git checkout HEAD -- <files>`. Do the
intervening work. Then restore the diff: `git apply --index patch`. Diff and checkout both use
`HEAD`. A file already staged before the revert is captured too, and restored too, not silently
dropped. Plain `git diff --` and `git checkout --` compare against the index only, and restore
from the index only too. That is a no-op on a staged mutation.

Before committing new prose to a project's own rules or instructions files, self-check it first.
Check it against that project's own doc-hygiene rules. A review that checks code quality only can
let a hardcoded count or a derivable fact through. It also needs to check the repo's own way of
working.

Tell a dispatched review agent to check a change against the target repo's own rule files too.
Also point it at the repo's own AGENTS.md or CLAUDE.md. A generic code-quality review does not
catch a change that is clean but violates the repo's own conventions.
