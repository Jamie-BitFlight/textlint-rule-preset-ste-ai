import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { z } from 'zod';
import { main } from '../../src/cli/main.js';
import { SteAiConfigError } from '../../src/core/config.js';

/** The subset of `--json`'s real output shape this test itself inspects. */
const jsonOutputSchema = z.object({
  results: z.array(
    z.object({
      suppressions: z.array(
        z.object({
          ruleId: z.string(),
          reason: z.string(),
          range: z.object({ start: z.number() }),
        }),
      ),
    }),
  ),
});

/**
 * What the CLI prints, as a reader sees it.
 *
 * The programmatic result is asserted elsewhere; what is asserted here is the presentation, because
 * a position printed in the AST's own convention is a position that does not match the reader's
 * editor. `main` is driven in-process rather than spawned so the test does not depend on `dist/`.
 */

let directory: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ste-ai-cli-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

/**
 * Drive `main()` in-process under a given argv, returning its exit code and everything it wrote to
 * stdout.
 *
 * Every test in this file goes through here, including the ones that only care about the exit code:
 * the `process.stdout.write` spy is what keeps a real CLI report out of the test reporter, and a
 * test that set `process.argv` and called `main()` by hand used to leak one. The `finally` restores
 * both the argv and the spy even when `main()` rejects, which the `--config` test below relies on.
 */
async function runCli(...args: string[]): Promise<{ code: number; stdout: string }> {
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const argv = process.argv;
  process.argv = ['node', 'ste-ai', ...args];
  try {
    const code = await main();
    return { code, stdout: stdout.mock.calls.map((call) => String(call[0])).join('') };
  } finally {
    process.argv = argv;
    stdout.mockRestore();
  }
}

async function lint(name: string, text: string, ...flags: string[]): Promise<string> {
  const file = join(directory ?? tmpdir(), name);
  writeFileSync(file, text, 'utf8');
  return (await runCli('lint', file, ...flags)).stdout;
}

const DOC = [
  '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling fixed by contract. -->',
  'The technician will utilise the bracket.',
  '',
].join('\n');

describe('ste-ai lint output', () => {
  it('prints one suppressed line per withheld finding, at a one-based column', async () => {
    const output = await lint('suppressed.md', DOC);
    // "utilise" is the 21st character of line 2, which is the column an editor shows.
    expect(output).toContain(
      '  suppressed  unapproved-vocabulary at 2:21 — Vendor spelling fixed by contract.\n',
    );
  });

  it('carries the withheld findings in --json', async () => {
    const output = await lint('suppressed.md', DOC, '--json');
    const parsed = jsonOutputSchema.parse(JSON.parse(output));
    const record = parsed.results[0]?.suppressions[0];
    expect(record?.ruleId).toBe('unapproved-vocabulary');
    expect(record?.reason).toBe('Vendor spelling fixed by contract.');
    // The machine-readable range stays a raw offset; only the printed line is reader-facing.
    expect(record?.range.start).toBe(DOC.indexOf('utilise'));
  });
});

describe('ste-ai lint --config', () => {
  it('reports an unrecognised key by name and path, not a raw ZodError dump', async () => {
    // `buildConfig` used to validate `--config` with `steAiConfigSchema.parse` directly, bypassing
    // `resolveConfig` — the one place that turns a `ZodError`'s JSON issue dump into a message
    // naming the offending key. `--config` is the most direct way an operator points the CLI at a
    // policy file, so it must fail exactly the way every other entry point already does.
    const dir = directory ?? tmpdir();
    const configFile = join(dir, 'bad-config.json');
    writeFileSync(
      configFile,
      JSON.stringify({ diagnostics: { severity: { 'style-preference': 'info' } } }),
      'utf8',
    );
    const docFile = join(dir, 'doc.md');
    writeFileSync(docFile, 'Some text.\n', 'utf8');

    let thrown: unknown;
    try {
      await runCli('lint', '--config', configFile, docFile);
    } catch (error) {
      thrown = error;
    }

    expect(thrown, 'expected main() to reject with SteAiConfigError').toBeInstanceOf(
      SteAiConfigError,
    );
    if (!(thrown instanceof SteAiConfigError)) throw thrown;
    expect(thrown.message).toContain('diagnostics.severity');
    expect(thrown.message).toContain('style-preference');
  });
});

/**
 * The exit-code contract these tests hold to is documented in README.md ("Exit codes: `0` clean,
 * `1` errors, `2` usage, `3` any `error`-level run notice") and in docs/configuration.md, which
 * spells out the same four codes and names the current `error`-level notices; docs/llama-cpp-setup.md
 * states the semantic-service case ("the CLI exits 3") separately. `src/cli/main.ts` implements it as
 * `if (infraFailure) return 3; if (totalErrors > 0) return 1;`.
 *
 * Asserting the exact code, not merely a nonzero one, is the point: `3` is what distinguishes "the
 * run had less protection than you configured" from `1` "the document has errors", and a caller
 * branching on the code is the only reason the distinction exists. `scripts/ci/check-exit-codes.sh`
 * asserts the same numbers against a built `dist/`, but only in CI; these run `main()` directly on
 * every `vp test`, and additionally assert what the operator sees on stdout — a clean-looking
 * report — which that script discards to /dev/null.
 */
describe('ste-ai lint exit code', () => {
  // Found in external review of PR #73: a clean document with a refused extraProtectedPatterns
  // entry printed "0 error(s)" and exited 0, because invalid-protected-pattern is a RunNotice, not
  // a diagnostic, and only semantic-service-failure was wired to the exit code. A CI pipeline
  // gating on exit status alone would see success even though the configured literal was neither
  // protected nor withheld from the semantic service — the exact failure #7 exists to surface.
  it('is 3 when a protected pattern is refused, even on an otherwise clean document', async () => {
    const dir = directory ?? tmpdir();
    const configFile = join(dir, 'bad-pattern-config.json');
    writeFileSync(configFile, JSON.stringify({ extraProtectedPatterns: ['([unclosed'] }), 'utf8');
    const docFile = join(dir, 'clean.md');
    writeFileSync(docFile, 'Nothing wrong with this document.\n', 'utf8');

    const { code, stdout } = await runCli('lint', '--config', configFile, docFile);

    expect(code).toBe(3);
    // The two halves of the bug together: the report reads clean, and the code says otherwise.
    // Asserting only `not.toBe(0)` let `3` regress to `1` — indistinguishable, from the caller's
    // side, from a document that simply has errors.
    expect(stdout).toContain('invalid-protected-pattern');
    expect(stdout).toContain('0 error(s), 0 review-required');
  });

  // Found in external review of PR #73, a second round: the exit code was gated on a hardcoded
  // set of two notice codes, so a rule skipped over invalid options — `rule-options-invalid`, also
  // always `error`-level — produced the same silent "0 error(s), exit 0" the previous fix was
  // meant to eliminate. Fixed by gating on `level === 'error'` for any run notice instead of
  // naming codes one at a time.
  it('is 3 when a rule is skipped for invalid options, even on an otherwise clean document', async () => {
    const dir = directory ?? tmpdir();
    const configFile = join(dir, 'bad-options-config.json');
    writeFileSync(
      configFile,
      JSON.stringify({ rules: { 'abbreviation-introduction': { minLength: 8, maxLength: 3 } } }),
      'utf8',
    );
    const docFile = join(dir, 'clean.md');
    writeFileSync(docFile, 'Nothing wrong with this document.\n', 'utf8');

    const { code, stdout } = await runCli('lint', '--config', configFile, docFile);

    expect(code).toBe(3);
    expect(stdout).toContain('rule-options-invalid');
    expect(stdout).toContain('0 error(s), 0 review-required');
  });
});
