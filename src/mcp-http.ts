import { createMcpHandler } from "agents/mcp/server";
import { createMcpServer } from "./mcp-tools.js";
import { parseBearerToken, secureCompare } from "./util.js";

export function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

export function isMcpRoute(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === "/mcp" || pathname.startsWith("/mcp/");
}

export function validateBridgeAuth(request: Request, env: Env): boolean {
  const token = parseBearerToken(request);
  if (!token || !env.BRIDGE_TOKEN) {
    return false;
  }
  return secureCompare(token, env.BRIDGE_TOKEN);
}

export type BridgeMcpHandler = ReturnType<typeof createBridgeMcpHandler>;

export function createBridgeMcpHandler(env: Env) {
  return createMcpHandler(() => createMcpServer(env), {
    route: "/mcp",
  });
}

export function handleBridgeMcpRequest(
  request: Request,
  env: Env,
  handler: BridgeMcpHandler,
  ctx?: ExecutionContext,
): Response | Promise<Response> {
  if (isMcpRoute(request) && !validateBridgeAuth(request, env)) {
    return unauthorized();
  }
  return handler(request, env, ctx ?? ({} as ExecutionContext));
}
