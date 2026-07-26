import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  CompletionRequest,
  CompletionResponse,
  ModelTransport,
} from '../../src/model-client/types.js';

/**
 * Test doubles for the semantic service.
 *
 * Two levels are provided on purpose:
 *
 * - {@link ScriptedTransport} replaces the transport interface. Fast, used by unit tests for
 *   broker behaviour (ordering, concurrency, caching, repair).
 * - {@link startFakeSemanticService} is a real HTTP server speaking the llama.cpp
 *   OpenAI-compatible route. Used by integration tests, because a transport double cannot prove
 *   that the HTTP client sends and parses what a real server expects.
 */

export interface ScriptedReply {
  /** Raw assistant content the transport returns. */
  readonly content?: string;
  /** Throw this instead of replying. */
  readonly error?: Error;
  /** Delay before replying, to exercise concurrency limits. */
  readonly delayMs?: number;
}

export class ScriptedTransport implements ModelTransport {
  readonly requests: CompletionRequest[] = [];
  /** Highest number of overlapping in-flight calls observed. */
  peakConcurrency = 0;
  #inFlight = 0;
  #replies: ScriptedReply[];
  readonly #fallback: ScriptedReply | undefined;

  constructor(replies: ScriptedReply[], fallback?: ScriptedReply) {
    this.#replies = [...replies];
    this.#fallback = fallback;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request);
    this.#inFlight += 1;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.#inFlight);
    try {
      const reply = this.#replies.shift() ?? this.#fallback;
      if (reply === undefined) throw new Error('ScriptedTransport ran out of replies');
      if (reply.delayMs !== undefined && reply.delayMs > 0) {
        await new Promise((r) => setTimeout(r, reply.delayMs));
      }
      if (reply.error !== undefined) throw reply.error;
      return { text: reply.content ?? '', modelId: request.model };
    } finally {
      this.#inFlight -= 1;
    }
  }
}

export interface VerdictShape {
  ruleId: string;
  status: 'compliant' | 'violation' | 'uncertain';
  confidence: number;
  evidenceStart: number;
  evidenceEnd: number;
  explanation: string;
  suggestedReplacements: string[];
  meaningPreserved: boolean;
}

export function verdictJson(overrides: Partial<VerdictShape> & { ruleId: string }): string {
  const verdict: VerdictShape = {
    status: 'violation',
    confidence: 0.9,
    evidenceStart: 0,
    evidenceEnd: 1,
    explanation: 'test verdict',
    suggestedReplacements: [],
    meaningPreserved: true,
    ...overrides,
  };
  return JSON.stringify(verdict);
}

export interface FakeServiceOptions {
  /**
   * Produce the assistant content for a request. Receives the parsed request body so a handler can
   * branch on the rule id or the prompt.
   */
  readonly handler: (body: { model?: string; messages?: { role: string; content: string }[] }) => {
    status?: number;
    body?: unknown;
    content?: string;
    delayMs?: number;
  };
}

export interface FakeService {
  readonly url: string;
  readonly requestCount: () => number;
  readonly close: () => Promise<void>;
}

/** Start a real HTTP server that behaves like llama.cpp's OpenAI-compatible endpoint. */
export async function startFakeSemanticService(options: FakeServiceOptions): Promise<FakeService> {
  let requests = 0;
  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests += 1;
      let parsed: { model?: string; messages?: { role: string; content: string }[] } = {};
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof parsed;
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad json' } }));
        return;
      }
      const reply = options.handler(parsed);
      const send = (): void => {
        if (reply.status !== undefined && reply.status >= 400) {
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(reply.body ?? { error: { message: 'error' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            reply.body ?? {
              model: parsed.model ?? 'fake',
              choices: [{ message: { role: 'assistant', content: reply.content ?? '' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            },
          ),
        );
      };
      if (reply.delayMs !== undefined && reply.delayMs > 0) setTimeout(send, reply.delayMs);
      else send();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requestCount: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}
