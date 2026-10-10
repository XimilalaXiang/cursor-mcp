import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CursorApiError, CursorClient, cursorErrorPayload } from "./cursor-api.js";
import {
  CLOUD_AGENT_SAFETY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
  checkCreateAgentRateLimit,
  isLikelyTextArtifact,
  isTerminalRunStatus,
  jsonToolResult,
  newAgentId,
  normalizeArtifactPath,
  prependDeliveryRules,
  sleep,
} from "./util.js";

const imageSchema = z.union([
  z.object({ url: z.string().url() }),
  z.object({
    data: z.string().min(1),
    mimeType: z.string().min(1),
  }),
]);

const repoSchema = z.object({
  url: z.string().url(),
  startingRef: z.string().optional(),
  prUrl: z.string().optional(),
});

function registerTools(server: McpServer, env: Env) {
  const client = new CursorClient(env);

  const handle = async <T>(fn: () => Promise<T>) => {
    try {
      return jsonToolResult(await fn());
    } catch (error) {
      return jsonToolResult(cursorErrorPayload(error));
    }
  };

  server.registerTool(
    "cursor_whoami",
    {
      description:
        "Verify the configured Cursor API key via GET /v1/me. " + UNTRUSTED_CONTENT_NOTICE,
      inputSchema: {},
    },
    async () => handle(() => client.get("/v1/me")),
  );

  server.registerTool(
    "cursor_list_models",
    {
      description:
        "List models available for Cloud Agents (GET /v1/models). " +
        UNTRUSTED_CONTENT_NOTICE,
      inputSchema: {},
    },
    async () => handle(() => client.get("/v1/models")),
  );

  server.registerTool(
    "cursor_create_agent",
    {
      description:
        "Create a Cursor Cloud Agent and enqueue its initial run (POST /v1/agents). " +
        "Omit repos for a no-repo agent (research, documents, PDFs, etc.). " +
        "Deliverables must be written under /opt/cursor/artifacts/ (see delivery rules prepended to the prompt). " +
        CLOUD_AGENT_SAFETY_NOTICE +
        " " +
        UNTRUSTED_CONTENT_NOTICE,
      inputSchema: {
        prompt: z.string().min(1),
        name: z.string().max(100).optional(),
        model: z.string().optional(),
        mode: z.enum(["agent", "plan"]).optional(),
        images: z.array(imageSchema).max(5).optional(),
        repos: z.array(repoSchema).max(20).optional(),
        append_delivery_rules: z.boolean().optional().default(true),
        agent_id: z
          .string()
          .regex(/^bc-[0-9a-f-]{36}$/i)
          .optional(),
      },
    },
    async (input) =>
      handle(async () => {
        const rate = await checkCreateAgentRateLimit(env);
        if (!rate.allowed) {
          throw new CursorApiError(429, "rate_limit_exceeded", rate.note ?? "Rate limit exceeded");
        }

        const agentId = input.agent_id ?? newAgentId();
        const body: Record<string, unknown> = {
          agentId,
          prompt: {
            text: prependDeliveryRules(
              input.prompt,
              env,
              input.append_delivery_rules ?? true,
            ),
            ...(input.images?.length ? { images: input.images } : {}),
          },
        };
        if (input.name) body.name = input.name;
        if (input.mode) body.mode = input.mode;
        if (input.model) body.model = { id: input.model };
        if (input.repos?.length) body.repos = input.repos;

        try {
          return await client.post<{ agent: Record<string, unknown>; run: Record<string, unknown> }>(
            "/v1/agents",
            body,
          );
        } catch (error) {
          if (
            error instanceof CursorApiError &&
            error.status === 409 &&
            error.code === "agent_id_conflict"
          ) {
            const agent = await client.get<Record<string, unknown>>(
              `/v1/agents/${encodeURIComponent(agentId)}`,
            );
            const latestRunId =
              typeof agent.latestRunId === "string" ? agent.latestRunId : undefined;
            const run = latestRunId
              ? await client.get<Record<string, unknown>>(
                  `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(latestRunId)}`,
                )
              : null;
            return { agent, run, idempotent: true };
          }
          throw error;
        }
      }),
  );

  server.registerTool(
    "cursor_send_followup",
    {
      description:
        "Send a follow-up prompt to an existing agent (POST /v1/agents/{id}/runs). " +
        "Only one active run per agent; 409 agent_busy if a run is still CREATING/RUNNING. " +
        CLOUD_AGENT_SAFETY_NOTICE +
        " " +
        UNTRUSTED_CONTENT_NOTICE,
      inputSchema: {
        agent_id: z.string().min(1),
        prompt: z.string().min(1),
        mode: z.enum(["agent", "plan"]).optional(),
        images: z.array(imageSchema).max(5).optional(),
        append_delivery_rules: z.boolean().optional().default(true),
      },
    },
    async (input) =>
      handle(async () => {
        const body: Record<string, unknown> = {
          prompt: {
            text: prependDeliveryRules(
              input.prompt,
              env,
              input.append_delivery_rules ?? true,
            ),
            ...(input.images?.length ? { images: input.images } : {}),
          },
        };
        if (input.mode) body.mode = input.mode;

        try {
          return await client.post<{ run: Record<string, unknown> }>(
            `/v1/agents/${encodeURIComponent(input.agent_id)}/runs`,
            body,
          );
        } catch (error) {
          if (error instanceof CursorApiError && error.code === "agent_busy") {
            throw new CursorApiError(
              409,
              "agent_busy",
              "上一个任务仍在运行,请先 cursor_wait_run 等待完成或 cursor_cancel_run 取消后再发送追问。",
            );
          }
          throw error;
        }
      }),
  );

  server.registerTool(
    "cursor_get_agent",
    {
      description: "Get durable agent metadata (GET /v1/agents/{id}). " + UNTRUSTED_CONTENT_NOTICE,
      inputSchema: { agent_id: z.string().min(1) },
    },
    async ({ agent_id }) =>
      handle(() => client.get(`/v1/agents/${encodeURIComponent(agent_id)}`)),
  );

  server.registerTool(
    "cursor_get_run",
    {
      description:
        "Get run status, result, and durationMs when terminal (GET /v1/agents/{id}/runs/{runId}). " +
        UNTRUSTED_CONTENT_NOTICE,
      inputSchema: {
        agent_id: z.string().min(1),
        run_id: z.string().min(1),
      },
    },
    async ({ agent_id, run_id }) =>
      handle(() =>
        client.get(
          `/v1/agents/${encodeURIComponent(agent_id)}/runs/${encodeURIComponent(run_id)}`,
        ),
      ),
  );

  server.registerTool(
    "cursor_wait_run",
    {
      description:
        "Poll cursor_get_run every ~4s until the run reaches a terminal status or timeout_seconds elapses (default 25, max 45). " +
        UNTRUSTED_CONTENT_NOTICE,
      inputSchema: {
        agent_id: z.string().min(1),
        run_id: z.string().min(1),
        timeout_seconds: z.number().int().min(1).max(45).optional().default(25),
        poll_interval_seconds: z.number().min(3).max(5).optional().default(4),
      },
    },
    async ({ agent_id, run_id, timeout_seconds, poll_interval_seconds }) =>
      handle(async () => {
        const deadline = Date.now() + timeout_seconds * 1000;
        let last: Record<string, unknown> | null = null;

        while (Date.now() < deadline) {
          last = await client.get<Record<string, unknown>>(
            `/v1/agents/${encodeURIComponent(agent_id)}/runs/${encodeURIComponent(run_id)}`,
          );
          const status = typeof last.status === "string" ? last.status : "";
          if (isTerminalRunStatus(status)) {
            return { ...last, timedOut: false };
          }
          await sleep(poll_interval_seconds * 1000);
        }

        if (!last) {
          last = await client.get<Record<string, unknown>>(
            `/v1/agents/${encodeURIComponent(agent_id)}/runs/${encodeURIComponent(run_id)}`,
          );
        }

        return {
          ...last,
          timedOut: true,
          message:
            "任务仍在运行,请稍后再次调用 cursor_wait_run (或 cursor_get_run) 查看进度。",
        };
      }),
  );

  server.registerTool(
    "cursor_list_runs",
    {
      description: "List runs for an agent with pagination (GET /v1/agents/{id}/runs).",
      inputSchema: {
        agent_id: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
    },
    async ({ agent_id, limit, cursor }) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      if (cursor) params.set("cursor", cursor);
      const qs = params.toString();
      const path = `/v1/agents/${encodeURIComponent(agent_id)}/runs${qs ? `?${qs}` : ""}`;
      return handle(() => client.get(path));
    },
  );

  server.registerTool(
    "cursor_cancel_run",
    {
      description: "Cancel an active run (POST /v1/agents/{id}/runs/{runId}/cancel).",
      inputSchema: {
        agent_id: z.string().min(1),
        run_id: z.string().min(1),
      },
    },
    async ({ agent_id, run_id }) =>
      handle(() =>
        client.post(
          `/v1/agents/${encodeURIComponent(agent_id)}/runs/${encodeURIComponent(run_id)}/cancel`,
        ),
      ),
  );

  server.registerTool(
    "cursor_list_artifacts",
    {
      description:
        "List agent artifacts (GET /v1/agents/{id}/artifacts). Paths include the artifacts/ prefix. " +
        UNTRUSTED_CONTENT_NOTICE,
      inputSchema: { agent_id: z.string().min(1) },
    },
    async ({ agent_id }) =>
      handle(async () => {
        const listing = await client.get<{ items?: Array<Record<string, unknown>> }>(
          `/v1/agents/${encodeURIComponent(agent_id)}/artifacts`,
        );
        const items = listing.items ?? [];
        if (items.length > 0) {
          return listing;
        }

        const agent = await client.get<Record<string, unknown>>(
          `/v1/agents/${encodeURIComponent(agent_id)}`,
        );
        const latestRunId =
          typeof agent.latestRunId === "string" ? agent.latestRunId : undefined;
        let hint: string | undefined;
        if (latestRunId) {
          const run = await client.get<Record<string, unknown>>(
            `/v1/agents/${encodeURIComponent(agent_id)}/runs/${encodeURIComponent(latestRunId)}`,
          );
          const status = typeof run.status === "string" ? run.status : "";
          if (isTerminalRunStatus(status)) {
            hint =
              "产物为空。可能是 Agent 把文件保存到了 /opt/cursor/artifacts/ 之外,请用 cursor_send_followup 让它把文件复制到该目录。";
          }
        }

        return hint ? { ...listing, hint } : listing;
      }),
  );

  server.registerTool(
    "cursor_get_artifact",
    {
      description:
        "Download artifact metadata or inline text for small text files (GET .../artifacts/download). " +
        "Use the path from cursor_list_artifacts (artifacts/ prefix required). " +
        UNTRUSTED_CONTENT_NOTICE,
      inputSchema: {
        agent_id: z.string().min(1),
        path: z.string().min(1),
      },
    },
    async ({ agent_id, path }) =>
      handle(async () => {
        const normalized = normalizeArtifactPath(path);
        const download = await client.get<{ url: string; expiresAt: string }>(
          `/v1/agents/${encodeURIComponent(agent_id)}/artifacts/download?path=${encodeURIComponent(normalized)}`,
        );

        const listing = await client.get<{ items?: Array<{ path: string; sizeBytes: number }> }>(
          `/v1/agents/${encodeURIComponent(agent_id)}/artifacts`,
        );
        const meta = listing.items?.find((item) => item.path === normalized);
        const sizeBytes = meta?.sizeBytes ?? 0;

        if (isLikelyTextArtifact(normalized, sizeBytes)) {
          const fileResp = await fetch(download.url);
          if (!fileResp.ok) {
            throw new CursorApiError(
              fileResp.status,
              "artifact_fetch_failed",
              "Failed to fetch artifact content from presigned URL",
            );
          }
          const text = await fileResp.text();
          return {
            path: normalized,
            sizeBytes,
            contentType: "text",
            text,
            expiresAt: download.expiresAt,
            note: "Presigned URL expires in ~15 minutes.",
            // TODO phase 2: 镜像到 R2 并返回自有的限时链接
          };
        }

        return {
          path: normalized,
          sizeBytes,
          url: download.url,
          expiresAt: download.expiresAt,
          note: "Presigned URL 约 15 分钟后过期;大文件请直接 GET url 下载,勿通过 MCP 拉取二进制。",
          // TODO phase 2: 镜像到 R2 并返回自有的限时链接
        };
      }),
  );

  server.registerTool(
    "cursor_get_usage",
    {
      description: "Get token usage for an agent (GET /v1/agents/{id}/usage).",
      inputSchema: {
        agent_id: z.string().min(1),
        run_id: z.string().optional(),
      },
    },
    async ({ agent_id, run_id }) => {
      const params = new URLSearchParams();
      if (run_id) params.set("runId", run_id);
      const qs = params.toString();
      const path = `/v1/agents/${encodeURIComponent(agent_id)}/usage${qs ? `?${qs}` : ""}`;
      return handle(() => client.get(path));
    },
  );

  server.registerTool(
    "cursor_get_run_events",
    {
      description:
        "Collect recent assistant and tool_call SSE events for up to 10 seconds (GET .../stream). " +
        UNTRUSTED_CONTENT_NOTICE,
      inputSchema: {
        agent_id: z.string().min(1),
        run_id: z.string().min(1),
        max_seconds: z.number().min(1).max(10).optional().default(10),
      },
    },
    async ({ agent_id, run_id, max_seconds }) =>
      handle(() => client.streamRunEvents(agent_id, run_id, max_seconds * 1000)),
  );
}

export function createMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: "cursor-cloud-agents-mcp-bridge",
    version: "1.0.0",
  });
  registerTools(server, env);
  return server;
}
