#!/usr/bin/env bash
#
# Confirm the shipped rule set reports itself as provisional.
#
# Usage: scripts/ci/check-rules-provisional.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

cli="dist/cli/main.js"
rules="${RUNNER_TEMP:-/tmp}/ste-ai-rules.json"

if [ ! -f "$cli" ]; then
  echo "dist/ is missing. Run 'vp run build' first." >&2
  exit 2
fi

node "$cli" rules --json > "$rules"
node scripts/ci/assert-rules-provisional.mjs "$rules" 14
