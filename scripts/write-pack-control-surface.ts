/**
 * Write the pack control-surface table into `docs/rule-pack-import.md`.
 *
 * Usage: npx tsx scripts/write-pack-control-surface.ts
 *
 * The page claims the table is generated. This is what generates it, so that claim stays true.
 * `test/architecture/doc-pack-control-surface.test.ts` fails when the committed page and this
 * renderer disagree, which is what turns "run the generator" from a convention into a build gate.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { withRenderedTable } from './lib/pack-control-surface.js';

const DOC = resolve(import.meta.dirname, '..', 'docs', 'rule-pack-import.md');

const before = readFileSync(DOC, 'utf8');
const after = withRenderedTable(before);

if (before === after) {
  console.log(`${DOC} is already up to date.`);
} else {
  writeFileSync(DOC, after);
  console.log(`Rewrote the control-surface table in ${DOC}.`);
}
