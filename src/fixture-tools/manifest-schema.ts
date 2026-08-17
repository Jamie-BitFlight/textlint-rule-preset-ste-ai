import { z } from 'zod';

/**
 * Machine-readable provenance for the fixture corpus.
 *
 * Every fixture must be traceable to a licensed public source. `fixtures/provenance.lock.json`
 * is written by `scripts/fetch-sources.mjs` and records the bytes actually retrieved; the
 * validator cross-checks the manifest against it so a fabricated entry cannot pass.
 */

export const licenceEvidenceSchema = z
  .object({
    /** Where the licence statement is published. */
    url: z.url(),
    /** Verbatim licence statement, or the path of the licence file in the upstream repository. */
    quote: z.string().min(10),
    /** How the evidence was obtained. */
    method: z.enum(['licence-page', 'repository-licence-file', 'page-footer', 'statute']),
  })
  .strict();

export const fixtureCategorySchema = z.enum([
  'installation',
  'maintenance',
  'troubleshooting',
  'safety-warning',
  'descriptive',
  'api-configuration',
  'cli-reference',
  'structured-content',
  'hard-negative',
]);

export const fixtureEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,60}$/, 'ids are lower-case kebab-case'),
    title: z.string().min(3),
    sourceOrganisation: z.string().min(2),
    sourceUrl: z.url(),
    /** ISO-8601 date the source was retrieved. */
    retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** SPDX identifier where one exists, otherwise the licence's published name. */
    licence: z.string().min(2),
    licenceEvidence: licenceEvidenceSchema,
    /**
     * `reproduced` — verbatim, whole;
     * `excerpted`  — a verbatim contiguous or clearly-marked selection;
     * `adapted`    — wording changed by this project.
     */
    reproduction: z.enum(['reproduced', 'excerpted', 'adapted']),
    /**
     * Licence that governs this repository's rewritten counterpart. Share-alike sources propagate
     * their licence to the adaptation; permissive and public-domain sources do not.
     */
    derivativeLicence: z.string().min(2),
    category: fixtureCategorySchema,
    /** Expected dominant classification of the passage. */
    expectedClassification: z.enum(['procedural', 'descriptive', 'mixed']),
    /** Difficult features the fixture is meant to exercise. */
    difficultFeatures: z
      .array(
        z.enum([
          'passive-voice',
          'nested-conditions',
          'ambiguous-pronoun',
          'noun-cluster',
          'multiple-instructions',
          'inconsistent-terminology',
          'contractions',
          'long-sentences',
          'tables',
          'lists',
          'code-blocks',
          'identifiers',
          'units',
          'abbreviations',
          'front-matter',
          'admonitions',
        ]),
      )
      .default([]),
    /** Path relative to `fixtures/`. */
    originalPath: z.string().min(1),
    compliantPath: z.string().min(1),
    annotationPath: z.string().min(1),
    /**
     * Corpus split. `dev` fixtures may be used while tuning rules and prompts; `heldout` fixtures
     * must not be, so that the semantic evaluation numbers mean something.
     */
    split: z.enum(['dev', 'heldout']),
    /** SHA-256 of the original fixture file as committed, lower-case hex. */
    originalSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** SHA-256 of the rewritten fixture file as committed, lower-case hex. */
    compliantSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Key in `provenance.lock.json` proving the upstream fetch. */
    provenanceKey: z.string().min(1),
    notes: z.string().optional(),
  })
  .strict();

export const fixtureManifestSchema = z
  .object({
    $schema: z.string().optional(),
    generatedAt: z.string().min(4),
    /** Statement of why every fixture may be redistributed here. */
    licenceStatement: z.string().min(40),
    fixtures: z.array(fixtureEntrySchema).min(1),
  })
  .strict();

export const provenanceRecordSchema = z
  .object({
    url: z.url(),
    httpStatus: z.number().int(),
    fetchedAt: z.string().min(4),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
    contentType: z.string().optional(),
  })
  .strict();

export const provenanceLockSchema = z
  .object({
    generatedAt: z.string().min(4),
    records: z.record(z.string(), provenanceRecordSchema),
  })
  .strict();

export type FixtureEntry = z.output<typeof fixtureEntrySchema>;
export type FixtureManifest = z.output<typeof fixtureManifestSchema>;
export type ProvenanceLock = z.output<typeof provenanceLockSchema>;
