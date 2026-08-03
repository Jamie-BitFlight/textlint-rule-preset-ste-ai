/**
 * `npm run eval:semantic` — opt-in semantic-evaluator measurement against a real llama.cpp server.
 *
 * This is NOT part of the default test suite: it needs a running model. The default suite proves the
 * integration path with a fake service instead.
 *
 * Usage:
 *   npm run eval:semantic -- --split heldout --endpoint http://127.0.0.1:8080 --model my-model
 *   npm run eval:semantic -- --split dev --json > eval-dev.json
 *
 * Split discipline: `dev` is for tuning prompts and thresholds; `heldout` is for reporting. The
 * default is `heldout` and mixing splits requires `--split all` explicitly.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// `process.exitCode` inside a wrapping function, not `process.exit()` mid-script, keeps the
// distinct build-missing/usage-error exit codes below without skipping the rest of the script (the
// real, always-set `process.exitCode = 1` cases further down already followed this pattern; the
// three early `process.exit(2)` guards were the outliers).
async function main() {
  if (!existsSync(join(root, 'dist', 'evaluation', 'evaluate.js'))) {
    console.error('dist/ is missing. Run "npm run build" first.');
    process.exitCode = 2;
    return;
  }

  const { evaluateSemanticEvaluators, formatEvaluationReport } = await import(
    join(root, 'dist', 'evaluation', 'evaluate.js')
  );
  const { LlamaCppClient } = await import(join(root, 'dist', 'model-client', 'llama-client.js'));

  let values;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        split: { type: 'string', default: 'heldout' },
        endpoint: { type: 'string', default: 'http://127.0.0.1:8080' },
        model: { type: 'string', default: 'local-ste-adjudicator' },
        timeout: { type: 'string', default: '30000' },
        concurrency: { type: 'string', default: '2' },
        out: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  const split = values.split;
  if (!['dev', 'heldout', 'all'].includes(split)) {
    console.error(`--split must be dev, heldout or all (got "${split}")`);
    process.exitCode = 2;
    return;
  }
  const endpoint = values.endpoint;
  const model = values.model;
  const timeout = Number(values.timeout);
  const concurrency = Number(values.concurrency);
  const out = values.out;

  const transport = new LlamaCppClient({ endpoint, requestTimeoutMs: timeout });

  const report = await evaluateSemanticEvaluators({
    fixturesDir: join(root, 'fixtures'),
    split,
    transport,
    config: {
      semantic: {
        enabled: true,
        endpoint,
        model,
        requestTimeoutMs: timeout,
        maxConcurrency: concurrency,
        // Caching off: a measurement run must actually exercise the model.
        cache: false,
      },
    },
  });

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatEvaluationReport(report)}\n`);
  }

  if (out !== undefined) {
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.error(`wrote ${out}`);
  }

  if (report.overall.failureRate > 0.5) {
    console.error(
      `\nMore than half the requests failed (${(report.overall.failureRate * 100).toFixed(0)}%). ` +
        'Check that the server is running and that the model can produce the required JSON.',
    );
    process.exitCode = 1;
  }

  // A run that produced no labelled cases cannot report precision or recall. Exiting 0 would let a
  // caller record "no failures" for a measurement that measured nothing.
  if (report.overall.labelled === 0 && report.cases.length > 0) {
    console.error(
      `\nNo case in this split carries a gold label, so precision, recall and F1 are undefined. ` +
        `${report.cases.length} candidate(s) were adjudicated but none is referenced by a fixture ` +
        'annotation for the same rule. Add annotations for the candidate rules before quoting metrics.',
    );
    process.exitCode = 1;
  }
}

await main();
