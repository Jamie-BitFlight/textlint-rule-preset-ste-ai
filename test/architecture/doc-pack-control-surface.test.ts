import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { rulePackSchema } from '../../src/rule-pack/schema.js';

/**
 * The pack control surface, derived rather than asserted.
 *
 * `docs/rule-pack-import.md` has to tell a pack author what a pack can and cannot change. Every
 * previous attempt to write that as a hand-maintained sentence went stale the moment the schema
 * grew a field, and external review kept catching it one omission at a time: an "only the
 * dictionary, the limits, and per-rule options and authority" claim silently dropped
 * `approvedTechnicalTerms`, `contractions`, and the per-rule `enabled`, `severity` and `sourceRef`
 * fields — while the same page's own example block used them.
 *
 * Answering that finding again in prose would buy one round. The list is generated from
 * `rulePackSchema` instead, and this test fails if the documentation and the schema disagree in
 * either direction. Adding a field to the schema without documenting it is now a build failure,
 * and so is documenting a field that does not exist.
 */

const DOC = resolve(import.meta.dirname, '..', '..', 'docs', 'rule-pack-import.md');
const BEGIN = '<!-- pack-control-surface:begin -->';
const END = '<!-- pack-control-surface:end -->';

/**
 * Read one property without asserting a shape onto a Zod internal.
 *
 * Zod's `def` layout is not part of its public contract, so this walks it defensively: a missing
 * or renamed key yields `undefined` and the caller stops, rather than throwing somewhere less
 * obvious. The two assertions at the bottom of this file are what catch that, by failing when the
 * derived surface stops looking like a real one.
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
function schemaControlSurface(): string[] {
  const surface: string[] = [];

  for (const [key, value] of Object.entries(rulePackSchema.shape)) {
    surface.push(key);

    // One level down for the two containers whose members the documentation names individually.
    // Anything deeper is described by the schema excerpt on the page, not by this table.
    if (key !== 'dictionary' && key !== 'rules') continue;

    const inner = key === 'rules' ? unwrapArray(value) : value;
    const prefix = key === 'rules' ? 'rules[]' : key;
    for (const child of shapeKeys(inner)) surface.push(`${prefix}.${child}`);
  }

  return surface.toSorted();
}

/** The identifiers the documentation lists in the generated block's first column. */
function documentedControlSurface(): string[] {
  const markdown = readFileSync(DOC, 'utf8');
  const start = markdown.indexOf(BEGIN);
  const end = markdown.indexOf(END);

  expect(start, `${DOC} is missing ${BEGIN}`).toBeGreaterThan(-1);
  expect(end, `${DOC} is missing ${END}`).toBeGreaterThan(start);

  const block = markdown.slice(start + BEGIN.length, end);
  const documented: string[] = [];

  for (const line of block.split('\n')) {
    const row = line.trim();
    if (!row.startsWith('|')) continue;
    const firstColumn = row.split('|')[1]?.trim() ?? '';
    const identifier = /^`([^`]+)`$/.exec(firstColumn)?.[1];
    if (identifier !== undefined) documented.push(identifier);
  }

  return documented.toSorted();
}

describe('documented pack control surface', () => {
  it('lists every field the schema exposes, and no field it does not', () => {
    expect(documentedControlSurface()).toStrictEqual(schemaControlSurface());
  });

  it('derives a non-trivial surface, so a silently empty match cannot pass', () => {
    // Guards the assertion above: two empty lists are equal, and would make this file decorative.
    const surface = schemaControlSurface();

    expect(surface.length).toBeGreaterThan(10);
    expect(surface).toContain('approvedTechnicalTerms');
    expect(surface).toContain('rules[].severity');
  });
});
