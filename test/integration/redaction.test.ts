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

/**
 * Credential shapes that sit in *bare prose*, with no fence, no backticks and no `KEY=value`
 * around them. Structurally these are ordinary words, so every other protected-region pass ignores
 * them and they were transmitted verbatim. Each entry is a value a reader could realistically paste
 * into a sentence.
 */
const BARE_PROSE_CREDENTIALS = [
  ['aws access key id', 'AKIAIOSFODNN7EXAMPLE'],
  ['github personal access token', 'ghp_16C7e42F292c6912E7710c838347Ae1781234'],
  ['openai-style key', 'sk-live-9fA2bC4dE6fG8hJ0kL2mN4pQ'],
  ['slack token', 'xoxb-1234567890-abcdefghijkl'],
  ['google api key', 'AIzaSyD-1234567890abcdefghijklmnopqrstuv'],
  ['gitlab token', 'glpat-9fA2bC4dE6fG8hJ0kL2m'],
  ['hex digest', 'a3f5c9d2e8b1074c6f2a9e5d3b8c1f70'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'],
  ['base64 secret', 'aGVsbG9Xb3JsZDEyMzQ1Njc4OTBhYmNkZWY'],
  ['password bound in prose', 'hunter2'],
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

  it('no credential-shaped token in bare prose is transmitted', async () => {
    const document = [
      `The account uses ${BARE_PROSE_CREDENTIALS[0][1]} as the identity of the caller.`,
      '',
      `Set the token ${BARE_PROSE_CREDENTIALS[1][1]} in the environment before the daemon is started.`,
      '',
      `The service was configured with ${BARE_PROSE_CREDENTIALS[2][1]} by the operator.`,
      '',
      `Post the message with ${BARE_PROSE_CREDENTIALS[3][1]} and the channel identifier.`,
      '',
      `The request is signed with ${BARE_PROSE_CREDENTIALS[4][1]} by the gateway.`,
      '',
      `Register ${BARE_PROSE_CREDENTIALS[5][1]} with the runner so the job can be started.`,
      '',
      `The digest ${BARE_PROSE_CREDENTIALS[6][1]} is written to the manifest by the packager.`,
      '',
      `Send ${BARE_PROSE_CREDENTIALS[7][1]} to the endpoint that was given to you.`,
      '',
      `The value ${BARE_PROSE_CREDENTIALS[8][1]} is decoded by the loader.`,
      '',
      `The default password is ${BARE_PROSE_CREDENTIALS[9][1]} and it must be changed by the installer.`,
      '',
    ].join('\n');
    const all = (await captureRequestBodies(document)).join('\n');
    for (const [what, literal] of BARE_PROSE_CREDENTIALS) {
      expect(all, `${what} (${literal}) was transmitted`).not.toContain(literal);
    }
    // The surrounding prose must survive — the passages are still adjudicated, only the value is
    // withheld. If this fails the pass is masking sentences instead of tokens.
    expect(all).toContain('is written to the manifest by the packager');
    expect(all).toContain('must be changed by the installer');
  });

  it('prose that only mentions credentials is left alone', async () => {
    const text = [
      'The password is set by the installer during the first start of the service.',
      '',
      'The private key is stored in the vault and it is never written to the log.',
      '',
      'Disconnect the electromagnetic interference suppression assembly from the connector.',
      '',
    ].join('\n');
    const all = (await captureRequestBodies(text)).join('\n');
    // These are ordinary sentences that happen to contain credential nouns. Masking them would be
    // a silent loss of coverage, so the words must still reach the service.
    expect(all).toContain('set by the installer');
    expect(all).toContain('stored in the vault');
    expect(all).toContain('electromagnetic interference suppression assembly');
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
