import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { main } from '../../src/cli/main.js';

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

async function lint(name: string, text: string, ...flags: string[]): Promise<string> {
  const file = join(directory ?? tmpdir(), name);
  writeFileSync(file, text, 'utf8');
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const argv = process.argv;
  process.argv = ['node', 'ste-ai', 'lint', file, ...flags];
  try {
    await main();
    return stdout.mock.calls.map((call) => String(call[0])).join('');
  } finally {
    process.argv = argv;
    stdout.mockRestore();
  }
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
