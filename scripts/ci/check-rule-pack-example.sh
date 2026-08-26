#!/usr/bin/env bash
#
# Run the commands `examples/rule-pack/README.md` documents, and assert the results that page
# quotes.
#
# This exists because external review on PR #105 pointed out a real gap: the integration tests read
# `acme-pack.json` themselves and hand an inline object to `analyseTextDeterministic()`. They never
# load `untrusted.json` or `trusted.json` through `--config`, and never invoke the CLI. So CLI
# argument handling, shared-config loading, relative `rulePack` path resolution and output rendering
# could all break while those tests stayed green -- and the page claims its commands are pinned.
#
# A second round of review then caught this script's own gap: it captured the CLI's stdout and
# grepped it for expected substrings, but never checked the exit code. `docs/configuration.md`
# documents exit 3 for "any error-level run notice" -- a protected-pattern failure, or a rule
# skipped for invalid options -- and that path can still print a diagnostic count and terms that
# happen to match what this script greps for, while the run itself is not the clean success the
# page claims. Every assertion below now checks the exit code the page documents (1: errors
# present) in addition to the output, so a masked infrastructure failure fails loudly instead of
# passing on a coincidental string match.
#
# A third round dropped the page's hard-coded error counts ("One error." / "Three errors.") after
# review established they carried no information the surrounding text and bullets didn't already
# state -- deleting them changed nothing a reader could learn. This script's own count assertions
# came out with them: they existed only to pin a claim the page no longer makes, and keeping them
# would have reintroduced the same problem in shell instead of prose -- a number with no live source
# that someone has to remember to update by hand.
#
# What is checked here is therefore the documented entry point, end to end, with the shipped files:
# the specific terms each run reports or stops reporting, the fact that a custom pack *replaces* the
# bundled dictionary rather than adding to it, and the trust gate's effect on the JSON `conformance`
# block.
#
# Usage: scripts/ci/check-rule-pack-example.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

cli="dist/cli/main.js"
sample="examples/rule-pack/sample.md"

if [ ! -f "$cli" ]; then
  echo "$cli is missing. Run 'vp pack' first." >&2
  exit 2
fi

for file in "$sample" examples/rule-pack/acme-pack.json examples/rule-pack/untrusted.json \
  examples/rule-pack/trusted.json; do
  if [ ! -f "$file" ]; then
    echo "$file is missing; examples/rule-pack/README.md documents it." >&2
    exit 2
  fi
done

fail() {
  printf 'examples/rule-pack/README.md is stale: %s\n' "$1" >&2
  exit 1
}

# docs/configuration.md's exit-code table: 1 means "errors present". Every command this script
# documents is expected to find the vocabulary violations it demonstrates, so 1 is the only exit
# code that means the run actually did what the page says. `run_lint` sets two globals rather than
# returning a string, because a bash function cannot hand back an exit code and captured output
# together without one of them going through global state.
LAST_STATUS=""
LAST_OUTPUT=""

run_lint() {
  set +e
  LAST_OUTPUT="$(node "$cli" lint "$sample" "$@" 2>&1)"
  LAST_STATUS=$?
  set -e
}

require_exit_1() {
  [ "$LAST_STATUS" = "1" ] ||
    fail "\`$*\` exited $LAST_STATUS, not the documented 1 (errors present). Output:\n$LAST_OUTPUT"
}

# 1. The bundled pack. It flags "Utilise" and nothing about the Acme vocabulary.
run_lint --deterministic-only
require_exit_1 lint "$sample" --deterministic-only
bundled="$LAST_OUTPUT"
printf '%s' "$bundled" | grep -q 'Utilise' ||
  fail 'the bundled pack no longer reports "Utilise"'

# 2. The custom pack, untrusted. "Utilise" is gone because a pack replaces the dictionary rather
#    than adding to it -- that claim is the point of the example.
run_lint --config examples/rule-pack/untrusted.json --deterministic-only
require_exit_1 lint "$sample" --config examples/rule-pack/untrusted.json --deterministic-only
untrusted="$LAST_OUTPUT"

for term in 'De-energise' 'Actuate' 'torque tool'; do
  printf '%s' "$untrusted" | grep -q "$term" ||
    fail "the custom pack no longer reports \"$term\""
done

printf '%s' "$untrusted" | grep -q 'Utilise' &&
  fail 'the custom pack now reports "Utilise"; the page says a pack replaces the dictionary'

printf '%s' "$untrusted" | grep -q 'WidgetPro' &&
  fail 'approvedTechnicalTerms no longer protects "Acme WidgetPro"'

# 3. The trust gate, read from the JSON output the page quotes. The findings are identical either
#    way; what changes is the authority the linter acted on. `--json` follows the same exit-code
#    contract as the human-readable output, so it is checked the same way: capture the exit status
#    alongside stdout, fail on anything but the documented 1, and only then parse the JSON.
conformance() {
  local output status
  set +e
  output="$(node "$cli" lint "$sample" --config "$1" --deterministic-only --json)"
  status=$?
  set -e

  [ "$status" = "1" ] ||
    fail "\`lint $sample --config $1 --json\` exited $status, not the documented 1"

  printf '%s' "$output" | node -e "
    let raw = '';
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => {
      const conformance = JSON.parse(raw).conformance;
      console.log(conformance.claim + ' ' + conformance.packAuthority);
    });
  "
}

untrusted_claim="$(conformance examples/rule-pack/untrusted.json)"
[ "$untrusted_claim" = "none supplementary" ] ||
  fail "untrusted conformance was \"$untrusted_claim\", not the documented \"none supplementary\""

trusted_claim="$(conformance examples/rule-pack/trusted.json)"
[ "$trusted_claim" = "declared-by-supplier normative" ] ||
  fail "trusted conformance was \"$trusted_claim\", not the documented \"declared-by-supplier normative\""

echo "examples/rule-pack/README.md: all documented commands produce the results the page quotes."
