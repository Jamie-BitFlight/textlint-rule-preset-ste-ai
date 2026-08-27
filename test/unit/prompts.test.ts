import { describe, expect, it } from 'vite-plus/test';
import { semanticConfigSchema } from '../../src/core/config.js';
import type { SemanticEvaluatorId } from '../../src/core/types.js';
import { buildEvaluatorRequest, evaluatorDefinitions } from '../../src/semantic/evaluators.js';
import {
  FilePromptProvider,
  renderTemplate,
  PromptError,
  parsePromptFile,
} from '../../src/semantic/prompt-loader.js';
import { candidateFor, EVALUATOR_PAYLOADS } from '../helpers/evaluator-payloads.js';
import { discoverPromptFiles } from '../helpers/prompt-corpus.js';

const provider = new FilePromptProvider();
const config = semanticConfigSchema.parse({ enabled: true, model: 'test-model' });
const PAYLOADS = EVALUATOR_PAYLOADS;

// Every prompt asset in every version directory, not only `v1` -- review found these safety
// checks hard-coded to `provider.get('v1', ...)` while `prompt-corpus.test.ts` already discovered
// every version. `docs/prompt-authoring.md` directs a behavioral prompt change into a new version
// directory, so a check pinned to `v1` alone would let a `v2` prompt skip every safety assertion
// below while CI stayed green.
const promptFiles = discoverPromptFiles();

describe('prompt assets', () => {
  it('every evaluator has a prompt asset, in every discovered version, whose id and version match', () => {
    expect(promptFiles.length).toBeGreaterThan(0);
    for (const file of promptFiles) {
      const template = provider.get(file.version, file.evaluatorId);
      expect(template.id).toBe(file.evaluatorId);
      expect(template.version).toBe(file.version);
    }
  });

  it('every prompt permits an uncertain answer and forbids prose output', () => {
    for (const file of promptFiles) {
      const { system } = provider.get(file.version, file.evaluatorId);
      const label = `${file.version}/${file.evaluatorId}`;
      expect(system, label).toContain('uncertain');
      expect(system.toLowerCase().replace(/\s+/g, ' '), label).toContain(
        'return only the json object',
      );
    }
  });

  it('every prompt forbids changing literals, negation, order, quantities and modal force', () => {
    for (const file of promptFiles) {
      const { system } = provider.get(file.version, file.evaluatorId);
      const label = `${file.version}/${file.evaluatorId}`;
      // Prompts are hard-wrapped, so a phrase may span a line break.
      const lower = system.toLowerCase().replace(/\s+/g, ' ');
      expect(lower, `${label}: negation`).toContain('negation');
      expect(lower, `${label}: order`).toContain('order');
      expect(lower, `${label}: modal`).toContain('modal force');
      expect(lower, `${label}: quantities`).toMatch(/quantit|tolerance/);
      expect(lower, `${label}: identifiers`).toMatch(/identifier|component|literal/);
    }
  });

  it('every prompt asks for an evidence span', () => {
    for (const file of promptFiles) {
      const { system } = provider.get(file.version, file.evaluatorId);
      const label = `${file.version}/${file.evaluatorId}`;
      expect(system, label).toContain('evidenceStart');
      expect(system, label).toContain('evidenceEnd');
    }
  });

  it('no prompt asks the model to reveal its reasoning', () => {
    for (const file of promptFiles) {
      const flat = provider
        .get(file.version, file.evaluatorId)
        .system.toLowerCase()
        .replace(/\s+/g, ' ');
      const label = `${file.version}/${file.evaluatorId}`;
      expect(flat, label).toContain('do not explain your reasoning');
      expect(flat, label).not.toMatch(/think step by step|chain of thought/);
    }
  });

  it('every prompt carries compliant, violating and hard-negative examples', () => {
    for (const file of promptFiles) {
      const { system } = provider.get(file.version, file.evaluatorId);
      const label = `${file.version}/${file.evaluatorId}`;
      expect(system, `${label}: compliant example`).toMatch(/Compliant:/);
      expect(system, `${label}: violating example`).toMatch(/Violation:/);
      expect(system, `${label}: hard negative`).toMatch(/Hard negative/);
    }
  });

  it('every prompt forbids rewriting the whole document', () => {
    for (const file of promptFiles) {
      const flat = provider
        .get(file.version, file.evaluatorId)
        .system.toLowerCase()
        .replace(/\s+/g, ' ');
      const label = `${file.version}/${file.evaluatorId}`;
      expect(flat, label).toMatch(/do not rewrite the document|you are a gate, not an editor/);
    }
  });
});

describe('request construction', () => {
  it('builds a request for every evaluator and sends exactly two messages', () => {
    for (const definition of evaluatorDefinitions) {
      const request = buildEvaluatorRequest(
        candidateFor(definition.id, PAYLOADS[definition.id]),
        config,
        provider,
      );
      expect(request.messages).toHaveLength(2);
      expect(request.messages[0]?.role).toBe('system');
      expect(request.messages[1]?.role).toBe('user');
      expect(request.evaluatorId).toBe(definition.id);
      expect(request.promptVersion).toBe('v1');
      expect(request.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('anchors offsets to the passage for most evaluators', () => {
    const candidate = candidateFor(
      'passive-voice-adjudication',
      PAYLOADS['passive-voice-adjudication'],
    );
    const request = buildEvaluatorRequest(candidate, config, provider);
    expect(request.passageLength).toBe(candidate.passage.length);
  });

  it('anchors offsets to the rewritten text for rewrite-equivalence', () => {
    const candidate = candidateFor('rewrite-equivalence', PAYLOADS['rewrite-equivalence']);
    const request = buildEvaluatorRequest(candidate, config, provider);
    expect(request.passageLength).toBe(String(PAYLOADS['rewrite-equivalence']['rewritten']).length);
  });

  it('sends only the payload keys the evaluator declares', () => {
    const candidate = candidateFor('one-instruction-per-sentence', {
      candidateVerbs: ['Remove', 'install'],
      secretInternalNote: 'this must never be transmitted',
    });
    const request = buildEvaluatorRequest(candidate, config, provider);
    const joined = request.messages.map((m) => m.content).join('\n');
    expect(joined).toContain('Remove');
    expect(joined).not.toContain('secretInternalNote');
    expect(joined).not.toContain('this must never be transmitted');
  });

  it('rejects a candidate that omits a required payload key', () => {
    expect(() =>
      buildEvaluatorRequest(candidateFor('noun-cluster-comprehension', {}), config, provider),
    ).toThrow(/missing payload key "cluster"/);
  });

  it('rejects an unknown evaluator id', () => {
    const candidate = candidateFor(
      'one-instruction-per-sentence',
      PAYLOADS['one-instruction-per-sentence'],
    );
    expect(() =>
      buildEvaluatorRequest(
        // Deliberately not a real id — this test exists to prove the *runtime* check catches
        // exactly what the cast bypasses statically. A type guard here would reject the value
        // before it could reach the function under test, defeating the test's purpose.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        { ...candidate, evaluatorId: 'nope' as SemanticEvaluatorId },
        config,
        provider,
      ),
    ).toThrow(/Unknown semantic evaluator/);
  });

  it('the content hash changes when the passage changes and is stable otherwise', () => {
    const base = candidateFor(
      'one-instruction-per-sentence',
      PAYLOADS['one-instruction-per-sentence'],
    );
    const a = buildEvaluatorRequest(base, config, provider).contentHash;
    const b = buildEvaluatorRequest({ ...base, id: 'other' }, config, provider).contentHash;
    const c = buildEvaluatorRequest(
      { ...base, passage: 'Different passage.' },
      config,
      provider,
    ).contentHash;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('golden: the rendered user message for one-instruction-per-sentence is stable', () => {
    const request = buildEvaluatorRequest(
      candidateFor('one-instruction-per-sentence', PAYLOADS['one-instruction-per-sentence']),
      config,
      provider,
    );
    // This golden previously pinned `...deterministic pass: - Remove` followed by a bare
    // `- install`, which froze a defect as the expected value: a golden test proves a rendering is
    // unchanged, never that it is correct. `prompt-corpus.test.ts` carries the structural check
    // that decides correctness; this one only guards against silent drift.
    expect(request.messages[1]?.content).toBe(
      [
        'ruleId: rule-x',
        '',
        'Invariants that must not change in any suggestion:',
        '- negation',
        '- modal force',
        '',
        'Candidate action verbs detected by the deterministic pass:',
        '- Remove',
        '- install',
        '',
        'Sentence (offsets are 0-based into this exact string):',
        'The filter must be replaced every 500 hours.',
      ].join('\n'),
    );
  });
});

describe('template rendering', () => {
  it('throws when a placeholder has no value', () => {
    expect(() => renderTemplate('a {{x}} b', {}, 'test')).toThrow(PromptError);
  });

  it('throws when a value has no placeholder, so silent drift is impossible', () => {
    expect(() => renderTemplate('a b', { x: '1' }, 'test')).toThrow(/no placeholder/);
  });

  it('substitutes every occurrence', () => {
    expect(renderTemplate('{{x}}-{{x}}', { x: 'v' }, 'test')).toBe('v-v');
  });
});

describe('prompt file parsing', () => {
  it('requires the three sections in order', () => {
    expect(() => parsePromptFile('<<<SYSTEM>>>\na\n<<<USER>>>\nb', 'x')).toThrow(PromptError);
    expect(() => parsePromptFile('<<<META>>>\nid: a\n<<<USER>>>\nb\n<<<SYSTEM>>>\nc', 'x')).toThrow(
      PromptError,
    );
  });

  it('requires id and version', () => {
    expect(() => parsePromptFile('<<<META>>>\nid: a\n<<<SYSTEM>>>\ns\n<<<USER>>>\nu', 'x')).toThrow(
      /must declare "id" and "version"/,
    );
  });

  it('rejects a prompt whose declared id does not match the file it was loaded as', () => {
    expect(() => provider.get('v1', 'not-an-evaluator')).toThrow(/No prompt asset/);
  });

  it('rejects a <<<META>>> line that is not a "key: value" pair', () => {
    // A line matching neither shape was silently dropped instead of rejected, so
    // `prompt-corpus.test.ts`'s "carries exactly the allowed metadata keys" claim was never
    // actually exercised against a malformed line: `owner Jamie` (no colon) never reached `meta`
    // at all, so `Object.keys(meta)` stayed exactly the allowed set regardless of what garbage
    // sat alongside it.
    expect(() =>
      parsePromptFile(
        '<<<META>>>\nid: a\nversion: v1\ntask: t\nowner Jamie\n<<<SYSTEM>>>\ns\n<<<USER>>>\nu',
        'x',
      ),
    ).toThrow(/<<<META>>> line that is not a "key: value" pair: "owner Jamie"/);
  });

  it('rejects a <<<META>>> key repeated more than once', () => {
    // A repeated key (two `task:` lines) silently overwrote the first value instead of being
    // rejected, so `prompt-corpus.test.ts`'s "no fewer and no more" claim was never actually
    // exercised against ambiguous, ordering-dependent metadata: `Object.keys(meta)` still equalled
    // exactly the allowed set regardless of which `task:` line won.
    expect(() =>
      parsePromptFile(
        '<<<META>>>\nid: a\nversion: v1\ntask: first\ntask: second\n<<<SYSTEM>>>\ns\n<<<USER>>>\nu',
        'x',
      ),
    ).toThrow(/<<<META>>> key "task" more than once/);
  });

  it('rejects a placeholder in <<<SYSTEM>>>, since that message is sent to the model unrendered', () => {
    // `noun-cluster-comprehension.md` carried `{{length}}` in <<<SYSTEM>>>; `variables` is derived
    // from <<<USER>>> alone, so nothing rendered it, and every real request sent the model the
    // literal text `{{length}}`. Every prompt asset in the repository is checked by
    // `prompt-corpus.test.ts`'s discovery loop, so this file's own fix is the only proof needed
    // that this guard fires on real content, not only on a hand-built fixture.
    expect(() =>
      parsePromptFile(
        '<<<META>>>\nid: a\nversion: v1\n<<<SYSTEM>>>\na {{x}} b\n<<<USER>>>\nu',
        'x',
      ),
    ).toThrow(/"\{" or "\}" character in <<<SYSTEM>>>/);
  });

  it('rejects every mustache-adjacent malformation review found, not only a well-formed placeholder', () => {
    // This guard was patched repeatedly chasing a *shape* of mustache token instead of the bare
    // character that makes one possible, and each patch closed exactly the case just reproduced and
    // left the next one open: a strict identifier pattern missed a space or a hyphen inside the
    // braces; excluding braces from the inner match class missed a nested-brace typo, which has no
    // substring matching that pattern at all; and even a non-greedy `[\s\S]*?\}\}` still requires a
    // *complete* closing `}}`, so a truncated typo with one or zero closing braces has no `}}`
    // anywhere to match. The guard no longer matches a shape at all -- it rejects the bare `{` or
    // `}` character, so every one of these malformations, flat, nested, or truncated, throws the
    // same way for the same reason.
    const malformed = [
      '{{ length }}', // space inside the braces
      '{{length-default}}', // hyphen inside the braces
      '{{foo{bar}}}', // nested brace: no substring matches a flat `\{\{[^{}]*\}\}` or `\{\{.*?\}\}`
      '{{length}', // truncated: only one closing brace
      '{{length', // truncated: no closing brace at all
      'length}}', // truncated: no opening brace at all
    ];
    for (const token of malformed) {
      expect(
        () =>
          parsePromptFile(
            `<<<META>>>\nid: a\nversion: v1\n<<<SYSTEM>>>\na ${token} b\n<<<USER>>>\nu`,
            'x',
          ),
        token,
      ).toThrow(/"\{" or "\}" character in <<<SYSTEM>>>/);
    }
  });

  it('rejects a malformed placeholder in <<<USER>>>, since it would otherwise reach the model literally', () => {
    // Review reproduced this against the real `buildEvaluatorRequest` flow: `{{ passage }}` (a
    // stray space) derives no variable, so nothing supplies a value for it and `renderTemplate`'s
    // identical strict regex never matches it either -- the model received the literal text
    // `Passage: {{ passage }}` in place of the real passage, with no error anywhere, because
    // `renderTemplate`'s "unused supplied value" guard only sees keys it was actually given, and
    // nothing was given for a placeholder `variables` never derived in the first place.
    for (const token of ['{{ passage }}', '{{passage-text}}', '{{passage}', '{{passage']) {
      expect(
        () =>
          parsePromptFile(
            `<<<META>>>\nid: a\nversion: v1\n<<<SYSTEM>>>\ns\n<<<USER>>>\na ${token} b`,
            'x',
          ),
        token,
      ).toThrow(/"\{" or "\}" character in <<<USER>>>/);
    }
  });

  it('still accepts a well-formed <<<USER>>> placeholder alongside literal prose', () => {
    // The <<<USER>>> guard strips every well-formed `{{name}}` placeholder before checking for a
    // stray brace, so a real template -- one or more good placeholders, no malformed one -- must not
    // throw. Every real prompt asset is exercised the same way by prompt-corpus.test.ts's discovery
    // loop; this fixture pins the guard's non-firing case directly.
    expect(() =>
      parsePromptFile(
        '<<<META>>>\nid: a\nversion: v1\n<<<SYSTEM>>>\ns\n<<<USER>>>\nPassage: {{passage}}\nWord: {{word}}',
        'x',
      ),
    ).not.toThrow();
  });

  it('every prompt states it performs exactly one classification task', () => {
    // `docs/prompt-authoring.md`'s "What every prompt must say" list leads with "One bounded
    // classification task," but nothing in this file asserted it -- a future prompt broadened into
    // a general or multi-task request could pass every other check here undetected.
    for (const file of promptFiles) {
      const { system } = provider.get(file.version, file.evaluatorId);
      const label = `${file.version}/${file.evaluatorId}`;
      expect(system.toLowerCase().replace(/\s+/g, ' '), label).toContain(
        'exactly one classification task',
      );
    }
  });
});
