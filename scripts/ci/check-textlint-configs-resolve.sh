#!/usr/bin/env bash
#
# Confirm every shipped `.textlintrc.json` in this repository actually resolves and runs the
# real preset through the real `textlint` CLI's own module resolution -- not the kernel-with-rules-
# passed-directly shortcut the unit and e2e suites use (see test/e2e/textlint-run.test.ts), and not
# just the JSON-shape validation in test/e2e/example-config.test.ts.
#
# This is the failure mode PR #86 shipped and external review caught: `.textlintrc.json` named
# "preset-ste-ai", which textlint resolves as a package called `textlint-rule-preset-ste-ai` via
# Node module resolution. Nothing installs that package into this repo's own node_modules by
# default -- the root package *is* that package -- so `textlint` printed "No rules found" and the
# config silently never ran anything. Two configs ship that name: the root one this repo lints its
# own docs with, and examples/.textlintrc.json, which docs/configuration.md calls "a complete
# working file". Both are checked here, against a fixture with known, rule-specific violations, so
# a future edit that breaks resolution (or silently loads zero rules) fails the build instead of
# shipping unnoticed again.
#
# Usage: scripts/ci/check-textlint-configs-resolve.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

textlint_bin="node_modules/.bin/textlint"

if [ ! -x "$textlint_bin" ]; then
  echo "$textlint_bin is missing. Run 'vp install' first." >&2
  exit 2
fi

if [ ! -f dist/textlint/preset.js ]; then
  echo "dist/textlint/preset.js is missing. Run 'vp pack' first." >&2
  exit 2
fi

if [ ! -L node_modules/textlint-rule-preset-ste-ai ]; then
  echo "node_modules/textlint-rule-preset-ste-ai is not a symlink." >&2
  echo "package.json's devDependencies should self-link this package via \"file:.\" -- run 'vp install'." >&2
  exit 2
fi

fixture="${RUNNER_TEMP:-/tmp}/ste-ai-config-resolution-fixture.md"
# Deliberately triggers two independent rules (unapproved-vocabulary, no-repeated-words) so a
# config that resolves the preset but only wires up one rule still fails this check.
printf 'Prior to installation, utilise the the bracket.\n' > "$fixture"

check_config() {
  local label="$1"
  local config="$2"
  local output status

  set +e
  output="$("$textlint_bin" --config "$config" "$fixture" 2>&1)"
  status=$?
  set -e

  if echo "$output" | grep -q "No rules found"; then
    echo "$label ($config): preset-ste-ai did not resolve -- textlint reported no rules." >&2
    echo "$output" >&2
    exit 1
  fi

  if [ "$status" -ne 1 ]; then
    echo "$label ($config): expected exit 1 (known violations present), got $status." >&2
    echo "$output" >&2
    exit 1
  fi

  if ! echo "$output" | grep -q "ste-ai/unapproved-vocabulary"; then
    echo "$label ($config): expected an unapproved-vocabulary finding and did not see one." >&2
    echo "$output" >&2
    exit 1
  fi

  if ! echo "$output" | grep -q "ste-ai/no-repeated-words"; then
    echo "$label ($config): expected a no-repeated-words finding and did not see one." >&2
    echo "$output" >&2
    exit 1
  fi

  echo "$label ($config): preset-ste-ai resolved and ran both expected rules."
}

check_config "root config" ".textlintrc.json"
check_config "examples config" "examples/.textlintrc.json"

rm -f "$fixture"
