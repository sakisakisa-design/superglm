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

### Recommended: fork and connect your fork

For a real deployment, fork this repository first. Cloudflare should connect to
your fork, because that gives your Worker a repository you can control, edit, and
sync from upstream later. You do not need local Wrangler for this path:

1. Open Cloudflare Dashboard -> Workers & Pages.
2. Select Create application.
3. Select Import a repository.
4. Connect GitHub and choose your fork of `sakisakisa-design/superglm`.
5. Set the root directory to `worker`.
6. Use production branch `main`.
7. If Cloudflare shows resource setup, keep/create the D1 binding named `DB`.
8. Leave Build command empty.
9. Set Deploy command to `npm run deploy`.
10. Add the runtime secret `SUPERDS_LOCAL_API_KEY`.
11. Save and deploy.

`npm run deploy` builds the dashboard and deploys the Worker. The Worker creates
the D1 tables it needs on first request, so first-time dashboard deploys do not
need a local migration step.

If the first build says the `DB` binding is missing, create a D1 database in the
Cloudflare dashboard, bind it to the Worker as `DB`, then retry the deployment.

If the live Worker does not redeploy after a GitHub push, check:

- Cloudflare is connected to your fork and the branch you are pushing.
- Workers & Pages -> your Worker -> Settings -> Builds shows GitHub connected.
- Root directory is `worker`.
- The Worker name matches `worker/wrangler.jsonc`; the default name is `superglm`.
- Use Retry deployment / Deploy latest commit once and read the build log for the
  exact error.

### Quick demo: Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sakisakisa-design/superglm/tree/main/worker)

The button is useful for a quick trial. It may create an independent GitHub copy
for your deployment, which means future pushes to `sakisakisa-design/superglm`
will not redeploy your Worker automatically. For an editable deployment you can
keep linked to GitHub, use the fork flow above.

During setup, provide a strong `SUPERDS_LOCAL_API_KEY`. This is the gateway admin
key used by the hosted dashboard and by Claude/OpenAI-compatible clients.

After deploy, open the Worker URL in your browser. The dashboard asks for that
gateway key.

### Local Wrangler deploy

Wrangler is still useful for local development or manual deployment.

Prerequisites:

- Node.js 20+
- A Cloudflare account
- Wrangler login already completed, or let Wrangler prompt during the commands

From a fresh fork:

```bash
cd worker
npm install
npm run cf:bootstrap
npx wrangler secret put SUPERDS_LOCAL_API_KEY
npm run deploy
```

`npm run cf:bootstrap` creates the D1 database and writes its `database_id` into
`worker/wrangler.jsonc`. If you already created the D1 database manually, copy
the `database_id` into `worker/wrangler.jsonc` instead.

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
