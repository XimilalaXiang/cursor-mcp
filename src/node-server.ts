import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadEnvFromProcess, resolveListenPort } from "./config.js";
import { createBridgeMcpHandler, handleBridgeMcpRequest } from "./mcp-http.js";

function readRequestBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  if (req.method === "GET" || req.method === "HEAD") {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      resolve(chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined);
    });
    req.on("error", reject);
  });
}

async function incomingMessageToRequest(
  req: IncomingMessage,
  baseUrl: string,
): Promise<Request> {
  const url = new URL(req.url ?? "/", baseUrl);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const body = await readRequestBody(req);
  return new Request(url, {
    method: req.method ?? "GET",
    headers,
    body: body as BodyInit | undefined,
  });
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}

const env = loadEnvFromProcess();
const mcpHandler = createBridgeMcpHandler(env);
const port = resolveListenPort();

const server = createServer(async (req, res) => {
  try {
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname === "/health" || pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    const host = req.headers.host ?? `127.0.0.1:${port}`;
    const request = await incomingMessageToRequest(req, `http://${host}`);
    const response = await handleBridgeMcpRequest(request, env, mcpHandler);
    await sendResponse(res, response);
  } catch {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end("Internal Server Error");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Cursor MCP bridge listening on http://0.0.0.0:${port}/mcp`);
});
