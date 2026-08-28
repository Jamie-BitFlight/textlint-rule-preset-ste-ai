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

  // Review found a line that matches neither shape silently dropped instead of rejected, so
  // `test/unit/prompt-corpus.test.ts`'s "carries exactly the allowed metadata keys" check never
  // actually exercised this parser against a malformed line at all: `owner Jamie` (no colon) never
  // reached `meta`, so `Object.keys(meta)` stayed exactly the allowed set regardless, and the
  // corpus test's claim to be exhaustive was untested on the one input it exists to catch.
  //
  // Review then found a second way the same corpus test's "no fewer and no more" claim went
  // untested: a repeated key (two `task:` lines) silently overwrote the first value instead of
  // being rejected, so `Object.keys(meta)` still equalled exactly the allowed set even though the
  // file carried ambiguous, ordering-dependent metadata. Duplicate keys are now rejected outright.
  const meta: Record<string, string> = {};
  for (const line of metaBlock.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(trimmed);
    if (match?.[1] === undefined) {
      throw new PromptError(
        `Prompt ${origin} has a <<<META>>> line that is not a "key: value" pair: "${trimmed}".`,
      );
    }
    const key = match[1];
    if (key in meta) {
      throw new PromptError(`Prompt ${origin} has <<<META>>> key "${key}" more than once.`);
    }
    meta[key] = (match[2] ?? '').trim();
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
  // A `{{...}}` token only makes sense where it is rendered, so one in `<<<SYSTEM>>>` is rejected
  // outright rather than silently forwarded -- move the value into `<<<USER>>>`, or drop it and
  // keep the instruction general, the way every sibling prompt's system message already is.
  //
  // This guard has been patched repeatedly for the same underlying mistake: matching a *shape* of
  // mustache token, rather than the bare character that makes one possible. Each patch
  // closed the exact case review had just reproduced and left the next one open -- a strict
  // identifier pattern missed `{{ length }}` and `{{length-default}}`; excluding braces from the
  // inner class (`[^{}]*`) missed a nested-brace typo like `{{foo{bar}}}`, which has no substring
  // matching that pattern at all; and even the non-greedy `[\s\S]*?\}\}` fix after that still
  // requires a *complete* closing `}}`, so a truncated typo -- `{{length}` (one closing brace) or
  // `{{length` (no closing brace at all) -- has no `}}` anywhere to match against and passes
  // through untouched. Per this repository's own review-cycle guidance: findings that keep
  // reshaping instead of converging mean the guarded pattern, not its next patch, is wrong.
  //
  // No system message in this corpus has any legitimate use for a literal `{` or `}` at all,
  // mustache-shaped or not (see `test/unit/prompt-corpus.test.ts`'s corpus-wide discovery loop,
  // which every prompt asset passes through this check). So this rejects the character itself,
  // not any particular shape a token built from it might or might not complete.
  const braceIndex = system.search(/[{}]/);
  if (braceIndex !== -1) {
    const near = system.slice(Math.max(0, braceIndex - 20), braceIndex + 20);
    throw new PromptError(
      `Prompt ${origin} has a "{" or "}" character in <<<SYSTEM>>> (near "${near}"), but the ` +
        'system message is sent to the model unrendered -- move any placeholder to <<<USER>>>, ' +
        'or remove it and keep the instruction general.',
    );
  }

  const PLACEHOLDER = /\{\{[A-Za-z][A-Za-z0-9_]*\}\}/g;

  const variables = [
    ...new Set([...user.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)].map((m) => m[1] ?? '')),
  ];

  // Review reproduced this against the real `buildEvaluatorRequest` flow, not only a hand-built
  // fixture: `<<<USER>>>` carrying `{{ passage }}` (a stray space) instead of `{{passage}}` derives
  // no variable (the strict grammar above doesn't match it), so `buildEvaluatorRequest` never
  // supplies a value for it, `renderTemplate`'s identical strict regex never matches it either, and
  // the model receives the literal text `Passage: {{ passage }}` in place of the real passage --
  // silently, because `renderTemplate`'s "unused supplied value" guard only ever sees the *keys it
  // was given*, and nothing was given for a placeholder that was never derived in the first place.
  //
  // Same lesson as the `<<<SYSTEM>>>` guard above, applied where legitimate placeholders exist
  // rather than nowhere: strip every well-formed `{{name}}` placeholder out of `user`, and treat any
  // `{` or `}` character still left over as a malformed mustache-like token, whatever shape it
  // takes -- spaced, hyphenated, nested, or missing a closing brace.
  const withoutPlaceholders = user.replace(PLACEHOLDER, '');
  const strayBraceIndex = withoutPlaceholders.search(/[{}]/);
  if (strayBraceIndex !== -1) {
    const near = withoutPlaceholders.slice(Math.max(0, strayBraceIndex - 20), strayBraceIndex + 20);
    throw new PromptError(
      `Prompt ${origin} has a "{" or "}" character in <<<USER>>> that is not part of a ` +
        `well-formed {{placeholder}} (near "${near}") -- fix the placeholder name, or remove the ` +
        'stray character.',
    );
  }

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
