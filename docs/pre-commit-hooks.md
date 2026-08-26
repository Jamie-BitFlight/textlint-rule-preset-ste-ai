# Pre-commit hooks

This package ships a `.pre-commit-hooks.yaml` manifest at its repository root. The Python
`pre-commit` framework and `prek` both consume that manifest directly. Husky has no manifest
format. It runs a shell script instead. All three need the same one prerequisite.

## Prerequisite: install the package locally

Every path below assumes `textlint-rule-preset-ste-ai` is already a `devDependency` of the project
being linted:

```bash
vp install --save-dev textlint textlint-rule-preset-ste-ai
```

None of these hook integrations install the package for you. `entry: npx --yes …` falls back to
fetching it from the npm registry on demand. That means the first commit in a fresh clone pays a
network fetch. A CI runner without registry access fails outright. Installing it as a real
`devDependency` keeps every commit fast, offline, and locked to your lockfile. This is the same
reason the CLI's deterministic rules never touch the network, extended to the hook's own
installation.

## Python `pre-commit` and `prek`

```yaml
# .pre-commit-config.yaml — prek reads the same file format
repos:
  - repo: https://github.com/Jamie-BitFlight/textlint-rule-preset-ste-ai
    rev: <latest release tag> # e.g. v1.2.3 — see the repository's Releases page
    hooks:
      - id: ste-ai
```

`rev` must point at a published release tag, not a branch. `pre-commit` resolves and pins `rev`
once, at `pre-commit install` or first run. It never re-resolves the tag on its own. Run
`pre-commit autoupdate` to move the pin forward later. See
[`docs/publishing.md`](publishing.md) for how releases are tagged.

This pulls the hook **manifest** from this repository over git. The manifest declares
`language: system`, so `pre-commit` runs `entry` directly. It does not clone, build, or install
this package from git to do that. The linter itself always comes from your own `node_modules`,
resolved by `npx`, per the prerequisite above.

### Why not `language: node`?

`.pre-commit-hooks.yaml` deliberately avoids `language: node` with `additional_dependencies`. That
is the pattern behind, for example, `pre-commit/mirrors-prettier`. Two things about this package
rule it out:

- `language: node` builds the hook's environment from this repository's own `git+file://` source.
  That needs every `devDependency` installed (`vite-plus`, to run `vp pack`), then the build run,
  inside `pre-commit`'s own managed node environment. That works with `prek`, which stages the
  build with `npm pack` before installing. It does not work with the Python `pre-commit`
  framework's own `npm install -g … --install-links` invocation. Verified: `dist/` never gets
  built on that path. The hook fails with `Executable ste-ai not found`.
- Adding `additional_dependencies: ["textlint-rule-preset-ste-ai@<version>"]` does not route
  around that. `pre-commit`'s `language: node` still also installs this repository's own
  `git+file://` source alongside it. The hook repository has both a `.git` directory and a
  `package.json` at its root. Two installs of the identically named package then collide in the
  same global `node_modules/textlint-rule-preset-ste-ai` directory. Verified: the install fails
  with `ENOTEMPTY`.

`language: system` sidesteps both failure modes. It executes `npx`, backed by your own
`node_modules`. There is no environment left for `pre-commit` to build. A future version of this
package could ship `.pre-commit-hooks.yaml` from a separate mirror repository instead. That mirror
would carry its own placeholder `package.json`, the way `mirrors-prettier` does. `language: node`
would become viable again then. It is not viable today.

### Only lint staged files

`pre-commit` already restricts `entry` to the files it detects as changed, or to every file on
`--all-files` by request. `types_or: [markdown, plain-text]` in the manifest is what selects
`.md` and `.txt` files for you. No extra configuration is needed for that. It is the default
`pre-commit` behaviour for any hook.

## Husky

Husky has no hook manifest, and no built-in staged-file filtering. `.husky/pre-commit` is a plain
shell script. It runs on every commit, unfiltered, unless the script filters it itself.

```sh
# .husky/pre-commit
files=$(git diff --cached --name-only --diff-filter=ACMR -- '*.md' '*.txt')
[ -z "$files" ] && exit 0
npx --yes textlint-rule-preset-ste-ai lint --fail-on-review $files
```

`git diff --cached --name-only` lists staged files. `--diff-filter=ACMR` keeps only files that
were added, copied, modified, or renamed. A staged deletion is never passed to a tool that expects
the file to exist. `[ -z "$files" ]` skips the run entirely when nothing staged matches. A commit
that touches only code is not slowed down.

Do not write `npx --yes textlint-rule-preset-ste-ai lint docs/**/*.md` instead.
`.husky/pre-commit` runs under `sh`, not an interactive `bash` with `shopt -s globstar` set. Under
`sh`, `**` is not a recursive glob. It matches at most one directory level. `docs/**/*.md` then
silently misses a file directly in `docs/`, while still catching one in `docs/sub/`. The
staged-files form above never builds a glob at all, so this problem never comes up.

## Both: the exit code contract

Every integration above relies on the same [documented exit codes](configuration.md#cli):

- `0` — clean
- `1` — errors present (review-required counts too, with `--fail-on-review`)
- `2` — a usage error
- `3` — an infrastructure-level run notice

A hook that drops `--fail-on-review` still blocks on `1`. It then blocks only for
`error`-severity findings. See [`docs/diagnostic-policy.md`](diagnostic-policy.md) for what
separates the two.

## Troubleshooting

**`Executable ste-ai not found` (Python `pre-commit` only).** The hook manifest resolved, but
`npx` could not find or fetch the binary. Confirm `textlint-rule-preset-ste-ai` is listed in the
target project's `package.json`, and that `node_modules/.bin/ste-ai` exists there. That is the
prerequisite step above. The hook manifest cannot do it on your behalf.

**A commit is far slower than expected, or fails offline.** `npx --yes` is falling through to a
registry fetch. Either the prerequisite step was skipped, or `node_modules` is missing from this
checkout. That happens on a fresh CI checkout, or a clean clone. Run the install step first.

**A vendored or generated directory shows up in the findings.** `pre-commit` and Husky only see
files git already tracks. A properly `.gitignore`d directory is never passed to the hook —
`node_modules/`, or `dist/`. If one still shows up, it was tracked by git. Fix the `.gitignore`.
Alternatively, add `exclude: ^path/to/dir/` to the hook entry in `.pre-commit-config.yaml`.
