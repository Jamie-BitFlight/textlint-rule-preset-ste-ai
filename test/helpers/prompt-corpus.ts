import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROMPTS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');

export interface PromptFile {
  readonly version: string;
  readonly evaluatorId: string;
  readonly path: string;
  readonly text: string;
}

/**
 * Discover every prompt asset in the repository, for every version directory present.
 *
 * Shared between `test/unit/prompt-corpus.test.ts` (corpus-wide structural invariants) and
 * `test/unit/prompts.test.ts` (per-prompt safety checks) -- both must see the same versions, or a
 * new version directory can satisfy one file's checks while silently skipping the other's. Review
 * found exactly that: the safety checks stayed hard-coded to `provider.get('v1', ...)` after this
 * discovery already existed for the structural checks.
 */
export function discoverPromptFiles(): readonly PromptFile[] {
  const found: PromptFile[] = [];
  for (const version of readdirSync(PROMPTS_ROOT)) {
    const versionDir = join(PROMPTS_ROOT, version);
    if (!statSync(versionDir).isDirectory()) continue;
    for (const entry of readdirSync(versionDir)) {
      if (!entry.endsWith('.md')) continue;
      const path = join(versionDir, entry);
      found.push({
        version,
        evaluatorId: entry.slice(0, -'.md'.length),
        path,
        text: readFileSync(path, 'utf8'),
      });
    }
  }
  return found;
}
