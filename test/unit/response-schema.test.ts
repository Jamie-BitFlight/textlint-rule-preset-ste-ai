import { describe, expect, it } from 'vitest';
import {
  extractJson,
  semanticVerdictJsonSchema,
  validateSemanticResponse,
} from '../../src/semantic/response-schema.js';

const ctx = { expectedRuleId: 'r1', passageLength: 40 };

function valid(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ruleId: 'r1',
    status: 'violation',
    confidence: 0.8,
    evidenceStart: 2,
    evidenceEnd: 10,
    explanation: 'two actions',
    suggestedReplacements: [],
    meaningPreserved: true,
    ...overrides,
  });
}

describe('validateSemanticResponse', () => {
  it('accepts a well-formed verdict', () => {
    const result = validateSemanticResponse(valid(), ctx);
    expect(result.ok).toBe(true);
  });

  it('accepts a verdict wrapped in a fenced code block', () => {
    const result = validateSemanticResponse(`Here you go:\n\`\`\`json\n${valid()}\n\`\`\`\n`, ctx);
    expect(result.ok).toBe(true);
  });

  it('accepts a verdict followed by trailing prose', () => {
    const result = validateSemanticResponse(`${valid()}\n\nHope that helps.`, ctx);
    expect(result.ok).toBe(true);
  });

  const rejections: readonly [
    string,
    string,
    'invalid-response' | 'contradictory-response' | 'out-of-range',
  ][] = [
    ['no JSON at all', 'I think it is fine.', 'invalid-response'],
    ['truncated JSON', '{"ruleId":"r1","status":"vio', 'invalid-response'],
    ['unknown extra key', valid({ extra: 1 }), 'invalid-response'],
    ['missing key', '{"ruleId":"r1","status":"violation"}', 'invalid-response'],
    ['confidence above 1', valid({ confidence: 1.4 }), 'invalid-response'],
    ['confidence below 0', valid({ confidence: -0.1 }), 'invalid-response'],
    ['unknown status', valid({ status: 'maybe' }), 'invalid-response'],
    ['non-integer offsets', valid({ evidenceStart: 1.5 }), 'invalid-response'],
    ['negative offset', valid({ evidenceStart: -1 }), 'invalid-response'],
    ['empty explanation', valid({ explanation: '' }), 'invalid-response'],
    ['wrong rule id', valid({ ruleId: 'other' }), 'invalid-response'],
    [
      'too many replacements',
      valid({ suggestedReplacements: ['a', 'b', 'c', 'd'] }),
      'invalid-response',
    ],
    ['reversed evidence span', valid({ evidenceStart: 20, evidenceEnd: 5 }), 'out-of-range'],
    ['evidence beyond the passage', valid({ evidenceEnd: 999 }), 'out-of-range'],
    [
      'compliant with replacements',
      valid({ status: 'compliant', suggestedReplacements: ['x'] }),
      'contradictory-response',
    ],
    [
      'compliant but meaning not preserved',
      valid({ status: 'compliant', meaningPreserved: false }),
      'contradictory-response',
    ],
    [
      'suggests a replacement while denying meaning preservation',
      valid({ status: 'violation', suggestedReplacements: ['x'], meaningPreserved: false }),
      'contradictory-response',
    ],
    [
      'uncertain with very high confidence',
      valid({ status: 'uncertain', confidence: 0.99 }),
      'contradictory-response',
    ],
  ];

  for (const [label, raw, kind] of rejections) {
    it(`rejects ${label} as ${kind}`, () => {
      const result = validateSemanticResponse(raw, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe(kind);
    });
  }

  it('permits an uncertain verdict at moderate confidence', () => {
    const result = validateSemanticResponse(
      valid({ status: 'uncertain', confidence: 0.5, suggestedReplacements: [] }),
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it('permits a zero-length evidence span only by treating it as absent downstream', () => {
    const result = validateSemanticResponse(valid({ evidenceStart: 5, evidenceEnd: 5 }), ctx);
    expect(result.ok).toBe(true);
  });
});

describe('extractJson', () => {
  it('ignores braces inside strings', () => {
    expect(extractJson('{"a":"}{"}')).toEqual({ a: '}{' });
  });

  it('handles escaped quotes', () => {
    expect(extractJson('{"a":"say \\"hi\\""}')).toEqual({ a: 'say "hi"' });
  });

  it('returns null when there is no object', () => {
    expect(extractJson('[]')).toBeNull();
  });
});

describe('semanticVerdictJsonSchema', () => {
  it('forbids additional properties so grammar-constrained decoding matches the validator', () => {
    const schema = semanticVerdictJsonSchema as {
      additionalProperties?: boolean;
      required?: string[];
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(
      expect.arrayContaining([
        'ruleId',
        'status',
        'confidence',
        'evidenceStart',
        'evidenceEnd',
        'explanation',
        'suggestedReplacements',
        'meaningPreserved',
      ]),
    );
  });
});
