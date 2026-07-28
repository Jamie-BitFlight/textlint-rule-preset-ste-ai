#!/usr/bin/env node
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
import { join, resolve } from 'node:path';
import { resolveConfig } from '../dist/core/config.js';
import { analyseDocument } from '../dist/core/document.js';
import { runDeterministicRules } from '../dist/core/runner.js';
import { deterministicRules } from '../dist/deterministic/index.js';
import { resolveRulePack } from '../dist/rule-pack/loader.js';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const fixturesDir = resolve(flag('--fixtures', 'fixtures'));
const split = flag('--split', 'all');
const outDir = flag('--out', undefined);

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
