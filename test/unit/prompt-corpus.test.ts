import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { semanticConfigSchema } from '../../src/core/config.js';
import { buildEvaluatorRequest, evaluatorDefinitions } from '../../src/semantic/evaluators.js';
import { FilePromptProvider, parsePromptFile } from '../../src/semantic/prompt-loader.js';
import { candidateFor, MULTI_VALUE_PAYLOADS } from '../helpers/evaluator-payloads.js';

/**
 * Corpus-wide invariants over `prompts/<version>/*.md`.
 *
 * `prompts.test.ts` asks whether each prompt says the right things. This file asks whether the
 * corpus is internally consistent: that no prompt hand-maintains a copy of something the loader
 * derives, that the evaluator definitions and the templates agree on what is sent, and that the
 * rendered request is structurally readable once a rule pack supplies more than one value.
 *
 * Every check discovers its inputs rather than listing them, for the reason
 * `scripts/ci/check-textlint-configs-resolve.sh` gives: a check that names the files it guards
 * stops guarding the moment someone adds a file. Review found each of these three defects one file
 * at a time, and each fix was applied only to the file the reviewer had named. Discovery is what
 * converts "fix the two files that were pointed at" into "the corpus holds or the build fails".
 */

const PROMPTS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');

/**
 * The only keys `<<<META>>>` may carry.
 *
 * `id` and `version` are load-bearing: `FilePromptProvider` checks both against the path it loaded.
 * `task` is a one-line human summary with no derived counterpart. Anything else is either dead or a
 * hand-maintained copy of data the loader already computes — `variables:` was both, listing the
 * `{{...}}` placeholders that `parsePromptFile` derives from the template on every load.
 */
const ALLOWED_META_KEYS = new Set(['id', 'version', 'task']);

/** Placeholders every template may use, supplied from the candidate rather than its payload. */
const SHARED_VARIABLES = new Set(['ruleId', 'passage', 'invariants']);

interface PromptFile {
  readonly version: string;
  readonly evaluatorId: string;
  readonly path: string;
  readonly text: string;
}

/** Discover every prompt asset in the repository, for every version directory present. */
function discoverPromptFiles(): readonly PromptFile[] {
  const found: PromptFile[] = [];
  for (const version of readdirSync(PROMPTS_ROOT)) {
    const versionDir = join(PROMPTS_ROOT, version);
    if (!statSync(versionDir).isDirectory()) continue;
    for (const entry of readdirSync(versionDir)) {
      if (!entry.endsWith('.md')) continue;
      const path = join(versionDir, entry);
      found.push({
        version,
        evaluatorId: entry.slice(0, -'.md'.length),
        path,
        text: readFileSync(path, 'utf8'),
      });
    }
  }
  return found;
}

const promptFiles = discoverPromptFiles();

/**
 * Rendered lines that carry a list item no reader can attribute to a label.
 *
 * `formatValue` renders an array as `- one\n- two`. Substituted into the middle of a line, only the
 * first entry stays with its label and every later entry is stranded at the start of its own line,
 * where it is indistinguishable from a neighbouring field. Two shapes are rejected:
 *
 *  - a label followed by an inline list marker (`Permitted senses: - to shut`), and
 *  - a list item whose nearest preceding non-item line is not a label ending in `:` — which is what
 *    a blank line, or an outer list of `- Field: value` bullets, leaves behind.
 *
 * Exported so the check can be proved to fail on a template that has the defect. A structural
 * assertion nobody has watched fail is indistinguishable from no assertion.
 */
export function findUnattributableListLines(rendered: string): readonly string[] {
  const lines = rendered.split('\n');
  const offenders: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (/\S:[ \t]+- /.test(line)) {
      offenders.push(`line ${index + 1}: label with an inline list marker: ${line}`);
      continue;
    }
    if (!line.startsWith('- ')) continue;
    // Deliberately does not skip blank lines: a list must sit directly under its own label, and a
    // blank separator is exactly what breaks the association.
    const previous = lines.slice(0, index).findLast((candidate) => !candidate.startsWith('- '));
    if (previous === undefined || !previous.trimEnd().endsWith(':')) {
      offenders.push(`line ${index + 1}: list item under no label: ${line}`);
    }
  }
  return offenders;
}

describe('prompt corpus', () => {
  it('finds at least one prompt asset, so the discovered checks are not vacuous', () => {
    expect(promptFiles.length).toBeGreaterThan(0);
  });

  it('carries no metadata key outside the allowlist', () => {
    for (const file of promptFiles) {
      const { meta } = parsePromptFile(file.text, file.path);
      const unexpected = Object.keys(meta).filter((key) => !ALLOWED_META_KEYS.has(key));
      expect(unexpected, `${file.version}/${file.evaluatorId}`).toEqual([]);
    }
  });

  it('pairs every prompt asset with an evaluator definition, in both directions', () => {
    const declared = new Set(evaluatorDefinitions.map((definition) => definition.id));
    for (const version of new Set(promptFiles.map((file) => file.version))) {
      const inVersion = promptFiles.filter((file) => file.version === version);
      expect(new Set(inVersion.map((file) => file.evaluatorId)), version).toEqual(declared);
    }
  });

  it('declares exactly the payload keys its template consumes', () => {
    const provider = new FilePromptProvider();
    for (const file of promptFiles) {
      const definition = evaluatorDefinitions.find((entry) => entry.id === file.evaluatorId);
      expect(definition, `${file.evaluatorId} has no evaluator definition`).toBeDefined();
      if (definition === undefined) continue;
      const template = provider.get(file.version, file.evaluatorId);
      const consumed = template.variables
        .filter((variable) => !SHARED_VARIABLES.has(variable))
        .toSorted();
      // A key declared but never placed in the template is computed by a rule, carried through the
      // candidate, and then dropped without trace; a key placed but never declared fails the run.
      expect([...definition.payloadKeys].toSorted(), `${file.version}/${file.evaluatorId}`).toEqual(
        consumed,
      );
    }
  });

  it('requires only payload keys its template consumes', () => {
    const provider = new FilePromptProvider();
    for (const file of promptFiles) {
      const definition = evaluatorDefinitions.find((entry) => entry.id === file.evaluatorId);
      if (definition === undefined) continue;
      const consumed = new Set(provider.get(file.version, file.evaluatorId).variables);
      const requiredButUnused = definition.requiredKeys.filter((key) => !consumed.has(key));
      expect(requiredButUnused, `${file.version}/${file.evaluatorId}`).toEqual([]);
    }
  });
});

describe('rendered request structure', () => {
  const config = semanticConfigSchema.parse({ enabled: true, model: 'test-model' });
  const provider = new FilePromptProvider();

  it('keeps every supplied value attributable when a rule pack supplies several', () => {
    for (const definition of evaluatorDefinitions) {
      const request = buildEvaluatorRequest(
        candidateFor(definition.id, MULTI_VALUE_PAYLOADS[definition.id]),
        config,
        provider,
      );
      const user = request.messages[1]?.content ?? '';
      expect(findUnattributableListLines(user), definition.id).toEqual([]);
    }
  });

  it('renders every entry of a multi-entry array, not just the first', () => {
    const request = buildEvaluatorRequest(
      candidateFor('approved-word-sense', MULTI_VALUE_PAYLOADS['approved-word-sense']),
      config,
      provider,
    );
    const user = request.messages[1]?.content ?? '';
    for (const sense of ['to shut', 'to seal']) {
      expect(user, `permitted sense "${sense}"`).toContain(`- ${sense}`);
    }
  });

  it('catches a label whose array is substituted inline', () => {
    // The exact shape review found: the second entry is left at the start of its own line, where it
    // reads as a sibling of the field below it rather than as a second permitted sense.
    const offenders = findUnattributableListLines(
      ['Permitted senses: - to shut', '- to seal', 'Approved alternatives: - near'].join('\n'),
    );
    expect(offenders).toHaveLength(3);
  });

  it('catches a list stranded under an outer list of labelled bullets', () => {
    const offenders = findUnattributableListLines(
      ['- Word: close', '- Permitted senses:', '- to shut'].join('\n'),
    );
    expect(offenders.length).toBeGreaterThan(0);
  });

  it('accepts a list placed directly under its own label', () => {
    expect(
      findUnattributableListLines(
        ['Permitted senses supplied by the active rule pack:', '- to shut', '- to seal'].join('\n'),
      ),
    ).toEqual([]);
  });
});
