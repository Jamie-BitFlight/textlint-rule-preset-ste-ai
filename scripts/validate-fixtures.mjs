/**
 * `npm run fixtures:validate`
 *
 * Thin entry point. All logic lives in `src/fixture-tools/validate.ts` so it is type-checked and
 * covered by `test/fixtures/corpus.test.ts`; this file only handles process concerns.
 *
 * Requires a build: run `npm run build` first, or use `npm run fixtures:validate` which does.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(root, 'dist', 'fixture-tools', 'validate.js');

if (!existsSync(built)) {
  console.error('dist/ is missing. Run "npm run build" first.');
  process.exit(2);
}

const { validateFixtureCorpus } = await import(built);
const report = validateFixtureCorpus(join(root, 'fixtures'));

for (const note of report.notes) console.log(`note: ${note}`);

if (!report.ok) {
  console.error(`\n${report.failures.length} fixture validation failure(s):`);
  for (const failure of report.failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `OK: ${report.summary}. Provenance, licences, digests and protected literals verified.`,
);
