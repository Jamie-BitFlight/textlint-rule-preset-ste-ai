#!/usr/bin/env bash
#
# Confirm every heuristic candidate the linter emits still has a reviewer verdict bound to it.
#
# The semantic evaluators are measured against these verdicts and nothing else. A rule change that
# moves or adds candidate passages silently orphans the ground truth, at which point the evaluation
# harness reports a confusion matrix of zeroes and looks like it is working. This check fails the
# build instead, so the corpus is re-reviewed rather than quietly becoming unmeasurable.
#
# Usage: scripts/ci/check-candidate-ground-truth.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

if [ ! -d dist ]; then
  echo "dist/ is missing. Run 'npm run build' first." >&2
  exit 2
fi

packets="$(mktemp -d "${RUNNER_TEMP:-/tmp}/ste-ai-packets.XXXXXX")"
trap 'rm -rf "$packets"' EXIT

node scripts/build-candidate-packets.mjs --out "$packets"
node scripts/merge-candidate-verdicts.mjs \
  --verdicts fixtures/verdicts \
  --packets "$packets" \
  --check
