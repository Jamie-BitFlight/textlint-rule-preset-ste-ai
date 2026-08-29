/**
 * Re-exports the bundled provisional rule pack from `core/default-pack.ts`.
 *
 * The singleton itself lives in `core` so `core/runner.ts` can identify it by genuine object
 * identity (`pack === provisionalRulePack`) without importing `rule-pack` — `core: []` in
 * `test/architecture/module-boundaries.test.ts` forbids that import direction. This module stays
 * the public import path (`rule-pack/provisional-pack.js`) every existing caller and test already
 * uses.
 */
export { provisionalRulePack } from '../core/default-pack.js';
