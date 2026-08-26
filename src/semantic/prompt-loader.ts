import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Versioned prompt assets.
 *
 * Prompts live in `prompts/<version>/<evaluatorId>.md` as repository assets rather than string
 * literals, so a prompt change is a reviewable diff and the version that produced a verdict is
 * recorded in every trace.
 *
 * File format — three delimited sections:
 *
 *     <<<META>>>     key: value lines, informational
 *     <<<SYSTEM>>>   the system message
 *     <<<USER>>>     the user message template, with {{variable}} placeholders
 */

export interface PromptTemplate {
  readonly id: string;
  readonly version: string;
  readonly system: string;
  readonly user: string;
  readonly meta: Readonly<Record<string, string>>;
  /** Placeholder names the user template requires. */
  readonly variables: readonly string[];
}

export class PromptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PromptError';
  }
}

/** Repository/package root: two levels up from this module's directory. */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function parsePromptFile(text: string, origin: string): PromptTemplate {
  const metaIndex = text.indexOf('<<<META>>>');
  const systemIndex = text.indexOf('<<<SYSTEM>>>');
  const userIndex = text.indexOf('<<<USER>>>');
  if (metaIndex !== 0 || systemIndex < 0 || userIndex < systemIndex) {
    throw new PromptError(
      `Prompt ${origin} must contain <<<META>>>, then <<<SYSTEM>>>, then <<<USER>>>.`,
    );
  }
  const metaBlock = text.slice(metaIndex + '<<<META>>>'.length, systemIndex).trim();
  const system = text.slice(systemIndex + '<<<SYSTEM>>>'.length, userIndex).trim();
  const user = text.slice(userIndex + '<<<USER>>>'.length).trim();

  const meta: Record<string, string> = {};
  for (const line of metaBlock.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) meta[match[1]] = (match[2] ?? '').trim();
  }
  const id = meta['id'];
  const version = meta['version'];
  if (id === undefined || version === undefined) {
    throw new PromptError(`Prompt ${origin} must declare "id" and "version" in <<<META>>>.`);
  }

  // `buildEvaluatorRequest` forwards `system` to the model unrendered -- unlike `user`, it never
  // goes through `renderTemplate`. Review found `noun-cluster-comprehension.md`'s `<<<SYSTEM>>>`
  // carrying a `{{length}}` placeholder that `variables` (derived from `user` alone) never saw, so
  // every real request sent the model the literal text `{{length}}` instead of a rendered number,
  // undetected because nothing here or in the test corpus looked at `<<<SYSTEM>>>` for this shape.
  // A `{{...}}` placeholder only makes sense where it is rendered, so one in `<<<SYSTEM>>>` is
  // rejected outright rather than silently forwarded -- move the value into `<<<USER>>>`, or drop
  // it and keep the instruction general, the way every sibling prompt's system message already is.
  const systemPlaceholder = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/.exec(system);
  if (systemPlaceholder !== null) {
    throw new PromptError(
      `Prompt ${origin} has a {{${systemPlaceholder[1] ?? ''}}} placeholder in <<<SYSTEM>>>, but ` +
        'the system message is sent to the model unrendered -- move it to <<<USER>>>, or remove ' +
        'it and keep the instruction general.',
    );
  }

  const variables = [
    ...new Set([...user.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)].map((m) => m[1] ?? '')),
  ];
  return { id, version, system, user, meta, variables };
}

export class FilePromptProvider {
  readonly #root: string;
  readonly #cache = new Map<string, PromptTemplate>();

  constructor(root: string = join(packageRoot(), 'prompts')) {
    this.#root = root;
  }

  get(version: string, evaluatorId: string): PromptTemplate {
    const key = `${version}/${evaluatorId}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;
    const path = join(this.#root, version, `${evaluatorId}.md`);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw new PromptError(`No prompt asset for evaluator "${evaluatorId}" at ${path}`, {
        cause: error,
      });
    }
    const template = parsePromptFile(text, path);
    if (template.id !== evaluatorId) {
      throw new PromptError(
        `Prompt at ${path} declares id "${template.id}" but is loaded as "${evaluatorId}".`,
      );
    }
    if (template.version !== version) {
      throw new PromptError(
        `Prompt at ${path} declares version "${template.version}" but is loaded as "${version}".`,
      );
    }
    this.#cache.set(key, template);
    return template;
  }
}

/**
 * Substitute `{{name}}` placeholders.
 *
 * Throws when a placeholder has no value and when a value is supplied for a placeholder the
 * template does not use. Both are prompt-construction bugs that would otherwise reach the model
 * silently, so they fail loudly and are covered by golden tests.
 */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
  origin: string,
): string {
  const used = new Set<string>();
  const rendered = template.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new PromptError(`Prompt ${origin} needs a value for {{${name}}}.`);
    }
    used.add(name);
    return value;
  });
  for (const key of Object.keys(values)) {
    if (!used.has(key)) {
      throw new PromptError(`Prompt ${origin} has no placeholder for supplied value "${key}".`);
    }
  }
  return rendered;
}

/** Format a payload value for insertion into a prompt. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.length === 0 ? 'none' : value.map((v) => `- ${formatValue(v)}`).join('\n');
  }
  return JSON.stringify(value);
}
