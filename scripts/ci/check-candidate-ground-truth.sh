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
  echo "dist/ is missing. Run 'vp run build' first." >&2
  exit 2
fi

# The packet builder imports from dist/, so a stale build silently checks the wrong code. That is
# not hypothetical: a stale dist/ passed this check locally against the previous segmentation while
# CI, which always builds clean, failed on it. Refuse rather than report a result about old code.
#
# Compare the newest source against the newest build output. Comparing against the dist/ directory
# itself does not work: an incremental tsc rewrites files inside it without touching the directory
# mtime, so the guard would fire immediately after a successful build.
newest_source="$(find src -name '*.ts' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)"
newest_build="$(find dist -name '*.js' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)"
if [ -z "$newest_build" ] || [ "$newest_source" -nt "$newest_build" ]; then
  echo "dist/ is stale: $newest_source is newer than the build. Run 'vp run build' first." >&2
  exit 2
fi

packets="$(mktemp -d "${RUNNER_TEMP:-/tmp}/ste-ai-packets.XXXXXX")"
trap 'rm -rf "$packets"' EXIT

node scripts/build-candidate-packets.mjs --out "$packets"
node scripts/merge-candidate-verdicts.mjs \
  --verdicts fixtures/verdicts \
  --packets "$packets" \
  --check
