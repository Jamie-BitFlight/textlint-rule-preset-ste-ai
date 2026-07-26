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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(root, 'dist', 'evaluation', 'evaluate.js'))) {
  console.error('dist/ is missing. Run "npm run build" first.');
  process.exit(2);
}

const { evaluateSemanticEvaluators, formatEvaluationReport } = await import(
  join(root, 'dist', 'evaluation', 'evaluate.js')
);
const { LlamaCppClient } = await import(join(root, 'dist', 'model-client', 'llama-client.js'));

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const split = flag('split', 'heldout');
if (!['dev', 'heldout', 'all'].includes(split)) {
  console.error(`--split must be dev, heldout or all (got "${split}")`);
  process.exit(2);
}
const endpoint = flag('endpoint', 'http://127.0.0.1:8080');
const model = flag('model', 'local-ste-adjudicator');
const timeout = Number(flag('timeout', '30000'));
const concurrency = Number(flag('concurrency', '2'));
const out = flag('out', undefined);

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

if (has('json')) {
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
  process.exit(1);
}
