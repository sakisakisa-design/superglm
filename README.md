# superglm

[中文说明](README.zh-CN.md)

superglm is a Cloudflare Worker edition of SuperDeepSeek: a public AI gateway
with a hosted dashboard, persistent D1 configuration, Claude Code compatible
endpoints, OpenAI-compatible endpoints, streaming, trace logs, alias routing, and
billing-header sanitization.

The original Python local gateway is still included for local development, but
the main path for this repository is: fork it, deploy it to Cloudflare, open the
dashboard, and configure providers from the browser.

## What You Get

- Cloudflare Worker API and proxy runtime under `worker/`
- Hosted React dashboard served by Workers Static Assets
- D1 persistence for providers, aliases, traces, config, and gateway keys
- Anthropic-compatible `/v1/messages` for Claude Code style clients
- OpenAI-compatible `/openai/v1/chat/completions` and `/openai/v1/responses`
- Streaming support for Anthropic/OpenAI-compatible responses
- Trace logs with secret redaction
- Alias routing with provider pinning and failover-friendly routing
- Billing and identity header sanitization before upstream forwarding
- Existing Python FastAPI local gateway kept intact under `backend/app`

## Deploy To Cloudflare

Prerequisites:

- Node.js 20+
- A Cloudflare account
- Wrangler login already completed, or let Wrangler prompt during the commands

From a fresh fork:

```bash
cd worker
npm install
npm run cf:bootstrap
npx wrangler d1 migrations apply superdeepseek --remote
npx wrangler secret put SUPERDS_LOCAL_API_KEY
npm run deploy
```

`npm run cf:bootstrap` creates the D1 database and writes its `database_id` into
`worker/wrangler.jsonc`. If you already created the D1 database manually, copy
the `database_id` into `worker/wrangler.jsonc` instead.

After deploy, open the Worker URL in your browser. The dashboard asks for the
gateway key you stored in `SUPERDS_LOCAL_API_KEY`.

## Configure Providers

Use the hosted dashboard to add an upstream provider:

- `id`: a short provider id, for example `siliconflow`
- `name`: display name
- `protocol`: `openai` or `anthropic`
- `base_url`: OpenAI/Anthropic-compatible upstream base URL
- `api_key`: upstream provider key

Then add aliases that map public model names to real upstream models. Clients
send requests to the alias; superglm resolves the upstream provider/model.

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

## Local Python Gateway

The original local edition is still available:

```bash
cp .env.example .env
python3 -m pip install -r requirements.txt
python3 -m backend.app
```

Open:

```text
http://127.0.0.1:8787
```

For local clients:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_API_KEY="superds-local-change-me"

export OPENAI_BASE_URL="http://127.0.0.1:8787/openai/v1"
export OPENAI_API_KEY="superds-local-change-me"
```

## Repository Layout

```text
worker/   Cloudflare Worker runtime, dashboard, D1 migrations, tests
backend/  Existing Python FastAPI local gateway
config/   Local edition default config and provider presets
docs/     Cloudflare Worker deployment and architecture notes
tests/    Local Python gateway tests
```

## Tests

Worker edition:

```bash
cd worker
npm run typecheck
npm test
npm run build
```

Local Python edition:

```bash
python3 -m unittest discover -s tests
```

## Notes

- Do not commit real upstream provider keys.
- Rotate any key that was pasted into chat, logs, or screenshots.
- Runtime traces and local evidence are stored under `data/`, which is ignored by git.
- Full Worker documentation: [docs/cloudflare-worker-edition.md](docs/cloudflare-worker-edition.md).
