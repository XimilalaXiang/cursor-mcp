import { CURSOR_API_BASE } from "./util.js";

export class CursorApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CursorApiError";
    this.status = status;
    this.code = code;
  }
}

function parseCursorErrorBody(
  status: number,
  body: unknown,
): { code: string; message: string } {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (record.error && typeof record.error === "object") {
      const err = record.error as Record<string, unknown>;
      return {
        code: typeof err.code === "string" ? err.code : "unknown_error",
        message:
          typeof err.message === "string" ? err.message : "Unknown Cursor API error",
      };
    }
    if (typeof record.code === "string" && typeof record.message === "string") {
      return { code: record.code, message: record.message };
    }
  }
  return {
    code: "http_error",
    message: `Cursor API request failed with HTTP ${status}`,
  };
}

function mapCursorError(status: number, code: string, message: string): CursorApiError {
  if (status === 401 || status === 403) {
    return new CursorApiError(
      status,
      code,
      `${message} — API key 无效或权限不足。无仓库 Agent 可能未对该账号开通,或使用了仓库范围受限的 key。`,
    );
  }
  return new CursorApiError(status, code, message);
}

export class CursorClient {
  constructor(private readonly env: Env) {}

  private timeoutMs(): number {
    const parsed = parseInt(this.env.CURSOR_REQUEST_TIMEOUT_MS ?? "30000", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
  }

  async request<T>(
    path: string,
    init: RequestInit = {},
    retry429 = 0,
    retry5xx = 0,
  ): Promise<T> {
    const url = `${CURSOR_API_BASE}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs());

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.env.CURSOR_API_KEY}`,
          Accept: "application/json",
          ...(init.headers ?? {}),
        },
      });

      const contentType = response.headers.get("content-type") ?? "";
      let body: unknown = null;
      if (contentType.includes("application/json")) {
        body = await response.json();
      } else if (response.status !== 204) {
        const text = await response.text();
        body = text ? { message: text } : null;
      }

      if (response.ok) {
        return body as T;
      }

      const { code, message } = parseCursorErrorBody(response.status, body);
      const err = mapCursorError(response.status, code, message);

      if (response.status === 429 && retry429 < 3) {
        const backoffMs = 500 * 2 ** retry429;
        await new Promise((r) => setTimeout(r, backoffMs));
        return this.request<T>(path, init, retry429 + 1, retry5xx);
      }
      if (response.status >= 500 && retry5xx < 2) {
        const backoffMs = 400 * 2 ** retry5xx;
        await new Promise((r) => setTimeout(r, backoffMs));
        return this.request<T>(path, init, retry429, retry5xx + 1);
      }

      throw err;
    } catch (error) {
      if (error instanceof CursorApiError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new CursorApiError(408, "timeout", "Cursor API 请求超时");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  }

  async streamRunEvents(
    agentId: string,
    runId: string,
    maxMs: number,
  ): Promise<{
    events: Array<{ type: string; summary: string }>;
    truncated: boolean;
    timedOut: boolean;
  }> {
    const url = `${CURSOR_API_BASE}/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), maxMs);

    const events: Array<{ type: string; summary: string }> = [];
    let timedOut = false;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.env.CURSOR_API_KEY}`,
          Accept: "text/event-stream",
        },
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const body = response.headers.get("content-type")?.includes("json")
          ? await response.json()
          : null;
        const { code, message } = parseCursorErrorBody(response.status, body);
        throw mapCursorError(response.status, code, message);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let currentData = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            currentData = line.slice(5).trim();
          } else if (line === "" && currentEvent) {
            if (currentEvent === "assistant" || currentEvent === "tool_call") {
              let summary = currentData;
              try {
                const parsed = JSON.parse(currentData) as Record<string, unknown>;
                if (currentEvent === "assistant" && typeof parsed.text === "string") {
                  summary = parsed.text.slice(0, 500);
                } else if (currentEvent === "tool_call") {
                  const name = typeof parsed.name === "string" ? parsed.name : "tool";
                  const status =
                    typeof parsed.status === "string" ? parsed.status : "unknown";
                  summary = `${name} (${status})`;
                }
              } catch {
                summary = currentData.slice(0, 500);
              }
              events.push({ type: currentEvent, summary });
              if (events.length > 50) {
                events.shift();
              }
            }
            currentEvent = "";
            currentData = "";
          }
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        timedOut = true;
      } else {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }

    return { events, truncated: timedOut, timedOut };
  }
}

export function cursorErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof CursorApiError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        status: error.status,
      },
    };
  }
  return {
    error: {
      code: "internal_error",
      message: error instanceof Error ? error.message : "Unknown error",
    },
  };
}
