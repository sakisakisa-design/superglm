# superglm

[English](README.md)

给纯文本大模型加上眼睛和脑子。

superglm 不是又一个 API 代理。它是一个部署在 Cloudflare Worker 上的**模型增强网关**，做两件别家不做的事：

1. **视觉注入**：纯文本模型（GLM、DeepSeek、Qwen 等没有视觉能力的模型）收到图片时，superglm 自动把图片转成结构化文字证据包注入对话，让纯文本模型也能"看懂"图片内容并回答。
2. **混合专家融合（Fusion）**：把多个便宜模型组成专家组并行回答，再由一个综合模型（synthesizer）把所有回答提炼成一条最终回复。效果逼近旗舰模型，成本只有零头。

一句话：**用便宜的纯文本模型，拼出旗舰级的表现。**

## 它解决什么问题

你已经有一堆便宜的好模型。它们各自有长处，但：

- 不支持图片，用户发图就报错。
- 单独用，回答质量不稳定，有时好有时差。
- 旗舰模型太贵，日常用肉疼。

superglm 在网关层把这些全解决：

| 问题 | superglm 怎么做 |
|------|----------------|
| 纯文本模型不能看图 | 图片自动转文字证据包（image_policy: evidence_only），模型像收到一段描述一样回答 |
| 单模型质量不够 | 多模型并行回答 + 综合模型提炼（Fusion），三个臭皮匠顶个诸葛亮 |
| 想让视觉模型直接看图 | image_policy: keep_for_vision_panels，原图块原样透传给视觉 panel |
| 不想让 Fusion 碰图 | image_policy: reject，检测到图直接 400 |
| 配太多 panel 怕炸 | max_panel_count + max_parallel_panels 硬上限，默认最多 12 个 panel、6 路并发 |
| 某个 provider 挂了 | 自动 failover 到同协议的其他 provider，带熔断器 |

## 核心能力

### 视觉注入（Vision Evidence）

当请求带图片时，superglm 检测到图片后：

1. 提取图片信息，生成结构化文字证据包。
2. 把证据包作为 system message 注入对话。
3. 根据策略决定是否剥除原始图片块：
   - `evidence_only`（默认）：剥除图片块，只留文字证据，非视觉模型不会因为 payload 带图而报错。
   - `keep_for_vision_panels`：保留原图块，让视觉能力 panel 直接看图。
   - `reject`：拒绝带图请求，返回 400。

纯文本模型从此有了"眼睛"。

### 混合专家融合（Fusion）

给 alias 配上 `strategy: "fusion"`，请求就会走融合流水线：

```
用户请求
   │
   ├──► Panel 1（模型 A）──┐
   ├──► Panel 2（模型 B）──┤  并行，并发受 max_parallel_panels 限制
   ├──► Panel 3（模型 C）──┘
   │
   ▼
Synthesizer（综合模型）── 提炼所有 panel 回答 ──► 最终回复
```

- Panel 阶段：多个模型并行回答同一个问题，各自独立。
- Synthesizer 阶段：一个综合模型读取所有 panel 的回答，提炼出一条最终回复，流式输出。
- 全程带超时控制（timeout_ms）、熔断器和 failover。
- 支持 self_consistency 模式：同一个模型用不同温度采样多次，再综合。

### 其他网关能力

- Claude Code 兼容的 `/v1/messages` 入口。
- OpenAI 兼容的 `/openai/v1/chat/completions` 和 `/openai/v1/responses`。
- 流式响应，Anthropic / OpenAI / Responses 三种协议都支持。
- Alias 路由，支持 provider pinning 和自动 failover。
- 请求 trace 日志，带密钥脱敏。
- Billing / identity header 清理，转发前剥干净。
- 云端 React 控制面板，浏览器里配 provider 和 alias。
- D1 持久化，不丢配置。

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
8. Build command 留空。
9. Deploy command 填 `npx wrangler deploy`。
10. 添加 runtime secret：`SUPERDS_LOCAL_API_KEY`。
11. Save and deploy。

Worker 控制面板已经预构建在 `worker/assets`，所以 Cloudflare GitHub 自动部署不需要
额外构建步骤。Worker 第一次收到请求时会自动创建需要的 D1 表，所以首次部署不需要本地 migration 步骤。

如果第一次构建提示缺少 `DB` binding，就在 Cloudflare Dashboard 里创建一个 D1
database，并把它以 `DB` 这个 binding 名绑定到 Worker，然后重试部署。

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

### 配置 Fusion

在 alias 的 strategy 设为 `fusion`，然后配 fusion plan：

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

也可以用 `self_consistency` 策略，让同一个模型用不同温度采样多次再综合：

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
worker/assets/  预构建 React 控制面板（babel-standalone，作为静态资源服务）
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
