# superglm

[中文说明](README.zh-CN.md)

Give text-only models eyes and a brain.

superglm is not just another API proxy. It's a **model enhancement gateway** deployed on Cloudflare Workers that does two things nobody else does:

1. **Vision injection**: when a text-only model (GLM, DeepSeek, Qwen, etc.) receives an image, superglm automatically converts the image into a structured textual evidence packet and injects it into the conversation. Text-only models can now "see" and respond to image content.
2. **Mixture-of-experts fusion**: multiple cheap models answer in parallel as a panel, then a synthesizer model distills all responses into one final answer. Results approach flagship quality at a fraction of the cost.

In one sentence: **use cheap text-only models to achieve flagship-level performance.**

## What Problem It Solves

You already have a bunch of cheap, capable models. But:

- They don't support images. Users send a picture and get an error.
- Used individually, quality is inconsistent. Sometimes great, sometimes meh.
- Flagship models are too expensive for everyday use.

superglm solves all of this at the gateway layer:

| Problem | How superglm handles it |
|---------|------------------------|
| Text-only models can't see images | Images auto-converted to textual evidence packets (image_policy: evidence_only). The model responds as if it received a description. |
| Single model quality isn't enough | Multi-model parallel answering + synthesizer distillation (Fusion). Three heads are better than one. |
| Want vision models to see raw images | image_policy: keep_for_vision_panels. Raw image blocks pass through to vision-capable panels. |
| Don't want Fusion touching images | image_policy: reject. Returns 400 if any image is detected. |
| Too many panels might overload | max_panel_count + max_parallel_panels hard caps. Defaults: max 12 panels, 6 concurrent. |
| A provider goes down | Automatic failover to same-protocol alternatives with circuit breaker. |

## Core Capabilities

### Vision Injection

When a request contains images, superglm detects them and:

1. Extracts image information into a structured textual evidence packet.
2. Injects the packet as a system message into the conversation.
3. Decides whether to strip the original image blocks based on policy:
   - `evidence_only` (default): strips image blocks, keeps only text evidence. Non-vision models won't reject the payload.
   - `keep_for_vision_panels`: keeps raw image blocks so vision-capable panels see them directly.
   - `reject`: refuses image-bearing requests with 400.

Text-only models now have "eyes."

### Mixture-of-Experts Fusion

Set an alias to `strategy: "fusion"` and requests flow through the fusion pipeline:

```
User request
   │
   ├──► Panel 1 (model A) ──┐
   ├──► Panel 2 (model B) ──┤  parallel, bounded by max_parallel_panels
   ├──► Panel 3 (model C) ──┘
   │
   ▼
Synthesizer ── distills all panel responses ──► final answer (streamed)
```

- Panel phase: multiple models answer the same question independently, in parallel.
- Synthesizer phase: a synthesizer model reads all panel responses and distills one final answer, streamed to the client.
- Timeout control (timeout_ms), circuit breaker, and failover throughout.
- Self-consistency mode supported: same model sampled at different temperatures, then synthesized.

### Other Gateway Features

- Claude Code compatible `/v1/messages` endpoint.
- OpenAI compatible `/openai/v1/chat/completions` and `/openai/v1/responses`.
- Streaming for Anthropic / OpenAI / Responses protocols.
- Alias routing with provider pinning and automatic failover.
- Request trace logs with secret redaction.
- Billing / identity header sanitization before upstream forwarding.
- Hosted React dashboard, configure providers and aliases in the browser.
- D1 persistence, no config loss.

## Deploy To Cloudflare

### Recommended: fork and connect your fork

For a real deployment, fork this repository first. Cloudflare should connect to
your fork, because that gives your Worker a repository you can control, edit, and
sync from upstream later.

1. Open Cloudflare Dashboard -> Workers & Pages.
2. Select Create application.
3. Select Import a repository.
4. Connect GitHub and choose your fork of `sakisakisa-design/superglm`.
5. Leave the root directory as the repository root.
6. Use production branch `main`.
7. If Cloudflare shows resource setup, keep/create the D1 binding named `DB`.
8. Leave Build command empty.
9. Set Deploy command to `npx wrangler deploy`.
10. Add the runtime secret `SUPERDS_LOCAL_API_KEY`.
11. Save and deploy.

The dashboard is committed under `worker/assets` as pre-built static files, so
the Cloudflare GitHub deployment does not need a separate build step. The Worker
creates the D1 tables it needs on first request, so first-time deploys do not
need a local migration step.

### Quick demo: Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sakisakisa-design/superglm)

The button is useful for a quick trial. It may create an independent GitHub copy
for your deployment, which means future pushes to `sakisakisa-design/superglm`
will not redeploy your Worker automatically. For an editable deployment you can
keep linked to GitHub, use the fork flow above.

During setup, provide a strong `SUPERDS_LOCAL_API_KEY`. This is the gateway admin
key used by the hosted dashboard and by Claude/OpenAI-compatible clients.

After deploy, open the Worker URL in your browser. The dashboard asks for that
gateway key.

### Local Wrangler deploy

Prerequisites:

- Node.js 20+
- A Cloudflare account
- Wrangler login already completed, or let Wrangler prompt during the commands

```bash
npm install
npm run cf:bootstrap
npx wrangler secret put SUPERDS_LOCAL_API_KEY
npm run deploy
```

`npm run cf:bootstrap` creates the D1 database and writes its `database_id` into
`wrangler.jsonc`. If you already created the D1 database manually, copy the
`database_id` into `wrangler.jsonc` instead.

## Configure Providers

Use the hosted dashboard to add an upstream provider:

- `id`: a short provider id, for example `siliconflow`
- `name`: display name
- `protocol`: `openai` or `anthropic`
- `base_url`: OpenAI/Anthropic-compatible upstream base URL
- `api_key`: upstream provider key

Then add aliases that map public model names to real upstream models. Clients
send requests to the alias; superglm resolves the upstream provider/model.

### Configure Fusion

Set the alias strategy to `fusion` and configure the fusion plan:

```json
{
  "strategy": "fusion",
  "panel_models": [
    { "model": "glm-4-flash", "provider_id": "zhipu" },
    { "model": "deepseek-v3", "provider_id": "siliconflow" },
    { "model": "qwen-plus", "provider_id": "dashscope" }
  ],
  "synthesizer_model": "deepseek-v3",
  "synthesizer_provider_id": "siliconflow",
  "max_tokens_per_panel": 1024,
  "timeout_ms": 15000,
  "max_panel_count": 6,
  "max_parallel_panels": 3,
  "image_policy": "evidence_only"
}
```

Or use `self_consistency` strategy to sample the same model at different
temperatures and synthesize:

```json
{
  "strategy": "self_consistency",
  "self_consistency": { "model": "glm-4-flash", "provider_id": "zhipu", "samples": 3 },
  "synthesizer_model": "glm-4-flash",
  "synthesizer_provider_id": "zhipu"
}
```

## Claude Code

```bash
export ANTHROPIC_BASE_URL="https://<your-worker>.workers.dev"
export ANTHROPIC_API_KEY="<your superglm gateway key>"
claude
```

Supported Anthropic-compatible routes:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`

## OpenAI-Compatible Clients

```bash
export OPENAI_BASE_URL="https://<your-worker>.workers.dev/openai/v1"
export OPENAI_API_KEY="<your superglm gateway key>"
```

Supported OpenAI-compatible routes:

- `GET /openai/v1/models`
- `POST /openai/v1/chat/completions`
- `POST /openai/v1/responses`

## Repository Layout

```text
worker/         Cloudflare Worker runtime, dashboard, D1 migrations, tests
worker/src/     TypeScript Worker API and proxy
worker/assets/  Pre-built React dashboard (babel-standalone, served as static assets)
config/         Provider presets reference
docs/           Deployment and architecture notes
```

## Tests

```bash
npm run worker:typecheck
npm run worker:test
npm run worker:build
```

## Notes

- Do not commit real upstream provider keys.
- Rotate any key that was pasted into chat, logs, or screenshots.
- Full Worker documentation: [docs/cloudflare-worker-edition.md](docs/cloudflare-worker-edition.md).
