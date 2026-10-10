export function loadEnvFromProcess(): Env {
  const bridgeToken = process.env.BRIDGE_TOKEN?.trim();
  const cursorApiKey = process.env.CURSOR_API_KEY?.trim();

  if (!bridgeToken) {
    throw new Error("BRIDGE_TOKEN is required");
  }
  if (!cursorApiKey) {
    throw new Error("CURSOR_API_KEY is required");
  }

  return {
    BRIDGE_TOKEN: bridgeToken,
    CURSOR_API_KEY: cursorApiKey,
    CREATE_AGENT_RATE_LIMIT_PER_MINUTE:
      process.env.CREATE_AGENT_RATE_LIMIT_PER_MINUTE,
    CURSOR_REQUEST_TIMEOUT_MS: process.env.CURSOR_REQUEST_TIMEOUT_MS,
    DELIVERY_RULES: process.env.DELIVERY_RULES,
    CURSOR_MCP_MAX_CHARS: process.env.CURSOR_MCP_MAX_CHARS,
  };
}

export function resolveTextOutputLimit(env: Env): number {
  const parsed = parseInt(env.CURSOR_MCP_MAX_CHARS ?? "6000", 10);
  if (!Number.isFinite(parsed) || parsed < 100) {
    return 6000;
  }
  return parsed;
}

export function resolveListenPort(): number {
  const parsed = parseInt(process.env.PORT ?? "8792", 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    return 8792;
  }
  return parsed;
}
