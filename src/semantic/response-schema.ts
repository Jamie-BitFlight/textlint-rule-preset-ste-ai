import { z } from 'zod';
import type { SemanticFailureKind, SemanticVerdict } from '../core/types.js';

/**
 * The one shape a model response may take.
 *
 * `strict: true` on the object (Zod's default for `z.object`) plus explicit bounds means a
 * response cannot smuggle extra fields, out-of-range confidence, or a reversed evidence span past
 * this gate. Grammar-constrained decoding is a convenience, not a trust boundary: every response
 * is validated here regardless of how it was produced.
 */
export const semanticVerdictSchema = z
  .object({
    ruleId: z.string().min(1).max(120),
    status: z.enum(['compliant', 'violation', 'uncertain']),
    confidence: z.number().min(0).max(1),
    evidenceStart: z.number().int().min(0),
    evidenceEnd: z.number().int().min(0),
    explanation: z.string().min(1).max(600),
    suggestedReplacements: z.array(z.string().max(600)).max(3),
    meaningPreserved: z.boolean(),
  })
  .strict();

export type ParsedSemanticVerdict = z.output<typeof semanticVerdictSchema>;

/** JSON Schema handed to the server for grammar-constrained decoding. */
export const semanticVerdictJsonSchema: unknown = z.toJSONSchema(semanticVerdictSchema);

export interface ValidationContext {
  readonly expectedRuleId: string;
  readonly passageLength: number;
}

export type ValidationResult =
  | { readonly ok: true; readonly verdict: SemanticVerdict }
  | { readonly ok: false; readonly kind: SemanticFailureKind; readonly message: string };

/**
 * Parse and sanity-check a raw model response.
 *
 * Rejections are typed so the broker can distinguish "the model produced nonsense"
 * (`invalid-response`), "the model contradicted itself" (`contradictory-response`) and "the
 * evidence span does not exist" (`out-of-range`). None of these is retried as a transport fault;
 * only the bounded repair path may re-ask.
 */
export function validateSemanticResponse(raw: string, ctx: ValidationContext): ValidationResult {
  const json = extractJson(raw);
  if (json === null) {
    return { ok: false, kind: 'invalid-response', message: 'response contained no JSON object' };
  }

  const parsed = semanticVerdictSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return { ok: false, kind: 'invalid-response', message: issues };
  }
  const v = parsed.data;

  if (v.ruleId !== ctx.expectedRuleId) {
    return {
      ok: false,
      kind: 'invalid-response',
      message: `ruleId "${v.ruleId}" does not match the requested rule "${ctx.expectedRuleId}"`,
    };
  }
  if (v.evidenceEnd < v.evidenceStart) {
    return { ok: false, kind: 'out-of-range', message: 'evidenceEnd precedes evidenceStart' };
  }
  if (v.evidenceEnd > ctx.passageLength) {
    return {
      ok: false,
      kind: 'out-of-range',
      message: `evidence span ends at ${v.evidenceEnd} but the passage is ${ctx.passageLength} characters`,
    };
  }

  // Contradictions. Each of these is a response that cannot be acted on coherently.
  if (v.status === 'compliant' && v.suggestedReplacements.length > 0) {
    return {
      ok: false,
      kind: 'contradictory-response',
      message: 'status is compliant but replacements were suggested',
    };
  }
  if (v.status === 'compliant' && !v.meaningPreserved) {
    return {
      ok: false,
      kind: 'contradictory-response',
      message: 'status is compliant but meaningPreserved is false',
    };
  }
  if (v.status === 'violation' && v.suggestedReplacements.length > 0 && !v.meaningPreserved) {
    return {
      ok: false,
      kind: 'contradictory-response',
      message: 'a replacement was suggested while meaningPreserved is false',
    };
  }
  if (v.status === 'uncertain' && v.confidence > 0.9) {
    return {
      ok: false,
      kind: 'contradictory-response',
      message: `status is uncertain but confidence is ${v.confidence}`,
    };
  }

  return { ok: true, verdict: v };
}

/**
 * Pull the first balanced JSON object out of a response.
 *
 * Small local models routinely wrap JSON in prose or a fenced block. Extracting rather than
 * demanding a bare object avoids discarding otherwise-valid answers, while the schema still does
 * all the deciding.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidates: string[] = [];
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim());
  candidates.push(trimmed);

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i += 1) {
      const ch = candidate[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}
