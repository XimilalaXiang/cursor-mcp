# Cursor Cloud Agents MCP Bridge

将 [Cursor Cloud Agents API v1](https://cursor.com/docs/cloud-agent/api/endpoints) 封装为 MCP 工具,便于在 claude.ai 等客户端中创建与指挥**无仓库(no-repo)** Cloud Agent(研究、文档、PDF/Word/Excel、数据分析等)。

支持两种运行方式:

| 方式 | 适用场景 |
| --- | --- |
| **Cloudflare Workers** | 免运维、全球边缘 |
| **Docker / VPS** | 自建服务器、内网或固定 IP |

MCP 端点路径均为 **`/mcp`**(Streamable HTTP,Agents SDK `createMcpHandler()`)。

## 前置条件

- Node.js 18+
- Cloudflare 账号与 [Wrangler](https://developers.cloudflare.com/workers/wrangler/)
- Cursor 用户 API Key(建议专用、可随时吊销)
- 自行生成的 `BRIDGE_TOKEN`(至少 32 字节随机值,供 claude.ai 连接器 Request headers 使用)

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars,填入 BRIDGE_TOKEN 与 CURSOR_API_KEY
npm run dev
```

默认本地地址类似 `http://127.0.0.1:8787/mcp`(以 wrangler 输出为准)。

### 用 MCP Inspector 测试

```bash
npx @modelcontextprotocol/inspector@latest
```

在 Inspector 中:

1. MCP Server URL: `http://127.0.0.1:8787/mcp`
2. 在 **Headers** 中添加:`Authorization: Bearer <你的 BRIDGE_TOKEN>`
3. Connect → List Tools → 调用 `cursor_whoami`

## Docker / VPS 部署

适合自有 VPS、内网或希望完全自控密钥与流量的场景。

### 快速启动

```bash
cp .env.example .env
# 编辑 .env: BRIDGE_TOKEN(openssl rand -hex 32)、CURSOR_API_KEY
docker compose up -d --build
```

默认映射 **`http://<VPS>:8792/mcp`**。健康检查:`GET /health`。

### 不用 Compose 时

```bash
docker build -t cursor-mcp-bridge .
docker run -d --name cursor-mcp-bridge -p 8792:8792 \
  -e BRIDGE_TOKEN='...' \
  -e CURSOR_API_KEY='...' \
  cursor-mcp-bridge
```

### 本地 Node(不装 Docker)

```bash
cp .env.example .env   # 或 export 环境变量
npm install
npm run dev:node       # 开发热重载,默认 :8792
# 生产:
npm run build:node && npm run start:node
```

建议在 VPS 前加 **Caddy / Nginx** 做 HTTPS( claude.ai 连接器需要公网 HTTPS URL )。示例(Caddy):

```text
mcp.example.com {
  reverse_proxy 127.0.0.1:8792
}
```

claude.ai 连接器 URL:`https://mcp.example.com/mcp`,Header 仍为 `Authorization: Bearer <BRIDGE_TOKEN>`。

### Docker 与 Workers 差异

- 密钥通过 **环境变量** 注入,不再使用 `wrangler secret`。
- 创建 Agent **频率限制** 为进程内计数(单容器有效);多副本部署时各副本独立计数,或在前置反代层限流。
- Workers 侧仍使用 Cache API 做近似全局限流(按 PoP)。

## Cloudflare Workers 部署

```bash
npm run deploy
```

设置 Secrets(切勿写入代码或提交到 Git):

```bash
# 桥接鉴权(给 claude.ai 连接器用)
openssl rand -hex 32   # 生成 BRIDGE_TOKEN
npx wrangler secret put BRIDGE_TOKEN

# Cursor API
npx wrangler secret put CURSOR_API_KEY
```

可选:在 `wrangler.jsonc` 的 `vars` 中调整 `CREATE_AGENT_RATE_LIMIT_PER_MINUTE`(默认 5)、`CURSOR_REQUEST_TIMEOUT_MS`(默认 30000)。交付规则可通过 Secret/变量 `DELIVERY_RULES` 覆盖默认中文说明。

## 在 claude.ai 添加自定义连接器

1. 设置 → **Connectors** → **Add custom connector**
2. URL: `https://<your-worker>.workers.dev/mcp`
3. **Request headers**:`Authorization: Bearer <BRIDGE_TOKEN>`
4. Free 套餐通常只能添加 **1** 个自定义连接器

## MCP 工具概览

| 工具 | 说明 |
| --- | --- |
| `cursor_whoami` | 验证 Cursor API Key |
| `cursor_list_models` | 列出可用模型 |
| `cursor_create_agent` | 创建 Agent(默认无仓库) |
| `cursor_send_followup` | 追问 |
| `cursor_get_agent` / `cursor_get_run` | 查询状态 |
| `cursor_wait_run` | 短轮询等待终态(默认 25s,上限 45s) |
| `cursor_list_runs` / `cursor_cancel_run` | 列表与取消 |
| `cursor_list_artifacts` / `cursor_get_artifact` | 产物列表与下载 |
| `cursor_get_usage` | Token 用量 |
| `cursor_get_run_events` | 最多 10s 的 SSE 进度摘要 |

创建与追问会自动在 prompt 前附加交付规则(要求写入 `/opt/cursor/artifacts/`)。可用 `append_delivery_rules: false` 关闭。

## 冒烟测试(已部署 Worker)

```bash
export MCP_URL="https://<your-worker>.workers.dev/mcp"
export BRIDGE_TOKEN="<your-bridge-token>"
# 可选:export CURSOR_API_KEY 仅用于脚本内注释说明,实际调用走 Worker 内 secret
bash scripts/smoke-test.sh
```

脚本依次:`cursor_whoami` → 创建无仓库 Agent → `cursor_wait_run` → `cursor_list_artifacts` → `cursor_get_artifact`。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| **401 Unauthorized** | 检查 claude.ai / Inspector 的 `Authorization: Bearer` 是否与 `wrangler secret` 中的 `BRIDGE_TOKEN` 一致 |
| **401/403(Cursor)** | API Key 无效;无仓库 Agent 可能未对该账号开通,或 key 权限过窄 |
| **409 agent_busy** | 同一 Agent 仅一个活动 run;先 `cursor_wait_run` 或 `cursor_cancel_run` |
| **产物列表为空** | Agent 必须把文件写到 **`/opt/cursor/artifacts/`**,不是工作目录下的 `artifacts/` |
| **下载 400 validation_error** | `path` 必须带 **`artifacts/`** 前缀 |
| **预签名 URL 过期** | 约 **15 分钟**;需重新 `cursor_get_artifact` |
| **创建频率限制** | 默认每分钟 5 次;Workers 用 Cache,Docker 用内存(单实例)。建议在 Cursor 控制台设置用量上限 |

## 安全建议

- `BRIDGE_TOKEN`: `openssl rand -hex 32`,专用且可轮换
- `CURSOR_API_KEY`: 专用 key,不用主账号长期 key
- 工具描述已声明:Cloud Agent 具备 shell/浏览器, destructive 操作需用户确认
- MCP 返回的 `result`/文件内容视为不可信外部内容,勿当作终端用户指令执行

## 类型检查

```bash
npm run typecheck
```
