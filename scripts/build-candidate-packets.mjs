/**
 * Build reviewer packets for heuristic candidate passages.
 *
 * The deterministic rules hand every passage they cannot decide to a named semantic evaluator. Those
 * candidates are the only thing the semantic evaluation measures, so each one needs a reviewer
 * verdict before precision or recall means anything. This script produces, per fixture, the exact
 * list of candidates the linter emits — id, rule, evaluator, span, quote, surrounding context and
 * the payload the evaluator would receive — so a reviewer judges the same passage the model does.
 *
 * Output is JSON on stdout, or one file per fixture under `--out <dir>`.
 *
 * Usage:
 *   node scripts/build-candidate-packets.mjs [--out DIR] [--split dev|heldout|all]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Statically importing from `../dist/...` (as this file used to) only resolves once `npm run
// build` has produced it, and CI's own lint step runs before its build step (see
// `.github/workflows/ci.yml`), so a static import here is unresolvable at lint time even though it
// always resolves at the point this script actually runs. `existsSync` + dynamic `import()`
// matches the same guarded pattern `scripts/validate-fixtures.mjs` and
// `scripts/evaluate-semantic.mjs` already use for the same reason, and gives a clear message
// instead of a raw "Cannot find module" if `npm run build` really has not been run yet.
async function main() {
  if (!existsSync(join(root, 'dist', 'core', 'config.js'))) {
    console.error('dist/ is missing. Run "npm run build" first.');
    process.exitCode = 2;
    return;
  }

  const { resolveConfig } = await import(join(root, 'dist', 'core', 'config.js'));
  const { analyseDocument } = await import(join(root, 'dist', 'core', 'document.js'));
  const { runDeterministicRules } = await import(join(root, 'dist', 'core', 'runner.js'));
  const { deterministicRules } = await import(join(root, 'dist', 'deterministic', 'index.js'));
  const { resolveRulePack } = await import(join(root, 'dist', 'rule-pack', 'loader.js'));

  let values;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        fixtures: { type: 'string', default: 'fixtures' },
        split: { type: 'string', default: 'all' },
        out: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  const fixturesDir = resolve(values.fixtures);
  const split = values.split;
  const outDir = values.out;

  const manifest = JSON.parse(readFileSync(join(fixturesDir, 'manifest.json'), 'utf8'));
  const config = resolveConfig({});
  const pack = resolveRulePack(config.rulePack);

  /** Characters of surrounding source shown to the reviewer on each side of the candidate. */
  const CONTEXT = 320;

  const packets = [];
  for (const fixture of manifest.fixtures) {
    if (split !== 'all' && fixture.split !== split) continue;
    const originalPath = join(fixturesDir, fixture.originalPath);
    const text = readFileSync(originalPath, 'utf8');
    const doc = analyseDocument(
      { id: fixture.id, format: 'markdown', text, path: originalPath },
      {
        protectedRegions: {
          approvedTerms: [...config.approvedTerms, ...pack.approvedTechnicalTerms],
          extraPatterns: config.extraProtectedPatterns,
        },
        structure: { extraImperativeVerbs: config.extraImperativeVerbs },
      },
    );
    const run = runDeterministicRules({ doc, rules: deterministicRules, config, pack });
    if (run.candidates.length === 0) continue;

    packets.push({
      fixtureId: fixture.id,
      split: fixture.split,
      category: fixture.category,
      sourceOrganisation: fixture.sourceOrganisation,
      originalPath: fixture.originalPath,
      candidates: run.candidates.map((candidate) => ({
        passageId: candidate.id,
        ruleId: candidate.ruleId,
        evaluatorId: candidate.evaluatorId,
        span: { start: candidate.range.start, end: candidate.range.end },
        quote: text.slice(candidate.range.start, candidate.range.end),
        mode: candidate.mode,
        admonition: candidate.admonition,
        heuristicReason: candidate.reason,
        payload: candidate.payload,
        context: text.slice(
          Math.max(0, candidate.range.start - CONTEXT),
          Math.min(text.length, candidate.range.end + CONTEXT),
        ),
      })),
    });
  }

  const total = packets.reduce((sum, p) => sum + p.candidates.length, 0);
  if (outDir === undefined) {
    process.stdout.write(`${JSON.stringify({ total, packets }, null, 2)}\n`);
  } else {
    const dir = resolve(outDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    for (const packet of packets) {
      writeFileSync(join(dir, `${packet.fixtureId}.json`), `${JSON.stringify(packet, null, 2)}\n`);
    }
    process.stderr.write(`${packets.length} packets, ${total} candidates written to ${dir}\n`);
  }
}

await main();
