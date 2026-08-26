#!/usr/bin/env bash
#
# Confirm .pre-commit-hooks.yaml (docs/pre-commit-hooks.md) is present and shaped the way that
# guide documents (id, `language: system`, an `entry:` naming this package and the `lint`
# subcommand), and that the CLI flags in `entry` still exist and still flag a known violation. This
# is the same failure mode check-textlint-configs-resolve.sh guards against for .textlintrc.json: a
# shipped config that looks right but silently does nothing once a consumer points a tool at it.
#
# `language: system` means pre-commit and prek never build or install anything for this hook --
# they just run `entry` verbatim, backed by whatever the consumer's own `node_modules` already has
# installed (docs/pre-commit-hooks.md's prerequisite). There is therefore no environment for this
# script to install either; it only needs the flags after `textlint-rule-preset-ste-ai` in `entry`
# to still be valid CLI flags, which it checks by running this repository's own build with them.
#
# Usage: scripts/ci/check-pre-commit-hook-manifest.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

manifest=".pre-commit-hooks.yaml"

if [ ! -f "$manifest" ]; then
  echo "$manifest is missing." >&2
  exit 2
fi

if [ ! -f dist/cli/main.js ]; then
  echo "dist/cli/main.js is missing. Run 'vp pack' first." >&2
  exit 2
fi

# The manifest must declare `language: system`: docs/pre-commit-hooks.md's whole rationale for not
# using `language: node` is that this package cannot be reliably built as a pre-commit-managed node
# environment (see that doc's "Why not language: node?"). A manifest edit that switches this back
# would reintroduce that failure silently, so it is asserted here, not just described in prose.
if ! grep -qE '^\s*language:\s*system\s*$' "$manifest"; then
  echo "$manifest: expected 'language: system' (see docs/pre-commit-hooks.md)." >&2
  exit 1
fi

if ! grep -qE '^\s*-?\s*id:\s*ste-ai\s*$' "$manifest"; then
  echo "$manifest: expected hook id 'ste-ai'." >&2
  exit 1
fi

entry_line="$(grep -E '^\s*entry:' "$manifest" | head -1)"
if [ -z "$entry_line" ]; then
  echo "$manifest: no 'entry:' line found." >&2
  exit 1
fi
# Strip the `entry:` key, and any surrounding YAML quoting -- the value is a plain scalar today,
# never block-scalar syntax, so this substring form is enough without a YAML parser.
entry_cmd="${entry_line#*entry:}"
entry_cmd="$(echo "$entry_cmd" | sed -E "s/^[[:space:]]*['\"]?//; s/['\"]?[[:space:]]*\$//")"

case "$entry_cmd" in
  *"textlint-rule-preset-ste-ai lint"*) ;;
  *)
    echo "$manifest: entry '$entry_cmd' does not look like 'npx … textlint-rule-preset-ste-ai lint …'." >&2
    exit 1
    ;;
esac

# The trailing CLI flags (e.g. `--fail-on-review`) are what can drift -- a renamed or removed flag
# would otherwise fail silently for hook users, since `entry` is opaque YAML nobody type-checks.
# `npx --yes textlint-rule-preset-ste-ai …` itself is not re-exercised here: this repository links
# the package to itself as a `file:.` devDependency for its own tests, and npm does not create a
# `node_modules/.bin/ste-ai` symlink for that self-link (verified; every other script in
# scripts/ci/ already routes around the same gap by calling `node dist/cli/main.js` directly, never
# `node_modules/.bin/ste-ai`). A real consumer's install is a normal tarball install, not a
# self-link, and does get the bin symlink -- see docs/pre-commit-hooks.md's own worked example, and
# check-textlint-configs-resolve.sh, which already verifies the self-link itself resolves.
cli_args="${entry_cmd#*textlint-rule-preset-ste-ai}"

fixture="${RUNNER_TEMP:-/tmp}/ste-ai-pre-commit-hook-fixture.md"
printf 'Utilise the the bracket.\n' > "$fixture"

set +e
# shellcheck disable=SC2086  # $cli_args is a fixed, repo-controlled flag list, not user input.
output="$(node dist/cli/main.js $cli_args "$fixture" 2>&1)"
status=$?
set -e

if [ "$status" -ne 1 ]; then
  echo "$manifest: expected the hook's entry command to exit 1 for a known violation, got $status." >&2
  echo "$output" >&2
  exit 1
fi

if ! echo "$output" | grep -q "unapproved-vocabulary"; then
  echo "$manifest: expected an unapproved-vocabulary finding from the hook's entry command." >&2
  echo "$output" >&2
  exit 1
fi

# The check above alone cannot tell whether `--fail-on-review` is actually present in `entry`: a
# hard `error`-level finding already forces exit 1 on its own, with or without that flag -- checked
# by hand while writing this script, this exact fixture stayed green after deleting the flag from
# `entry`. A passage that trips only a review-required candidate rule (nothing error-level) isolates
# it: exit 0 without the flag, exit 1 with it, so a future edit that silently drops the flag from
# `entry` fails this check instead of only reaching a hook user's commit later.
review_fixture="${RUNNER_TEMP:-/tmp}/ste-ai-pre-commit-hook-review-fixture.md"
printf 'The cover is removed by the technician.\n' > "$review_fixture"

set +e
# shellcheck disable=SC2086  # $cli_args is a fixed, repo-controlled flag list, not user input.
review_output="$(node dist/cli/main.js $cli_args "$review_fixture" 2>&1)"
review_status=$?
set -e

if [ "$review_status" -ne 1 ]; then
  echo "$manifest: entry command exited $review_status for a review-required-only passage." >&2
  echo "expected 1 -- entry must still include --fail-on-review (or equivalent)." >&2
  echo "$review_output" >&2
  exit 1
fi

echo "$manifest: language:system, id ste-ai, and its entry command resolved and ran correctly."
rm -f "$fixture" "$review_fixture"
