import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  BEGIN,
  END,
  controlSurfaceFields,
  renderControlSurfaceTable,
} from '../../scripts/lib/pack-control-surface.js';

/**
 * The pack control surface, generated rather than asserted.
 *
 * `docs/rule-pack-import.md` has to tell a pack author what a pack can and cannot change. Every
 * previous attempt to write that as a hand-maintained sentence went stale the moment the schema
 * grew a field, and external review kept catching it one omission at a time: an "only the
 * dictionary, the limits, and per-rule options and authority" claim silently dropped
 * `approvedTechnicalTerms`, `contractions`, and the per-rule `enabled`, `severity` and `sourceRef`
 * fields — while the same page's own example block used them.
 *
 * Answering that finding again in prose would buy one round. `scripts/lib/pack-control-surface.ts`
 * renders the table from `rulePackSchema` instead, and this test compares the committed page
 * against that renderer byte for byte. A schema field added without a description throws in the
 * renderer; a field added without regenerating the page fails here; and an edit to the page that
 * the renderer would not produce fails here too, so the page cannot be hand-tuned back out of sync.
 */

const DOC = resolve(import.meta.dirname, '..', '..', 'docs', 'rule-pack-import.md');
const REGENERATE = 'npx tsx scripts/write-pack-control-surface.ts';

/** The exact text the page carries between the two markers. */
function committedBlock(): string {
  const markdown = readFileSync(DOC, 'utf8');
  const start = markdown.indexOf(BEGIN);
  const end = markdown.indexOf(END);

  expect(start, `${DOC} is missing ${BEGIN}`).toBeGreaterThan(-1);
  expect(end, `${DOC} is missing ${END}`).toBeGreaterThan(start);

  return markdown.slice(start + BEGIN.length, end);
}

describe('documented pack control surface', () => {
  it('matches what the generator produces from the schema', () => {
    expect(committedBlock(), `${DOC} is stale. Run: ${REGENERATE}`).toBe(
      renderControlSurfaceTable(),
    );
  });

  it('derives a non-trivial surface, so a silently empty match cannot pass', () => {
    // Guards the assertion above. Zod's `def` layout is not public API, so a version bump could
    // make the walk return nothing; two empty tables compare equal and would leave this file
    // decorative. These are the fields whose omission caused the original review findings.
    const fields = controlSurfaceFields();

    expect(fields.length).toBeGreaterThan(10);
    expect(fields).toContain('approvedTechnicalTerms');
    expect(fields).toContain('contractions');
    expect(fields).toContain('rules[].severity');
    expect(fields).toContain('rules[].sourceRef');
  });

  it('refuses to render a field it has no description for', () => {
    // The ratchet: adding a schema field forces you to say what it controls, rather than silently
    // rendering a blank cell that reads as "this does nothing".
    const described = renderControlSurfaceTable();

    for (const field of controlSurfaceFields()) expect(described).toContain(`\`${field}\``);
  });
});
