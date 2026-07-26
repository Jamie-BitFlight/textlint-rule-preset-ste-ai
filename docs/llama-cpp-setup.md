# Running a local llama.cpp server

The semantic subsystem is optional. Everything below is only needed if you want semantic
adjudication; the deterministic rules never contact a service.

## What the client expects

A single HTTP route:

```
POST <endpoint>/v1/chat/completions
```

with an OpenAI-shaped body (`model`, `messages`, `temperature`, `max_tokens`, `stream: false`, and
`response_format: { type: "json_schema", json_schema: { … } }`), returning
`choices[0].message.content` as a string.

`llama-server` from llama.cpp provides this. So does any OpenAI-compatible server, which is why the
endpoint is configuration rather than a hard-coded assumption. The client is
`src/model-client/llama-client.ts`; it is injectable, so tests never need a real server.

## Build and run

```bash
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
cmake -B build && cmake --build build --config Release -j

./build/bin/llama-server \
  --model /models/your-model.gguf \
  --host 127.0.0.1 --port 8080 \
  --ctx-size 4096 \
  --parallel 2 \
  --temp 0
```

Or with a Hugging Face repo id:

```bash
./build/bin/llama-server -hf <org>/<repo>:<quant> --host 127.0.0.1 --port 8080 --ctx-size 4096
```

Confirm it is up and speaks the route:

```bash
curl -s http://127.0.0.1:8080/v1/models

curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"local","messages":[{"role":"user","content":"Reply with {\"ok\":true}"}],"max_tokens":32,"temperature":0}'
```

## Model choice

The evaluators are narrow classification tasks that must emit one small JSON object. That is a modest
requirement, and a small instruction-tuned model is usually adequate. What matters:

- **it must follow a JSON schema.** llama.cpp converts `response_format: json_schema` into a GBNF
  grammar, which makes malformed JSON nearly impossible. Every response is still validated —
  grammar-constrained decoding is a convenience, not a trust boundary.
- **`--ctx-size` must fit the prompt.** The largest prompt is `rewrite-equivalence`, which carries
  the original text, the rewrite, and the protected-literal list. 4096 tokens is comfortable for
  sentence-level passages.
- **temperature 0.** The broker sends `temperature: 0` and caches on a content hash, so repeated runs
  over unchanged text are reproducible. A non-zero temperature defeats both.
- **`--parallel` should be at least `semantic.maxConcurrency`**, otherwise requests queue and the
  latency percentiles in the evaluation report measure your queue rather than the model.

## Point the linter at it

`.ste-ai.json`:

```json
{
  "semantic": {
    "enabled": true,
    "endpoint": "http://127.0.0.1:8080",
    "model": "local-ste-adjudicator",
    "maxConcurrency": 2,
    "requestTimeoutMs": 20000,
    "defaultConfidenceThreshold": 0.7
  }
}
```

Then:

```bash
npx ste-ai lint docs/install.md --semantic --trace
```

`--trace` writes one JSON line per request to stderr with the prompt version, model id, content hash,
attempt count, cache-hit flag and latency. That is the audit trail for a semantic finding.

## Measuring it

The default test suite never needs a model. To measure evaluator quality against a real one:

```bash
npm run build

# tune prompts and thresholds here
npm run eval:semantic -- --split dev --endpoint http://127.0.0.1:8080 --model my-model

# report from here, and only here
npm run eval:semantic -- --split heldout --out eval-heldout.json
```

Output includes TP / FP / TN / FN, precision, recall, F1, uncertain rate, failure rate and p50/p90/p99
latency, per evaluator and overall. Ground truth comes from the fixture adjudication records, and
unadjudicated candidates are excluded and counted separately rather than guessed at. See
[`semantic-evaluators.md`](./semantic-evaluators.md#measurement).

**Split discipline:** `dev` is for tuning, `heldout` is for reporting. `--split heldout` is the
default and mixing requires `--split all` explicitly.

## If the service is down

Nothing breaks and nothing is silently passed. Per `diagnostics.onSemanticServiceFailure`:

- `notice` (default) — a run notice at `warning` level, plus `review-required` for each undecided
  passage;
- `error` — the same notice at `error` level, so the run fails; the CLI exits 3;
- `silent` — no diagnostics, notice still recorded for a programmatic caller to inspect.

Deterministic diagnostics are unaffected — there is a test asserting that an outage leaves the
deterministic finding set byte-identical to an offline run.

## Security notes

- Bind to `127.0.0.1`. The client sends document text to the endpoint; do not expose it.
- Protected content is masked out of the passages sent to evaluators, so code, credentials in
  configuration fragments, URLs and identifiers are not transmitted as prose. Verify this for your own
  corpus with `--trace` before pointing the linter at anything sensitive.
- `semantic.apiKey` is sent as a bearer token if set. Supply it via the environment, not the
  committed config file.
