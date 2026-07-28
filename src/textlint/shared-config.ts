import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveConfig, type SteAiConfig } from '../core/config.js';

/**
 * Document-wide configuration for the textlint adapter.
 *
 * textlint passes options per rule, but several settings — the rule pack, the semantic service,
 * the autofix policy, protected terminology — apply to the whole document and would otherwise have
 * to be repeated on every rule. They are therefore read once from a shared file.
 *
 * Resolution order (first hit wins):
 * 1. `process.env.STE_AI_CONFIG` — explicit path;
 * 2. `.ste-ai.json`, `.ste-ai.jsonc`, `ste-ai.config.json` in the textlint config base directory;
 * 3. the same names in `process.cwd()`;
 * 4. built-in defaults (provisional pack, semantic analysis off).
 *
 * A rule may still override any of it by passing a `shared` object in its own textlint options.
 */
const FILE_NAMES = ['.ste-ai.json', '.ste-ai.jsonc', 'ste-ai.config.json'];

interface CacheEntry {
  readonly config: SteAiConfig;
  readonly path: string | undefined;
}

const cache = new Map<string, CacheEntry>();

export function findSharedConfigPath(baseDir: string | undefined): string | undefined {
  const explicit = process.env['STE_AI_CONFIG'];
  if (explicit !== undefined && explicit.length > 0) {
    const full = resolve(explicit);
    if (existsSync(full)) return full;
  }
  const dirs = [baseDir, process.cwd()].filter((d): d is string => d !== undefined);
  for (const dir of dirs) {
    for (const name of FILE_NAMES) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

/** Strip `//` and `/* *\/` comments so `.jsonc` is accepted. */
function stripJsonComments(text: string): string {
  return text.replace(
    /("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match, str: string | undefined) => (str === undefined ? '' : match),
  );
}

export function loadSharedConfig(baseDir: string | undefined): CacheEntry {
  const key = baseDir ?? '<cwd>';
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const path = findSharedConfigPath(baseDir);
  let raw: unknown = {};
  if (path !== undefined) {
    raw = JSON.parse(stripJsonComments(readFileSync(path, 'utf8'))) as unknown;
  }
  const entry: CacheEntry = { config: resolveConfig(raw), path };
  cache.set(key, entry);
  return entry;
}

/** Test seam: clears the shared-config cache. */
export function clearSharedConfigCache(): void {
  cache.clear();
}
