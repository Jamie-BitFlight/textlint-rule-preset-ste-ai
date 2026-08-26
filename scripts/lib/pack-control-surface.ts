import { rulePackSchema } from '../../src/rule-pack/schema.js';

/**
 * Render the pack control-surface table in `docs/rule-pack-import.md` from `rulePackSchema`.
 *
 * The page has to tell a pack author what a pack can and cannot change. Every hand-maintained
 * version of that list went stale the moment the schema grew a field, and external review caught it
 * one omission at a time. So the table is produced here rather than typed into the page: run
 * `npx tsx scripts/write-pack-control-surface.ts` to write it, and
 * `test/architecture/doc-pack-control-surface.test.ts` fails when the page and this renderer
 * disagree.
 *
 * A new schema field with no entry in `DESCRIPTIONS` throws rather than rendering a blank cell.
 * That is the ratchet: adding a field forces you to say what it controls.
 */

export const BEGIN = '<!-- pack-control-surface:begin -->';
export const END = '<!-- pack-control-surface:end -->';

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  approvedTechnicalTerms: 'Literal names protected from matching, rewriting, and the heuristics.',
  contractions: 'The contraction expansions `no-contractions` offers.',
  dictionary: 'The controlled-language word lists.',
  'dictionary.approved': 'Terms whose permitted sense the semantic evaluators may check.',
  'dictionary.preferred': 'Term mappings `preferred-terminology` reports.',
  'dictionary.unapproved': 'Terms `unapproved-vocabulary` reports, with their alternatives.',
  limits: 'The numeric thresholds. Grade levels, cluster length, step count.',
  metadata: 'Identity, declared authority, licence, and the conformance claim.',
  rules: 'Per-rule authority and defaults.',
  'rules[].enabled': 'Whether the rule runs at all.',
  'rules[].options': 'Default options, below anything the user configures.',
  'rules[].ruleId': 'Which registered rule the entry applies to.',
  'rules[].severity': 'Default severity, below anything the user configures.',
  'rules[].sourceRef': 'The citation a deterministic diagnostic reports.',
  'rules[].status': 'The authority a deterministic diagnostic reports.',
};

/**
 * Read one property without asserting a shape onto a Zod internal.
 *
 * Zod's `def` layout is not part of its public contract, so this walks it defensively: a missing or
 * renamed key yields `undefined` and the caller stops, rather than throwing somewhere less obvious.
 * `controlSurfaceFields()` returning a short or empty list is what surfaces that, via the guard
 * assertion in the test.
 */
function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return Reflect.get(value, key);
}

function shapeKeys(value: unknown): string[] {
  const shape = readProperty(value, 'shape');
  if (typeof shape !== 'object' || shape === null) return [];
  return Object.keys(shape);
}

/** `z.array(x).default([])` wraps the element type more than once; reach the element schema. */
function unwrapArray(value: unknown): unknown {
  let current = value;

  for (let depth = 0; depth < 8; depth += 1) {
    const def = readProperty(current, 'def');
    if (def === undefined) return current;

    const element = readProperty(def, 'element');
    if (readProperty(def, 'type') === 'array' && element !== undefined) {
      current = element;
      continue;
    }

    const inner = readProperty(def, 'innerType');
    if (inner === undefined) return current;
    current = inner;
  }

  return current;
}

/** Every field a pack author can set, in the notation the documentation uses. */
export function controlSurfaceFields(): string[] {
  const fields: string[] = [];

  for (const [key, value] of Object.entries(rulePackSchema.shape)) {
    fields.push(key);

    // One level down for the two containers whose members the documentation names individually.
    // Anything deeper is described by the schema excerpt on the page, not by this table.
    if (key !== 'dictionary' && key !== 'rules') continue;

    const inner = key === 'rules' ? unwrapArray(value) : value;
    const prefix = key === 'rules' ? 'rules[]' : key;
    for (const child of shapeKeys(inner)) fields.push(`${prefix}.${child}`);
  }

  return fields.toSorted();
}

/** The markdown table body, between the two markers, with a blank line on each side. */
export function renderControlSurfaceTable(): string {
  const fields = controlSurfaceFields();
  const missing = fields.filter((field) => DESCRIPTIONS[field] === undefined);

  if (missing.length > 0) {
    throw new Error(
      `No description for pack field(s): ${missing.join(', ')}. ` +
        'Add one to DESCRIPTIONS in scripts/lib/pack-control-surface.ts, then re-run ' +
        'npx tsx scripts/write-pack-control-surface.ts',
    );
  }

  const cells = fields.map((field) => ({ field: `\`${field}\``, what: DESCRIPTIONS[field] ?? '' }));
  const fieldWidth = Math.max(...cells.map((c) => c.field.length), 'Field'.length);
  const whatWidth = Math.max(...cells.map((c) => c.what.length), 'What it controls'.length);

  const row = (left: string, right: string): string =>
    `| ${left.padEnd(fieldWidth)} | ${right.padEnd(whatWidth)} |`;

  // The leading and trailing blank lines are what the repository's formatter produces around a
  // fenced-off table. Emitting them here keeps `vp check` and this renderer agreeing: without them
  // the formatter reflows the block on commit and the generated table stops matching the page.
  return [
    '',
    '',
    row('Field', 'What it controls'),
    `| ${'-'.repeat(fieldWidth)} | ${'-'.repeat(whatWidth)} |`,
    ...cells.map((c) => row(c.field, c.what)),
    '',
    '',
  ].join('\n');
}

/** Replace the marked block in `markdown`, or throw when the markers are absent. */
export function withRenderedTable(markdown: string): string {
  const start = markdown.indexOf(BEGIN);
  const end = markdown.indexOf(END);

  if (start === -1 || end <= start) {
    throw new Error(`Document is missing the ${BEGIN} / ${END} markers.`);
  }

  return (
    markdown.slice(0, start + BEGIN.length) + renderControlSurfaceTable() + markdown.slice(end)
  );
}
