import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import type {
  CompletionRequest,
  CompletionResponse,
  ModelTransport,
} from '../../src/model-client/types.js';

/**
 * Matches `FakeServiceOptions['handler']`'s own parameter type for `model`/`messages` — the two
 * fields this file's own code reads — and passes every other field of the real request body
 * through untouched via `.catchall`, rather than stripping them: a caller's `handler` receives
 * this same parsed object (see `options.handler(parsed)` below) and several tests inspect fields
 * this schema does not itself model (`response_format`, for one) to verify what the real HTTP
 * client actually sent.
 */
const requestBodySchema = z
  .object({
    model: z.string().optional(),
    messages: z.array(z.object({ role: z.string(), content: z.string() })).optional(),
  })
  .catchall(z.unknown());

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
      let parsed: z.output<typeof requestBodySchema> = {};
      try {
        // `safeParse` (not `parse`) matches the same tolerance the old comment here described by
        // hand: every field of `parsed` is already optional and every real consumer below reads
        // it through `?.` (`body.messages?.find(...)`, `parsed.model ?? 'fake'`), so an
        // unexpected-but-parseable request shape from this fake server's own tests degrades to a
        // missing field via the `{}` fallback, not a crash. Only genuinely invalid JSON — caught
        // below — is a hard failure.
        const json: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = requestBodySchema.safeParse(json);
        parsed = result.success ? result.data : {};
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
  const address = server.address();
  // `server.address()` is `string | AddressInfo | null` in general (a string for a Unix socket,
  // null before listening) — but `listen(port, host, ...)` above always binds a TCP/IP address, so
  // this is a real check, not an assumption, and fails loudly if that ever stops being true.
  if (address === null || typeof address === 'string') {
    throw new Error('fake semantic service: expected a TCP address after listen()');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requestCount: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
  };
}
