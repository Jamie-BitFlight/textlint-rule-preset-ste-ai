import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const [tag] = process.argv.slice(2);
assert.match(
  tag ?? '',
  /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
  'Expected a v-prefixed SemVer tag',
);

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
assert.equal(
  packageJson.version,
  tag.slice(1),
  `package.json version ${String(packageJson.version)} does not match release tag ${tag}`,
);

console.log(`Release tag ${tag} matches package version ${packageJson.version}.`);
