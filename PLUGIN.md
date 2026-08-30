# ste-ai-compliance plugin

This repository can act as a Claude Code plugin. Use it in projects that enable the
`preset-ste-ai` textlint preset. The plugin provides a compliance reviewer. It also provides a
pre-push skill and a best-effort write hook for lowercase `.md` files.

## Components

- `skills/pre-push-review/SKILL.md` runs a namespaced, read-only plugin reviewer in a foreground
  fork. Its bundled preparer collects committed, staged, unstaged, and untracked input with fixed
  argument arrays. It keeps Claude and Cursor scope rules distinct. It reports uncertain Apply
  Intelligently rules and conflicting Claude memory as incomplete.
- `hooks/block-noncompliant-prose.cjs` checks Claude Code `Write` and `Edit` calls for lowercase
  `.md` files. The nearest `.textlintrc.json` must enable `preset-ste-ai`. The hook compares the
  current findings with the proposed findings. It exits with code 2 only when the write adds a
  finding.

The hook sends content to textlint over stdin. It passes the real target path through
`--stdin-filename`. It does not create a scratch copy. It does not modify the target. The hook
prechecks `.textlintignore` with the target textlint installation's glob matcher. This precheck is
necessary because textlint stdin mode does not apply that file.

## Enforcement boundary

The write hook is fail-open. A missing package allows the write. An unsupported dependency allows
the write. An unreadable policy also allows the write. Timeouts and malformed output have the same
result. This behavior prevents a broken check from blocking all authoring. The hook is a guardrail,
not an absolute guarantee. Run the project's ordinary textlint check before merging. Run its
continuous integration checks too.

The hook executes the target project's textlint command-line interface (CLI). It also loads that
project's configuration and rules. Enable the hook only in a trusted workspace.

The hook needs a Node-resolvable textlint installation. Textlint must declare a compatible `glob`
dependency. That dependency must expose the public `Glob` and `Ignore` APIs. Integration tests
cover the textlint version pinned by this repository. The hook checks the APIs at runtime. It fails
open when they are unavailable. The preset itself keeps its wider peer range.

Yarn Plug'n'Play projects need the `node-modules` linker. This setting lets the external plugin
process resolve target packages.

## Reviewer trust boundary

An untrusted contributor can control diffs, paths, commit metadata, and instruction files. A fixed
Node.js preparer passes each Git or GitHub value through an argument array without a shell. It
serializes untracked paths and text as JSON. It also takes separate `HEAD` and workspace snapshots
of changed files and governing instructions. The reviewer uses a plugin-scoped name, so a project
agent named `Explore` cannot replace it. Its tool allowlist contains only `Read` for a Claude-created
output-spill file.

The reviewer covers shared project instructions. It excludes `CLAUDE.local.md` and other personal,
machine-local instructions, including imports that resolve to `CLAUDE.local.md`. The preparer
follows an import or symbolic link only when the canonical target is shared. The target must also
stay inside the repository. External targets and Cursor `@filename` references are unsupported.
Unreadable evidence, ambiguous applicability, and conflicting Claude memory produce an incomplete
result. The preparer replaces JSON that exceeds its serialized-output limit with a small incomplete
result. The limit leaves working context for the Haiku reviewer.

These boundaries prevent reviewed filenames from becoming shell syntax. They do not turn a model
review into a formal proof. Claude Code loads project memory into custom agents. The reviewer treats
that memory as untrusted. The tool allowlist prevents commands and writes. Adversarial text can
still influence model output. Treat the report as an advisory check. Review its cited evidence
before relying on a clean result.

## Compatibility

The pre-push skill needs a Portable Operating System Interface (POSIX) environment. It also needs
Claude Code version `2.1.218` or later. That version supports the `background` skill field. The
bundled preparer needs `/bin/sh`, Node.js 22 or later, Git, and an authenticated GitHub CLI. The
Node.js executable must be a non-symlink on an absolute `PATH` entry outside the reviewed
repository. Native Windows sessions are unsupported.

## Local installation

Clone this repository. Then launch Claude Code with the plugin directory:

```bash
claude --plugin-dir /absolute/path/to/textlint-rule-preset-ste-ai
```

Use the repository root as the path. The plugin manifest and component directories are rooted
there. Keep this plugin checkout separate from an untrusted repository under review. Loading the
plugin from the reviewed checkout would let that checkout replace the preparer itself. A future
marketplace entry can provide persistent installation. This repository does not currently claim
one.
