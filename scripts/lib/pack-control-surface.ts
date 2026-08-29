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
 * The walk below is generic, not name-based. An earlier version special-cased `dictionary` and
 * `rules` and stopped after one level, so a field added under `metadata`, `limits`, or inside a
 * `dictionary.unapproved` entry changed nothing here and passed every test. `collectFields()`
 * instead recurses into every object shape and every array-of-object element, at any depth,
 * bottoming out only at a genuine leaf (string, number, boolean, enum, or an unvalidated
 * `z.record`, which `rules[].options` is by design — see "Extending the schema" on the page).
 *
 * A new leaf with no entry in `DESCRIPTIONS` throws rather than rendering a blank cell. That is the
 * ratchet: adding a field forces you to say what it controls.
 */

export const BEGIN = '<!-- pack-control-surface:begin -->';
export const END = '<!-- pack-control-surface:end -->';

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  metadata: 'Identity, declared authority, licence, and the conformance claim.',
  'metadata.id':
    "The identifier `trustedRulePackIds` must match. Not the pack's name or path. Letters, digits, and `._:@/+-` only.",
  'metadata.name': 'A human-readable label. Cosmetic. Nothing matches on it.',
  'metadata.version': "The pack's own version string, for the audit trail.",
  'metadata.authority':
    "The pack's declared authority. Capped at `supplementary` until the operator trusts the pack.",
  'metadata.licence': 'What the supplier asserts you may distribute, for the audit trail.',
  'metadata.source': 'Where the data came from, per the supplier, for the audit trail.',
  'metadata.retrievedAt': 'Optional. When the source data was retrieved, for the audit trail.',
  'metadata.conformanceClaim':
    'One of none, partial, or declared-by-supplier. Gates the `--json` conformance field.',
  'metadata.notice': 'Optional notice text, for the audit trail.',

  limits: 'The numeric thresholds. Grade levels, cluster length, step count.',
  'limits.proceduralMaxGradeLevel': 'Grade level above which a procedural sentence is reported.',
  'limits.descriptiveMaxGradeLevel': 'As above, for descriptive sentences.',
  'limits.sentenceReadabilityFloorWords': 'Sentences shorter than this are never grade-scored.',
  'limits.maxNounClusterLength': 'Word-count limit `noun-cluster-candidate` reports.',
  'limits.maxSentencesPerProceduralStep':
    'Sentence-count limit `list-instruction-structure` reports per numbered step.',

  dictionary: 'The controlled-language word lists.',
  'dictionary.approved': 'Terms whose permitted sense the semantic evaluators may check.',
  'dictionary.approved[].term': 'The approved term.',
  'dictionary.approved[].partsOfSpeech': 'Optional. Parts of speech the approval covers.',
  'dictionary.approved[].senses': 'Optional. Senses the approval covers.',
  'dictionary.unapproved': 'Terms `unapproved-vocabulary` reports, with their alternatives.',
  'dictionary.unapproved[].term': 'The unapproved term.',
  'dictionary.unapproved[].alternatives': 'Terms the diagnostic suggests instead.',
  'dictionary.unapproved[].note': 'Optional context shown with the diagnostic.',
  'dictionary.unapproved[].safeSubstitution':
    'True only if `alternatives[0]` cannot change technical meaning. Gates autofix.',
  'dictionary.unapproved[].partOfSpeech': 'Optional. The part of speech this entry covers.',
  'dictionary.preferred': 'Term mappings `preferred-terminology` reports.',
  'dictionary.preferred[].from': 'The discouraged term.',
  'dictionary.preferred[].to': 'The preferred term.',
  'dictionary.preferred[].safeSubstitution': 'True only if the substitution is always safe.',
  'dictionary.preferred[].note': 'Optional context shown with the diagnostic.',

  contractions: 'The contraction expansions `no-contractions` offers.',
  'contractions[].from': 'The contraction.',
  'contractions[].to': 'The expansion.',
  'contractions[].safeSubstitution': 'True only if the expansion is always safe to autofix.',
  'contractions[].note': 'Optional context shown with the diagnostic.',

  approvedTechnicalTerms: 'Literal names protected from matching, rewriting, and the heuristics.',

  rules: 'Per-rule authority and defaults.',
  'rules[].ruleId': 'Which registered rule the entry applies to.',
  'rules[].status': 'The authority a deterministic diagnostic reports.',
  'rules[].sourceRef': 'The citation a deterministic diagnostic reports.',
  'rules[].enabled': 'Whether the rule runs at all.',
  'rules[].severity': 'Default severity, below anything the user configures.',
  'rules[].options': 'Default options, below anything the user configures.',
};

// Not a legitimate depth for this schema — `rulePackSchema` bottoms out within a handful of
// levels. It exists only to turn a genuinely cyclic or pathological schema into a loud failure
// instead of an infinite recursion or a silent truncation. An earlier version used a silent
// truncation point instead (`if (depth > MAX_DEPTH) return;`): a field nested past it would vanish
// from the inventory with every test still green, defeating the "exhaustive" claim the same way
// the name-based special-casing this file replaced did. `unwrapToCore()` had its own separate
// version of that same bug, found in the same review round: a wrapper nested past its own depth
// bound returned still-wrapped instead of throwing, with the identical silent-vanishing effect one
// call site up. Both functions now share this one throwing bound.
const RUNAWAY_RECURSION_DEPTH = 50;

/**
 * Read one property without asserting a shape onto a Zod internal.
 *
 * Zod's `def` layout is not part of its public contract, so this walks it defensively: a missing or
 * renamed key yields `undefined` and the caller stops, rather than throwing somewhere less obvious.
 * `controlSurfaceFields()` returning a short list is what surfaces that, via the guard test.
 */
function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return Reflect.get(value, key);
}

/**
 * Strip `optional`/`default`/`nullable` wrappers to reach the schema they wrap.
 *
 * Throws past `RUNAWAY_RECURSION_DEPTH` rather than returning the still-wrapped schema, for the
 * same reason `collectFields()` does below: a silent cutoff here would make `objectShape()` and
 * `arrayElement()` see a wrapper as a leaf, and a field wrapped that deep would vanish from the
 * inventory with every test still green.
 */
function unwrapToCore(schema: unknown): unknown {
  let current = schema;

  for (let depth = 0; depth < RUNAWAY_RECURSION_DEPTH; depth += 1) {
    const inner = readProperty(readProperty(current, 'def'), 'innerType');
    if (inner === undefined) return current;
    current = inner;
  }

  throw new Error(
    `schema wrapper depth exceeded ${RUNAWAY_RECURSION_DEPTH} levels — rulePackSchema is not ` +
      'expected to wrap a field this deep; check for a cyclic reference.',
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The schema's field map, if it is (or wraps) a `z.object(...)`; `undefined` for anything else. */
function objectShape(schema: unknown): Record<string, unknown> | undefined {
  const shape = readProperty(unwrapToCore(schema), 'shape');
  return isPlainObject(shape) ? shape : undefined;
}

/** The element schema, if this is (or wraps) a `z.array(...)`; `undefined` for anything else. */
function arrayElement(schema: unknown): unknown {
  const core = unwrapToCore(schema);
  const def = readProperty(core, 'def');
  return readProperty(def, 'type') === 'array' ? readProperty(def, 'element') : undefined;
}

/**
 * Recurse into `schema` and append every reachable field path to `out`.
 *
 * An object schema contributes one path per key. An array of objects contributes one path per key
 * of its element, suffixed `[]` on the array's own path. An array of a scalar (`approvedTerms`,
 * `alternatives`) is a leaf: its own path is already pushed by the caller, and there is nothing
 * under it to enumerate. Anything else — string, number, boolean, enum, `z.record` — is a leaf too.
 */
function collectFields(schema: unknown, path: string, depth: number, out: string[]): void {
  if (depth > RUNAWAY_RECURSION_DEPTH) {
    throw new Error(
      `schema walk exceeded ${RUNAWAY_RECURSION_DEPTH} levels at "${path}" — rulePackSchema is ` +
        'not expected to nest this deep; check for a cyclic reference.',
    );
  }

  const shape = objectShape(schema);
  if (shape !== undefined) {
    for (const [key, child] of Object.entries(shape)) {
      const childPath = `${path}.${key}`;
      out.push(childPath);
      collectFields(child, childPath, depth + 1, out);
    }
    return;
  }

  const element = arrayElement(schema);
  if (element === undefined) return;

  const elementShape = objectShape(element);
  if (elementShape === undefined) return; // array of a scalar: `path` is already the leaf.

  const arrayPath = `${path}[]`;
  for (const [key, child] of Object.entries(elementShape)) {
    const childPath = `${arrayPath}.${key}`;
    out.push(childPath);
    collectFields(child, childPath, depth + 1, out);
  }
}

// A raw `|` inside a description would split the markdown table into phantom columns, so it is
// escaped defensively here rather than trusted to stay out of DESCRIPTIONS by convention alone.
function escapeTableCell(text: string): string {
  return text.replaceAll('|', '\\|');
}

/** Every field a pack author can set, in the notation the documentation uses. */
export function controlSurfaceFields(): string[] {
  const fields: string[] = [];

  for (const [key, value] of Object.entries(rulePackSchema.shape)) {
    fields.push(key);
    collectFields(value, key, 1, fields);
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

  const cells = fields.map((field) => ({
    field: `\`${field}\``,
    what: escapeTableCell(DESCRIPTIONS[field] ?? ''),
  }));
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
