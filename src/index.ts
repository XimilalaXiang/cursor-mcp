import { createMcpHandler } from "agents/mcp/server";
import { createMcpServer } from "./mcp-tools";
import { parseBearerToken, secureCompare } from "./util";

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

function isMcpRoute(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === "/mcp" || pathname.startsWith("/mcp/");
}

function validateBridgeAuth(request: Request, env: Env): boolean {
  const token = parseBearerToken(request);
  if (!token || !env.BRIDGE_TOKEN) {
    return false;
  }
  return secureCompare(token, env.BRIDGE_TOKEN);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    if (isMcpRoute(request) && !validateBridgeAuth(request, env)) {
      return unauthorized();
    }

    const handler = createMcpHandler(() => createMcpServer(env), {
      route: "/mcp",
    });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
