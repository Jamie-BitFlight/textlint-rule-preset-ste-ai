import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Architectural boundaries, enforced rather than documented.
 *
 * The project ships as a single npm package, so package.json topology cannot police the module
 * graph. This test does: it reads every import in `src/` and asserts the dependency direction.
 * The point of the exercise is the two prohibitions at the end — business rules must not live in
 * transport code or in the textlint adapter.
 */

const SRC = resolve(import.meta.dirname, '..', '..', 'src');

const ALLOWED: Record<string, readonly string[]> = {
  core: [],
  // A real Markdown parser (`@textlint/markdown-to-ast`) has "textlint" in its own package name,
  // which the "core imports no textlint package" prohibition below exists specifically to catch —
  // see docs/architecture.md, "Document reader", §3. Landing the reader here rather than loosening
  // that prohibition is the point: `core` still imports nothing internal, unchanged.
  reader: ['core'],
  'rule-pack': ['core'],
  deterministic: ['core', 'rule-pack'],
  'model-client': ['core'],
  semantic: ['core', 'rule-pack', 'model-client'],
  analysis: ['core', 'rule-pack', 'deterministic', 'semantic', 'model-client', 'reader'],
  textlint: ['core', 'rule-pack', 'deterministic', 'semantic', 'analysis'],
  'fixture-tools': ['core', 'rule-pack'],
  // Measurement tooling composes every layer by design: it must run the real rule set and the real
  // broker to produce numbers that mean anything. It is a leaf — nothing imports it.
  evaluation: ['core', 'rule-pack', 'deterministic', 'semantic', 'model-client', 'fixture-tools'],
  cli: ['core', 'rule-pack', 'deterministic', 'semantic', 'analysis', 'model-client'],
};

interface ImportEdge {
  readonly file: string;
  readonly fromModule: string;
  readonly toModule: string;
  readonly specifier: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function moduleOf(file: string): string {
  const rel = relative(SRC, file);
  return rel.split('/')[0] ?? '';
}

function edges(): ImportEdge[] {
  const out: ImportEdge[] = [];
  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf8');
    const fromModule = moduleOf(file);
    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      const specifier = match[1];
      if (specifier === undefined || !specifier.startsWith('.')) continue;
      const target = resolve(file, '..', specifier);
      const toModule = moduleOf(target);
      if (toModule === fromModule || toModule === '') continue;
      out.push({ file: relative(SRC, file), fromModule, toModule, specifier });
    }
  }
  return out;
}

describe('module boundaries', () => {
  const all = edges();

  it('finds imports to check', () => {
    expect(all.length).toBeGreaterThan(10);
  });

  it('every top-level module is declared in the allow list', () => {
    const modules = new Set(walk(SRC).map(moduleOf));
    for (const module of modules) {
      expect(Object.keys(ALLOWED), `undeclared module "${module}"`).toContain(module);
    }
  });

  it('no module imports outside its allowed dependencies', () => {
    const violations = all.filter((edge) => {
      const allowed = ALLOWED[edge.fromModule];
      return allowed === undefined || !allowed.includes(edge.toModule);
    });
    expect(violations.map((v) => `${v.file} imports ${v.toModule} (${v.specifier})`)).toEqual([]);
  });

  it('core depends on nothing internal', () => {
    expect(all.filter((e) => e.fromModule === 'core')).toEqual([]);
  });

  it('model-client contains no rule logic and never reaches the semantic layer', () => {
    const fromTransport = all.filter((e) => e.fromModule === 'model-client');
    expect(fromTransport.map((e) => e.toModule)).not.toContain('semantic');
    expect(fromTransport.map((e) => e.toModule)).not.toContain('deterministic');
    expect(fromTransport.map((e) => e.toModule)).not.toContain('rule-pack');
  });

  it('the textlint adapter contains no rule logic', () => {
    // The adapter may compose and translate, but it must not define rules or matching. Any file
    // under src/textlint that declares a rule shape or a term pattern is a boundary violation.
    for (const file of walk(join(SRC, 'textlint'))) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} declares rule metadata`).not.toMatch(/optionsSchema\s*:/);
      expect(source, `${file} declares a RuleMetadata literal`).not.toMatch(
        /inspectsProtectedRegions/,
      );
      expect(source, `${file} builds diagnostics directly`).not.toMatch(/buildDiagnostic\(/);
    }
  });

  it('no rule module performs network or filesystem I/O', () => {
    for (const file of walk(join(SRC, 'deterministic'))) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from 'node:fs'|from 'node:http|fetch\(/);
    }
  });

  it('core imports no textlint package and performs no HTTP', () => {
    for (const file of walk(join(SRC, 'core'))) {
      const source = readFileSync(file, 'utf8');
      // Comments may *mention* textlint (core deliberately matches its offset convention); what is
      // forbidden is depending on it, or on a network transport.
      const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
      for (const specifier of imports) {
        expect(specifier, file).not.toMatch(/textlint/);
        expect(specifier, file).not.toMatch(/^node:(http|https|net|dns)$/);
      }
      expect(source, file).not.toMatch(/\bfetch\(|new Request\(|XMLHttpRequest/);
    }
  });
});
