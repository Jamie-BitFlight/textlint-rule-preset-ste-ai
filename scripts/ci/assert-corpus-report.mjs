/**
 * Assert the shape of a `ste-ai lint --json` report produced over the original fixture corpus.
 *
 * Usage: node scripts/ci/assert-corpus-report.mjs <report.json>
 *
 * Checks:
 * - the bundled pack claims no conformance and reports provisional authority;
 * - the run produced at least one diagnostic, so a silently-empty rule set cannot pass CI.
 */
import { readFileSync } from 'node:fs';

// `process.exit()` mid-script would skip the remaining checks below whenever an earlier one fails,
// and can truncate output that has not finished flushing; wrapping the checks in a function and
// using `process.exitCode` (the pattern this project's own `src/cli/main.ts` already follows) gets
// the same distinct exit codes -- 2 for a usage error, 1 for a failed assertion -- without either
// risk.
function main() {
  const [reportPath] = process.argv.slice(2);

  if (reportPath === undefined) {
    console.error('usage: node scripts/ci/assert-corpus-report.mjs <report.json>');
    process.exitCode = 2;
    return;
  }

  const report = JSON.parse(readFileSync(reportPath, 'utf8'));

  if (report.conformance?.claim !== 'none') {
    console.error(
      `the bundled pack must not claim conformance, got ${JSON.stringify(report.conformance?.claim)}`,
    );
    process.exitCode = 1;
    return;
  }

  if (report.conformance?.packAuthority !== 'provisional') {
    console.error(
      `the bundled pack must report provisional authority, got ${JSON.stringify(
        report.conformance?.packAuthority,
      )}`,
    );
    process.exitCode = 1;
    return;
  }

  const total = report.results.reduce((n, file) => n + file.diagnostics.length, 0);

  if (total === 0) {
    console.error('expected diagnostics on the original corpus, got none');
    process.exitCode = 1;
    return;
  }

  console.log(
    `deterministic-only run produced ${total} diagnostics across ${report.results.length} files, ` +
      'exit code 1 as documented',
  );
}

main();
