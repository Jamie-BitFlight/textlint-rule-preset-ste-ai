import { describe, expect, it } from 'vite-plus/test';
import { semanticConfigSchema } from '../../src/core/config.js';
import type { CandidatePassage, SemanticEvaluatorId } from '../../src/core/types.js';
import { buildEvaluatorRequest, evaluatorDefinitions } from '../../src/semantic/evaluators.js';
import {
  FilePromptProvider,
  renderTemplate,
  PromptError,
  parsePromptFile,
} from '../../src/semantic/prompt-loader.js';

const provider = new FilePromptProvider();
const config = semanticConfigSchema.parse({ enabled: true, model: 'test-model' });

function candidateFor(
  evaluatorId: SemanticEvaluatorId,
  payload: Record<string, unknown>,
): CandidatePassage {
  return {
    id: `c-${evaluatorId}`,
    ruleId: 'rule-x',
    evaluatorId,
    range: { start: 0, end: 5 },
    passage: 'The filter must be replaced every 500 hours.',
    passageOffset: 0,
    payload,
    invariants: ['negation', 'modal force'],
    reason: 'test',
    mode: 'descriptive',
    admonition: 'none',
  };
}

const PAYLOADS: Record<SemanticEvaluatorId, Record<string, unknown>> = {
  'approved-word-sense': {
    word: 'close',
    permittedSenses: ['to shut'],
    approvedAlternatives: ['near'],
    offsetInPassage: 4,
  },
  'permitted-part-of-speech': {
    word: 'test',
    permittedPartsOfSpeech: ['verb'],
    offsetInPassage: 4,
  },
  'one-instruction-per-sentence': { candidateVerbs: ['Remove', 'install'] },
  'passive-voice-adjudication': {
    construction: 'must be replaced',
    auxiliary: 'be',
    participle: 'replaced',
    hasExplicitAgent: false,
    mode: 'descriptive',
  },
  'pronoun-antecedent-ambiguity': {
    pronoun: 'It',
    possibleAntecedents: ['sensor', 'controller'],
    previousSentence: 'Connect the sensor to the controller.',
    offsetInPassage: 0,
  },
  'noun-cluster-comprehension': { cluster: 'engine oil pressure lamp', length: 4, limit: 3 },
  'technical-term-legitimacy': {
    term: 'hysteresis',
    domainHint: 'control systems',
    knownTerms: ['gain'],
  },
  'rewrite-equivalence': {
    original: 'Prior to installation, remove the bracket.',
    rewritten: 'Before installation, remove the bracket.',
    protectedLiterals: [],
  },
};

describe('prompt assets', () => {
  it('every evaluator has a v1 prompt asset whose id and version match', () => {
    for (const definition of evaluatorDefinitions) {
      const template = provider.get('v1', definition.id);
      expect(template.id).toBe(definition.id);
      expect(template.version).toBe('v1');
    }
  });

  it('every prompt permits an uncertain answer and forbids prose output', () => {
    for (const definition of evaluatorDefinitions) {
      const { system } = provider.get('v1', definition.id);
      expect(system, definition.id).toContain('uncertain');
      expect(system.toLowerCase().replace(/\s+/g, ' '), definition.id).toContain(
        'return only the json object',
      );
    }
  });

  it('every prompt forbids changing literals, negation, order, quantities and modal force', () => {
    for (const definition of evaluatorDefinitions) {
      const { system } = provider.get('v1', definition.id);
      // Prompts are hard-wrapped, so a phrase may span a line break.
      const lower = system.toLowerCase().replace(/\s+/g, ' ');
      expect(lower, `${definition.id}: negation`).toContain('negation');
      expect(lower, `${definition.id}: modal`).toContain('modal force');
      expect(lower, `${definition.id}: quantities`).toMatch(/quantit|tolerance/);
      expect(lower, `${definition.id}: identifiers`).toMatch(/identifier|component|literal/);
    }
  });

  it('every prompt asks for an evidence span', () => {
    for (const definition of evaluatorDefinitions) {
      const { system } = provider.get('v1', definition.id);
      expect(system, definition.id).toContain('evidenceStart');
      expect(system, definition.id).toContain('evidenceEnd');
    }
  });

  it('no prompt asks the model to reveal its reasoning', () => {
    for (const definition of evaluatorDefinitions) {
      const flat = provider.get('v1', definition.id).system.toLowerCase().replace(/\s+/g, ' ');
      expect(flat, definition.id).toContain('do not explain your reasoning');
      expect(flat, definition.id).not.toMatch(/think step by step|chain of thought/);
    }
  });

  it('every prompt carries compliant, violating and hard-negative examples', () => {
    for (const definition of evaluatorDefinitions) {
      const { system } = provider.get('v1', definition.id);
      expect(system, `${definition.id}: compliant example`).toMatch(/Compliant:/);
      expect(system, `${definition.id}: violating example`).toMatch(/Violation:/);
      expect(system, `${definition.id}: hard negative`).toMatch(/Hard negative/);
    }
  });

  it('every prompt forbids rewriting the whole document', () => {
    for (const definition of evaluatorDefinitions) {
      const flat = provider.get('v1', definition.id).system.toLowerCase().replace(/\s+/g, ' ');
      expect(flat, definition.id).toMatch(
        /do not rewrite the document|you are a gate, not an editor/,
      );
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
    expect(request.messages[1]?.content).toBe(
      [
        'ruleId: rule-x',
        '',
        'Invariants that must not change in any suggestion:',
        '- negation',
        '- modal force',
        '',
        'Candidate action verbs detected by the deterministic pass: - Remove',
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
});
