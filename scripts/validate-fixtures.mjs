/**
 * `vp run fixtures:validate`
 *
 * Thin entry point. All logic lives in `src/fixture-tools/validate.ts` so it is type-checked and
 * covered by `test/fixtures/corpus.test.ts`; this file only handles process concerns.
 *
 * Requires a build: run `vp run build` first, or use `vp run fixtures:validate` which does.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A filesystem path is not a URL: on Windows, `join(root, 'dist', ...)` produces
 * `C:\...\dist\...`, which the ESM loader reads as the unsupported `c:` URL scheme
 * (`ERR_UNSUPPORTED_ESM_URL_SCHEME`) rather than a drive letter — `pathToFileURL(...).href`
 * converts it to the `file://...` URL `import()` actually expects, on every platform.
 */
function distImport(...segments) {
  return import(pathToFileURL(join(root, 'dist', ...segments)).href);
}

// `process.exitCode` inside a wrapping function, not `process.exit()` mid-script, keeps the
// distinct build-missing/validation-failure exit codes without skipping the remaining checks or
// truncating output that has not finished flushing.
async function main() {
  const built = join(root, 'dist', 'fixture-tools', 'validate.js');

  if (!existsSync(built)) {
    console.error('dist/ is missing. Run "vp run build" first.');
    process.exitCode = 2;
    return;
  }

  const { validateFixtureCorpus } = await distImport('fixture-tools', 'validate.js');
  const report = validateFixtureCorpus(join(root, 'fixtures'));

  for (const note of report.notes) console.log(`note: ${note}`);

  if (!report.ok) {
    console.error(`\n${report.failures.length} fixture validation failure(s):`);
    for (const failure of report.failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `OK: ${report.summary}. Provenance, licences, digests and protected literals verified.`,
  );
}

await main();
