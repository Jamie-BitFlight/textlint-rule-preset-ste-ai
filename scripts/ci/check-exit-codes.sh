#!/usr/bin/env bash
#
# Verify the documented CLI exit-code contract:
#   0  clean
#   1  errors present
#   2  usage error
#   3  semantic-service failure under the `error` policy (not exercised here — needs a service)
#
# The original fixture corpus deliberately contains violations, so a run over it must exit 1.
# A document with no findings must exit 0. Asserting both proves the exit code tracks findings
# rather than being constant.
#
# Usage: scripts/ci/check-exit-codes.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

cli="dist/cli/main.js"
report="${RUNNER_TEMP:-/tmp}/ste-ai-corpus.json"
clean_doc="${RUNNER_TEMP:-/tmp}/ste-ai-clean.md"

if [ ! -f "$cli" ]; then
  echo "dist/ is missing. Run 'npm run build' first." >&2
  exit 2
fi

# --- exit 1: a corpus with known violations ------------------------------------------------
set +e
node "$cli" lint fixtures/original/*.md --deterministic-only --json > "$report"
corpus_status=$?
set -e

if [ "$corpus_status" -ne 1 ]; then
  echo "expected exit 1 for the original corpus (it has known violations), got $corpus_status" >&2
  exit 1
fi

node scripts/ci/assert-corpus-report.mjs "$report"

# --- exit 0: a document with no findings ---------------------------------------------------
printf 'Remove the cover.\n' > "$clean_doc"
node "$cli" lint "$clean_doc" --deterministic-only > /dev/null
echo "clean document exited 0 as documented"

# --- exit 2: a usage error -----------------------------------------------------------------
set +e
node "$cli" lint > /dev/null 2>&1
usage_status=$?
set -e

if [ "$usage_status" -ne 2 ]; then
  echo "expected exit 2 for a usage error (no files given), got $usage_status" >&2
  exit 1
fi
echo "usage error exited 2 as documented"
