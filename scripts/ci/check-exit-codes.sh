#!/usr/bin/env bash
#
# Verify the documented CLI exit-code contract:
#   0  clean
#   1  errors present
#   2  usage error
#   3  any error-level RunNotice — semantic-service failure under the `error` policy (not
#      exercised here — needs a service), a refused protected pattern
#      (invalid-protected-pattern), or a rule skipped for invalid options
#      (rule-options-invalid) — the last two exercised below, no service needed
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
  echo "dist/ is missing. Run 'vp pack' first." >&2
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

# --- exit 3: a refused protected pattern, on an otherwise clean document -------------------
# invalid-protected-pattern is an error-level RunNotice, not a diagnostic, so this proves the
# exit code tracks it too -- a clean-looking "0 error(s)" must not also mean exit 0 when a
# configured literal was neither protected nor withheld from the semantic service.
bad_pattern_config="${RUNNER_TEMP:-/tmp}/ste-ai-bad-pattern.json"
printf '{ "extraProtectedPatterns": ["([unclosed"] }\n' > "$bad_pattern_config"

set +e
node "$cli" lint "$clean_doc" --deterministic-only --config "$bad_pattern_config" > /dev/null
pattern_status=$?
set -e

if [ "$pattern_status" -ne 3 ]; then
  echo "expected exit 3 for a refused protected pattern, got $pattern_status" >&2
  exit 1
fi
echo "refused protected pattern exited 3 as documented"

# --- exit 3: a rule skipped for invalid options, on an otherwise clean document ------------
# rule-options-invalid is the notice the runner emits when a configured rule's options fail
# validation and the rule is skipped for the whole run — reached here with minLength > maxLength,
# which is individually in-range for each option but violates the cross-field ordering
# abbreviation-introduction's schema requires. Same proof as the refused-pattern case above: a
# clean-looking "0 error(s)" must not also mean exit 0 when a rule the operator configured never
# ran this session.
bad_options_config="${RUNNER_TEMP:-/tmp}/ste-ai-bad-options.json"
printf '{ "rules": { "abbreviation-introduction": { "minLength": 8, "maxLength": 3 } } }\n' > "$bad_options_config"

set +e
node "$cli" lint "$clean_doc" --deterministic-only --config "$bad_options_config" > /dev/null
options_status=$?
set -e

if [ "$options_status" -ne 3 ]; then
  echo "expected exit 3 for a rule skipped over invalid options, got $options_status" >&2
  exit 1
fi
echo "rule skipped for invalid options exited 3 as documented"
