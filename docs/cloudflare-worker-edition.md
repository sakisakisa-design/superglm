# SuperDeepSeek — Cloudflare Worker Edition

A Cloudflare-native edition of SuperDeepSeek that lives alongside the existing
Python local gateway. Same protocol behaviour, different runtime: no Uvicorn, no
local filesystem, no SQLite files — just a Worker, D1, and Workers Static Assets.

> The local Python edition (`backend/app`, `docker-compose up`, `python -m backend.app`)
> is unchanged and still the default for local development. The Worker edition is for
> hosting SuperDeepSeek as a public edge gateway with a persistent dashboard.

## 1. Two editions, one repo

| | Local edition | Worker edition |
|---|---|---|
| Location | `backend/app` | `worker/` |
| Runtime | Python + FastAPI + Uvicorn | Cloudflare Worker (TypeScript) |
| Persistence | `config/superds.json` + `data/traces.sqlite3` | D1 (`config`, `provider_profiles`, `aliases`, `traces`, `api_keys`) |
| Dashboard | served by FastAPI | built by Vite, served by Workers Static Assets |
| Upstream HTTP | `httpx` | Workers `fetch` |
| Deploy | `docker compose up` | Deploy to Cloudflare button, Workers Builds, or `wrangler deploy` |

The two editions do not share process state. The Worker edition is not "Python moved
to the edge" — it is a Cloudflare-native gateway runtime that preserves SuperDeepSeek's
protocol behaviour (Anthropic/OpenAI/Responses endpoints, alias routing, billing-header
sanitization, streaming, trace logs).

## 2. Layout

```
worker/
  package.json  wrangler.jsonc  tsconfig.json  vite.config.ts  vitest.config.ts
  migrations/0001_init.sql
  public/favicon.svg
  src/
    index.ts            Worker entry: route dispatch + auth + SPA fallback
    router.ts           jsonResponse / readJsonBody / RouteCtx
    types/              config, internal, trace, provider
    auth/               auth.ts (Bearer/x-api-key), keyHash.ts (SHA-256)
    storage/            d1.ts, configStore.ts, traceStore.ts, encryptedSecrets.ts
    compat/             aliasResolver.ts, billingHeaderSanitizer.ts, cacheCanonicalizer.ts
    adapters/           anthropicIn/Out, openaiIn/Out, responsesIn, sse
    upstream/           providerClient, openaiCompatible, anthropicCompatible,
                        cloudflareAiGateway, router (failover), circuitBreaker
    runtime/            pipeline, modes, evidence, visionWorker
    api/                dashboard, health, providers, profiles, aliases, traces,
                        testConnection, claudeSmoke
    utils/              json, redact, ids, errors, stream
  web/                  React + Vite dashboard (App, api, pages, components, styles)
  tests/                aliasResolver, billingHeaderSanitizer, anthropicAdapter,
                        openaiAdapter, streaming, auth, d1Store
```

## 3. D1 schema (`migrations/0001_init.sql`)

- **`config`** — singleton JSON row holding the full `SuperDeepSeekConfig` document
  (server/security/runtime/providers/models/profiles/model_aliases), same shape as the
  local edition's `config/superds.json`. Used by the dashboard config API.
- **`provider_profiles`** — upstream endpoints (id, name, base_url, api_key, protocol,
  models[], enabled, timeout_ms). Used for routing.
- **`aliases`** — public model name → target model (+ optional provider pin, strategy).
  Supports `*` wildcards (e.g. `openai/*` → `azure/*`).
- **`traces`** — per-request observability (alias, target_model, provider, status,
  latency, tokens, request/response/steps JSON).
- **`api_keys`** — hashed client-facing gateway keys (SHA-256; plaintext never stored).

Provider API keys are stored in `provider_profiles.api_key`. For hardened mode,
`src/storage/encryptedSecrets.ts` provides AES-GCM encrypt/decrypt helpers keyed by a
`SECRETS_ENCRYPTION_KEY` (or `ENCRYPTION_KEY`) Worker secret.

## 4. Endpoints

### Dashboard API (gateway-auth-gated except /api/health)
```
GET  /api/health                                  (public, no auth)

GET  /api/overview                                (require gateway key)
GET  /api/config            PUT /api/config
GET  /api/providers         POST /api/providers
GET  /api/providers/:id     PUT /api/providers/:id     DELETE /api/providers/:id
GET  /api/profiles          POST /api/profiles
PUT  /api/profiles/:id      DELETE /api/profiles/:id
GET  /api/aliases           POST /api/aliases
DELETE /api/aliases/:alias
GET  /api/traces            GET /api/traces/:id
POST /api/test-connection
POST /api/claude-code/smoke
```
All routes above (except `/api/health`) require `Authorization: Bearer <key>` or
`x-api-key: <key>`. The hosted dashboard prompts for the gateway key on first load,
keeps it in `sessionStorage` (or `localStorage` with the remember toggle), and sends
it as a Bearer header on every protected `/api/*` call. On a 401 it forgets the key
and returns to the locked state.

### Anthropic-compatible (gateway auth: Bearer / x-api-key)
```
POST /v1/messages
POST /v1/messages/count_tokens
GET  /v1/models
```
Point Claude Code at the Worker:
```bash
export ANTHROPIC_BASE_URL="https://<your-worker>.dev"
export ANTHROPIC_API_KEY="<gateway key>"
claude
```

### OpenAI-compatible (gateway auth)
```
POST /openai/v1/chat/completions      (also /v1/chat/completions)
POST /openai/v1/responses
GET  /openai/v1/models
```
Point OpenAI SDK / Cursor at the Worker:
```bash
export OPENAI_BASE_URL="https://<your-worker>.dev/openai/v1"
export OPENAI_API_KEY="<gateway key>"
```

## 5. Request pipeline

```
ingress (auth + trace id + header capture)
  -> normalize (anthropicIn / openaiIn / responsesIn)
  -> sanitize (billingHeaderSanitizer: strip identity/billing HTTP headers
              + anthropicIn.sanitizeSystemFirstLine: strip `cch=<random>` first line)
  -> resolve (aliasResolver: alias -> target model; ProviderRouter: pick provider)
  -> route + upstream (circuit-broken failover across providers)
  -> adapt out (anthropicOut / openaiOut / responsesIn, streaming or buffered)
  -> trace (redacted, persisted to D1)
```

The `cch=` first-line strip is the core cache-safety behaviour: Claude Code may inject
`x-anthropic-billing-header: ... cch=<random>` as the first system line; forwarding that
to a non-Anthropic upstream wrecks prefix caching. It is stripped before cache-key
computation and before upstream forwarding, and recorded in the trace.

## 6. Develop

```bash
cd worker
npm install
npm run cf:bootstrap                       # create D1 and write database_id into wrangler.jsonc
npx wrangler d1 migrations apply DB --remote              # or --local
npm run dev                                 # wrangler dev (API + proxy)
npm run build                               # vite build (dashboard -> dist/client)
npm run typecheck
npm test
```

For local dev with D1:
```bash
npx wrangler d1 migrations apply DB --local
npx wrangler dev --local
```

## 7. Deploy

### Deploy to Cloudflare button

Use the README button, or open this URL directly:

```text
https://deploy.workers.cloudflare.com/?url=https://github.com/sakisakisa-design/superglm/tree/main/worker
```

Cloudflare will clone the Worker app, provision supported resources such as D1,
run the deploy command, and bind the resources to the Worker. During setup,
provide `SUPERDS_LOCAL_API_KEY` as a secret; this is the gateway key for the
dashboard and client requests.

### Cloudflare Dashboard + GitHub

To deploy without local Wrangler:

1. Open Cloudflare Dashboard -> Workers & Pages.
2. Select Create application.
3. Select Import a repository.
4. Connect GitHub and choose `sakisakisa-design/superglm` or your fork.
5. Set root directory to `worker`.
6. Set production branch to `main`.
7. If Cloudflare shows resource setup, keep/create the D1 binding named `DB`.
8. Leave Build command empty.
9. Set Deploy command to `npm run deploy`.
10. Add runtime secret `SUPERDS_LOCAL_API_KEY`.
11. Save and deploy.

`npm run deploy` builds the dashboard and deploys the Worker. The Worker creates
the D1 tables it needs on first request, so first-time dashboard deploys do not
need a local migration step.

If the first build says the `DB` binding is missing, create a D1 database in the
Cloudflare dashboard, bind it to the Worker as `DB`, then retry the deployment.

If a live Worker does not redeploy after a GitHub push, check that Cloudflare is
connected to the same repo/branch you are pushing, root directory is `worker`,
and the Worker name matches `worker/wrangler.jsonc` (`superglm` by default).
Deploy Button flows may create a separate GitHub copy; pushes to the upstream
repo will not automatically redeploy that copy.

### Local Wrangler

From a fresh fork:

```bash
cd worker
npm install
npm run cf:bootstrap
npx wrangler secret put SUPERDS_LOCAL_API_KEY
npm run deploy
```

`wrangler.jsonc` binds `DB` (D1) and serves the built dashboard from `./dist/client`
as Workers Static Assets with single-page-application fallback.

If you already created the D1 database manually, copy its `database_id` into
`worker/wrangler.jsonc` instead of running `npm run cf:bootstrap`.

**All `/api/*` management endpoints (except `/api/health`) require the gateway key**
(`Authorization: Bearer <key>` or `x-api-key: <key>`) — the same key pool the proxy
endpoints use. Set a gateway key via a Worker secret (the documented bootstrap path):

```bash
npx wrangler secret put SUPERDS_LOCAL_API_KEY
```

`loadConfig` hydrates `security.local_api_key` from the `SUPERDS_LOCAL_API_KEY` secret
when present, so the dashboard and proxy are protected on first deploy. You may also
seed the whole config document with a `CONFIG_JSON` var, or set
`security.local_api_key` via `PUT /api/config` (authenticated), or create hashed keys
in the `api_keys` table. With a key configured, all `/v1/*`, `/openai/v1/*`, and
`/api/*` (except `/api/health`) require it. Provider `api_key` values are masked in
every management response (`sk-****<last4>`); the gateway key itself is never returned.

## 8. Optional Cloudflare AI Gateway

Set `CF_AI_GATEWAY_ACCOUNT_ID` + `CF_AI_GATEWAY_SLUG` (and optionally
`CF_AI_GATEWAY_TOKEN`) as Worker vars to route upstream calls through a Cloudflare AI
Gateway for edge caching, rate limiting, and observability
(`src/upstream/cloudflareAiGateway.ts`).

## 9. Testing

`npm test` runs Vitest over `worker/tests/` — pure-logic tests for the alias resolver,
billing-header sanitizer, Anthropic/OpenAI adapters, streaming, auth, and the D1 stores
(the store tests use an in-memory D1 fake, no real D1 binding required).
