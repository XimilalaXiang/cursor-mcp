import { createBridgeMcpHandler, handleBridgeMcpRequest } from "./mcp-http.js";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const handler = createBridgeMcpHandler(env);
    return handleBridgeMcpRequest(request, env, handler, ctx);
  },
} satisfies ExportedHandler<Env>;
