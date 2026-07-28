/**
 * Assert that every shipped rule reports provisional status.
 *
 * Usage: node scripts/ci/assert-rules-provisional.mjs <rules.json> [expectedCount]
 *
 * This is the mechanical guard behind the disclaimer: if a rule ever starts claiming normative
 * authority without an authorised rule pack, CI fails rather than the claim reaching users.
 */
import { readFileSync } from 'node:fs';

const [rulesPath, expectedCountRaw = '14'] = process.argv.slice(2);

if (rulesPath === undefined) {
  console.error('usage: node scripts/ci/assert-rules-provisional.mjs <rules.json> [expectedCount]');
  process.exit(2);
}

const expectedCount = Number.parseInt(expectedCountRaw, 10);
const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));

if (rules.length !== expectedCount) {
  console.error(`expected ${expectedCount} rules, got ${rules.length}`);
  process.exit(1);
}

const nonProvisional = rules.filter((rule) => rule.status !== 'provisional');

if (nonProvisional.length > 0) {
  console.error(
    `rules claiming non-provisional status: ${nonProvisional.map((rule) => rule.id).join(', ')}`,
  );
  process.exit(1);
}

console.log(`all ${rules.length} rules report provisional status`);
