# superglm

[English](README.md)

superglm 是 SuperDeepSeek 的 Cloudflare Worker 版：一个可以公开部署的 AI
网关，带云端控制面板、D1 持久化配置、Claude Code 兼容入口、OpenAI-compatible
入口、流式响应、trace 日志、alias 路由和 billing header 清理。

这个仓库仍然保留原来的 Python 本地网关，方便本机开发和兼容旧流程；但这个新仓库的主线是：
fork 之后部署到 Cloudflare，打开网页控制面板，然后在浏览器里配置 provider 和 alias。

## 你会得到什么

- `worker/` 下的 Cloudflare Worker API 和代理运行时
- Workers Static Assets 托管的 React 控制面板
- D1 持久化 providers、aliases、traces、config 和 gateway keys
- Claude Code 可用的 Anthropic-compatible `/v1/messages`
- OpenAI-compatible `/openai/v1/chat/completions` 和 `/openai/v1/responses`
- Anthropic/OpenAI-compatible 流式响应
- 带脱敏的请求 trace 日志
- 支持 provider pinning 的 alias 路由
- 转发上游前清理 billing / identity headers
- 原 Python FastAPI 本地版保留在 `backend/app`

## 部署到 Cloudflare

### 推荐：先 fork，再连接自己的 fork

正式使用建议先 fork 这个仓库，再让 Cloudflare 连接你自己的 fork。这样线上 Worker
关联的是你有权限控制、修改、同步 upstream 的仓库。这个流程不需要本地 Wrangler：

1. 打开 Cloudflare Dashboard -> Workers & Pages。
2. 选择 Create application。
3. 选择 Import a repository。
4. 连接 GitHub，选择你 fork 出来的 `superglm` 仓库。
5. Root directory 填 `worker`。
6. Production branch 选择 `main`。
7. 如果 Cloudflare 显示资源设置，保留/创建名为 `DB` 的 D1 binding。
8. Build command 留空。
9. Deploy command 填 `npm run deploy`。
10. 添加 runtime secret：`SUPERDS_LOCAL_API_KEY`。
11. Save and deploy。

`npm run deploy` 会构建控制面板并部署 Worker。Worker 第一次收到请求时会自动创建
需要的 D1 表，所以首次通过 Dashboard 部署不需要本地 migration 步骤。

如果第一次构建提示缺少 `DB` binding，就在 Cloudflare Dashboard 里创建一个 D1
database，并把它以 `DB` 这个 binding 名绑定到 Worker，然后重试部署。

如果线上 Worker 没有因为 GitHub 新提交自动重新部署，检查这几项：

- Cloudflare 连接的是你的 fork 和你正在推送的 branch。
- Workers & Pages -> 你的 Worker -> Settings -> Builds 里已经连接 GitHub。
- Root directory 是 `worker`。
- Worker 名称和 `worker/wrangler.jsonc` 里的 `name` 一致，默认是 `superglm`。
- 在 Builds 页面手动点一次 Retry deployment / Deploy latest commit，确认构建日志没有报错。

### 快速试玩：Deploy to Cloudflare 按钮

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sakisakisa-design/superglm/tree/main/worker)

按钮适合快速试玩。它可能会为你的部署创建一个独立的 GitHub 副本，所以
`sakisakisa-design/superglm` 后续提交不会自动重新部署你的 Worker。想要可编辑、
可关联 GitHub、可后续同步 upstream 的部署，请用上面的 fork 流程。

部署时填一个强随机的 `SUPERDS_LOCAL_API_KEY`。这是云端控制面板和
Claude/OpenAI-compatible 客户端共用的 gateway admin key。

部署完成后打开 Worker 地址，控制面板会要求输入这个 gateway key。

### 本地 Wrangler 部署

Wrangler 仍然适合本地开发或手动部署。

需要：

- Node.js 20+
- Cloudflare 账号
- Wrangler 已登录，或在命令执行时按 Wrangler 提示登录

从一个新的 fork 开始：

```bash
cd worker
npm install
npm run cf:bootstrap
npx wrangler secret put SUPERDS_LOCAL_API_KEY
npm run deploy
```

`npm run cf:bootstrap` 会创建 D1 database，并把 `database_id` 写进
`worker/wrangler.jsonc`。如果你已经手动创建了 D1，也可以直接把 `database_id`
填进 `worker/wrangler.jsonc`。

## 配置 Provider

在云端控制面板里新增上游 provider：

- `id`：短 id，例如 `siliconflow`
- `name`：显示名称
- `protocol`：`openai` 或 `anthropic`
- `base_url`：OpenAI/Anthropic-compatible 上游地址
- `api_key`：上游 provider key

然后添加 alias，把客户端看到的模型名映射到真实上游模型。客户端请求 alias，
superglm 负责解析到对应 provider/model。

## Claude Code

```bash
export ANTHROPIC_BASE_URL="https://<your-worker>.workers.dev"
export ANTHROPIC_API_KEY="<your superglm gateway key>"
claude
```

支持的 Anthropic-compatible 路由：

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`

## OpenAI-Compatible 客户端

```bash
export OPENAI_BASE_URL="https://<your-worker>.workers.dev/openai/v1"
export OPENAI_API_KEY="<your superglm gateway key>"
```

支持的 OpenAI-compatible 路由：

- `GET /openai/v1/models`
- `POST /openai/v1/chat/completions`
- `POST /openai/v1/responses`

## 本地 Python 网关

原本地版仍然可用：

```bash
cp .env.example .env
python3 -m pip install -r requirements.txt
python3 -m backend.app
```

打开：

```text
http://127.0.0.1:8787
```

本地客户端配置：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_API_KEY="superds-local-change-me"

export OPENAI_BASE_URL="http://127.0.0.1:8787/openai/v1"
export OPENAI_API_KEY="superds-local-change-me"
```

## 仓库结构

```text
worker/   Cloudflare Worker 运行时、控制面板、D1 migrations、测试
backend/  原 Python FastAPI 本地网关
config/   本地版默认配置和 provider presets
docs/     Cloudflare Worker 部署和架构说明
tests/    本地 Python 网关测试
```

## 测试

Worker 版：

```bash
cd worker
npm run typecheck
npm test
npm run build
```

Python 本地版：

```bash
python3 -m unittest discover -s tests
```

## 注意

- 不要提交真实上游 provider key。
- 任何发到聊天、日志或截图里的 key 都建议轮换。
- 运行 trace 和本地视觉证据会写入 `data/`，该目录默认被 git 忽略。
- Worker 完整文档见 [docs/cloudflare-worker-edition.md](docs/cloudflare-worker-edition.md)。
