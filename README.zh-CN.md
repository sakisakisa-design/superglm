# superglm

[English](README.md)

superglm 是 SuperDeepSeek 的 Cloudflare Worker 版：一个可以公开部署的 AI
网关，带云端控制面板、D1 持久化配置、Claude Code 兼容入口、OpenAI-compatible
入口、流式响应、trace 日志、alias 路由和 billing header 清理。

Fork 之后部署到 Cloudflare，打开网页控制面板，然后在浏览器里配置 provider 和 alias。

## 你会得到什么

- `worker/` 下的 Cloudflare Worker API 和代理运行时
- React + Vite 控制面板，由 Workers Static Assets 托管
- D1 持久化 providers、aliases、traces、config 和 gateway keys
- Claude Code 可用的 Anthropic-compatible `/v1/messages`
- OpenAI-compatible `/openai/v1/chat/completions` 和 `/openai/v1/responses`
- Anthropic/OpenAI-compatible 流式响应
- 带脱敏的请求 trace 日志
- 支持 provider pinning 的 alias 路由
- 转发上游前清理 billing / identity headers

## 部署到 Cloudflare

### 推荐：先 fork，再连接自己的 fork

正式使用建议先 fork 这个仓库，再让 Cloudflare 连接你自己的 fork。这样线上 Worker
关联的是你有权限控制、修改、同步 upstream 的仓库。

1. 打开 Cloudflare Dashboard -> Workers & Pages。
2. 选择 Create application。
3. 选择 Import a repository。
4. 连接 GitHub，选择你 fork 出来的 `superglm` 仓库。
5. Root directory 保持仓库根目录。
6. Production branch 选择 `main`。
7. 如果 Cloudflare 显示资源设置，保留/创建名为 `DB` 的 D1 binding。
8. Build command 填 `npm run build`。
9. Deploy command 填 `npx wrangler deploy`。
10. 添加 runtime secret：`SUPERDS_LOCAL_API_KEY`。
11. Save and deploy。

Build command 会安装 Worker 依赖并用 Vite 打包 React 控制面板到
`worker/dist/client/`。Wrangler 再把这些文件作为静态资源和 Worker API 一起部署。
Worker 第一次收到请求时会自动创建需要的 D1 表，所以首次部署不需要本地 migration 步骤。

如果第一次构建提示缺少 `DB` binding，就在 Cloudflare Dashboard 里创建一个 D1
database，并把它以 `DB` 这个 binding 名绑定到 Worker，然后重试部署。

如果线上 Worker 没有因为 GitHub 新提交自动重新部署，检查这几项：

- Cloudflare 连接的是你的 fork 和你正在推送的 branch。
- Workers & Pages -> 你的 Worker -> Settings -> Builds 里已经连接 GitHub。
- Root directory 是仓库根目录。
- Worker 名称和根目录 `wrangler.jsonc` 里的 `name` 一致，默认是 `superglm`。
- 在 Builds 页面手动点一次 Retry deployment / Deploy latest commit，确认构建日志没有报错。

### 快速试玩：Deploy to Cloudflare 按钮

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sakisakisa-design/superglm)

按钮适合快速试玩。它可能会为你的部署创建一个独立的 GitHub 副本，所以
`sakisakisa-design/superglm` 后续提交不会自动重新部署你的 Worker。想要可编辑、
可关联 GitHub、可后续同步 upstream 的部署，请用上面的 fork 流程。

部署时填一个强随机的 `SUPERDS_LOCAL_API_KEY`。这是云端控制面板和
Claude/OpenAI-compatible 客户端共用的 gateway admin key。

部署完成后打开 Worker 地址，控制面板会要求输入这个 gateway key。

### 本地 Wrangler 部署

需要：

- Node.js 20+
- Cloudflare 账号
- Wrangler 已登录，或在命令执行时按 Wrangler 提示登录

从一个新的 fork 开始：

```bash
npm install
npm run cf:bootstrap
npx wrangler secret put SUPERDS_LOCAL_API_KEY
npm run deploy
```

`npm run cf:bootstrap` 会创建 D1 database，并把 `database_id` 写进
`wrangler.jsonc`。如果你已经手动创建了 D1，也可以直接把 `database_id`
填进 `wrangler.jsonc`。

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

## 仓库结构

```text
worker/         Cloudflare Worker 运行时、控制面板、D1 migrations、测试
worker/src/     TypeScript Worker API 和代理
worker/web/     React + Vite 控制面板源码
worker/dist/    Vite 构建输出（自动生成，不提交到 git）
config/         Provider presets 参考
docs/           部署和架构说明
```

## 测试

```bash
npm run worker:typecheck
npm run worker:test
npm run worker:build
```

## 注意

- 不要提交真实上游 provider key。
- 任何发到聊天、日志或截图里的 key 都建议轮换。
- Worker 完整文档见 [docs/cloudflare-worker-edition.md](docs/cloudflare-worker-edition.md)。
