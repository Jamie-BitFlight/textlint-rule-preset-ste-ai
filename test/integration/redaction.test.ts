import { afterEach, describe, expect, it } from 'vitest';
import { analyseText } from '../../src/analysis/analyse.js';
import {
  startFakeSemanticService,
  verdictJson,
  type FakeService,
} from '../helpers/fake-semantic-service.js';

/**
 * Redaction: what actually crosses the wire.
 *
 * The protected-region machinery exists to keep code, credentials, paths, identifiers and quantities
 * out of prose judgement — and out of model requests. This test captures the real HTTP bodies the
 * client sends and asserts that no protected literal appears in any of them.
 *
 * It exists because this defect happened: the `ambiguous-pronoun-candidate` payload listed candidate
 * antecedents and included protected tokens' literal text, so a file path reached the service. A
 * protected token now contributes a placeholder naming its kind instead.
 */

let service: FakeService | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
});

const SENSITIVE = [
  ['fenced code', 'hunter2-DO-NOT-LEAK'],
  ['bearer token in a fence', 'sk-live-ABCDEF123456'],
  ['inline code', 'SUPERSECRET-INLINE'],
  ['configuration assignment', 'leak-me-please'],
  ['file path', '/srv/private/keys/id_rsa'],
  ['url host', 'internal.corp'],
] as const;

const DOCUMENT = [
  'The certificate is stored by the agent.',
  '',
  '```bash',
  'export SECRET_TOKEN=hunter2-DO-NOT-LEAK',
  'curl -H "Authorization: Bearer sk-live-ABCDEF123456" https://internal.corp/private',
  '```',
  '',
  'Set `DB_PASSWORD=SUPERSECRET-INLINE` before the value is written by the service.',
  '',
  'The file at /srv/private/keys/id_rsa is read by the daemon. It must be earthed.',
  '',
  'INTERNAL_API_KEY=leak-me-please',
  '',
].join('\n');

async function captureRequestBodies(text: string): Promise<string[]> {
  const bodies: string[] = [];
  service = await startFakeSemanticService({
    handler: (body) => {
      bodies.push(JSON.stringify(body));
      const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
      const ruleId = /ruleId:\s*(\S+)/.exec(user)?.[1] ?? 'unknown';
      return {
        content: verdictJson({
          ruleId,
          status: 'compliant',
          confidence: 0.9,
          evidenceStart: 0,
          evidenceEnd: 0,
          explanation: 'ok',
          suggestedReplacements: [],
          meaningPreserved: true,
        }),
      };
    },
  });
  await analyseText(text, {
    config: {
      semantic: {
        enabled: true,
        endpoint: service.url,
        model: 'fake',
        cache: false,
        maxRepairAttempts: 0,
      },
    },
  });
  return bodies;
}

describe('protected content is not transmitted', () => {
  it('sends at least one request, so the assertions below are meaningful', async () => {
    const bodies = await captureRequestBodies(DOCUMENT);
    expect(bodies.length).toBeGreaterThan(0);
  });

  it('no protected literal appears in any request body', async () => {
    const all = (await captureRequestBodies(DOCUMENT)).join('\n');
    for (const [what, literal] of SENSITIVE) {
      expect(all, `${what} (${literal}) was transmitted`).not.toContain(literal);
    }
  });

  it('a protected antecedent is described by its kind, not its text', async () => {
    const text = 'Connect /dev/ttyUSB0 to the controller. It must be earthed.\n';
    const all = (await captureRequestBodies(text)).join('\n');
    expect(all).not.toContain('/dev/ttyUSB0');
    // The signal that a protected candidate referent exists is still present.
    expect(all).toMatch(/«(file-path|identifier)»/);
  });

  it('prose the model needs is still transmitted', async () => {
    const all = (await captureRequestBodies(DOCUMENT)).join('\n');
    // The passages themselves must reach the service, otherwise nothing is being adjudicated.
    expect(all).toContain('is read by the daemon');
    expect(all).toContain('earthed');
  });

  it('every request carries the rule id and the invariants it must respect', async () => {
    const bodies = await captureRequestBodies(DOCUMENT);
    for (const body of bodies) {
      expect(body).toContain('ruleId:');
      expect(body).toMatch(/Invariants that must not change/);
    }
  });
});
