# ste-ai-compliance plugin

This repository is also a Claude Code plugin. It gives an agent three things. Each thing helps in
a project that uses the `preset-ste-ai` textlint preset. The first thing is a compliance-reviewing
agent. The second is a pre-push skill that runs it. The third is a hook that enforces the preset
in advance.

## What it provides

- **`agents/way-of-working-compliance-reviewer.md`** — a haiku-model agent. It reviews a diff. The
  diff can be a pull request diff. It can also be the current staged and unstaged changes. The
  agent walks each changed file's directory ancestry. It gathers every governing rule file along
  that ancestry, not only the nearest one. A deeper file's instruction wins only an actual
  conflict with a shallower file. It reports breaches as a terse bullet list. It does not perform
  a general code review.
- **`skills/pre-push-review/SKILL.md`** — a user-invocable skill. It uses `context: fork`. It
  finds the current change set. It forks into the agent above. It relays that agent's report. It
  combines two sources — the branch's own committed-but-unpushed history, and the working tree —
  rather than checking only one.
- **`hooks/block-noncompliant-prose.cjs`** — a `PreToolUse` hook. It watches `Write` and `Edit`.
  It only engages for a markdown file. That file's project also needs a nearby `.textlintrc.json`
  that configures `preset-ste-ai`. The hook lints the file's current content. It also lints the
  write's would-be content. It blocks the write only when the write would add errors the file did
  not already have. The block uses exit code 2. It reports the specific new findings. A file with
  pre-existing debt is never blocked from an unrelated edit. Only a write that adds new errors of
  its own gets blocked.

## Why a hook, not just a skill

A skill only runs when invoked. A hook runs automatically. That difference is the whole point
here. An agent authoring markdown in a `preset-ste-ai` project cannot introduce a new lint error
through `Write` or `Edit`. A human can still work around the hook, but the default is enforced.
This matches the standard this repository holds itself to: comply with the linter in advance.
Failing that, comply with its findings before the write lands, not after.

## A known tradeoff in the compliance-reviewing agent

The agent reads diffs and rule files. A reviewed change set can control that content. The agent
also holds a `Bash` grant. It needs that grant to run `git status`, `git diff`, and `git branch`.
It also needs the grant for a read-only `gh pr` lookup. Either kind runs only when nothing hands
the agent a diff directly.

Claude Code's own tool-grant syntax has a limit here. It cannot scope `Bash` down to only those
read-only commands, inside an agent's frontmatter. Every narrower grant tried here either failed
plugin validation, or would not have enforced anything.

The agent's own prompt carries an explicit instruction instead. It says to treat all reviewed
content as data, never as instructions. It says never to run any command beyond those read-only
ones. That instruction is not a technical enforcement boundary, though. A crafted diff or rule
file could still try to make the model run an unintended command.

Weigh that risk before enabling `permissionMode: dontAsk` on a fork of this agent. Weigh it
especially in a setting where an untrusted party can shape the diffs this agent reviews. Watch
this agent's `Bash` calls instead, when that risk applies.

## Installing this plugin elsewhere

Point Claude Code's plugin configuration at this repository. A marketplace entry for it works
too. The hook carries no dependency on this repository once installed. It locates the target
project's own `.textlintrc.json` at hook time. It locates that project's own
`node_modules/.bin/textlint` the same way.
