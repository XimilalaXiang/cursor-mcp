#!/usr/bin/env bash
set -euo pipefail

: "${MCP_URL:?Set MCP_URL to your deployed Worker /mcp URL}"
: "${BRIDGE_TOKEN:?Set BRIDGE_TOKEN to match wrangler secret}"

AUTH_HEADER="Authorization: Bearer ${BRIDGE_TOKEN}"
ACCEPT_HEADER="Accept: application/json, text/event-stream"
JSON_HEADER="Content-Type: application/json"

SESSION_ID=""
MCP_PROTOCOL="2024-11-05"

mcp_post() {
  local body="$1"
  local headers=(-H "$AUTH_HEADER" -H "$ACCEPT_HEADER" -H "$JSON_HEADER")
  if [[ -n "$SESSION_ID" ]]; then
    headers+=(-H "Mcp-Session-Id: $SESSION_ID")
  fi
  curl -sS -D /tmp/mcp-smoke-headers.txt -o /tmp/mcp-smoke-body.json -X POST "$MCP_URL" "${headers[@]}" -d "$body"
  if grep -qi '^mcp-session-id:' /tmp/mcp-smoke-headers.txt 2>/dev/null; then
    SESSION_ID=$(grep -i '^mcp-session-id:' /tmp/mcp-smoke-headers.txt | head -1 | cut -d: -f2- | tr -d ' \r')
  fi
  cat /tmp/mcp-smoke-body.json
  echo ""
}

extract_tool_text() {
  python3 - "$1" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
# JSON-RPC result -> MCP tool result content[0].text
try:
    text = data["result"]["content"][0]["text"]
except (KeyError, IndexError, TypeError):
    print(json.dumps(data))
    sys.exit(0)
print(text)
PY
}

echo "== initialize =="
mcp_post "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"$MCP_PROTOCOL\",\"capabilities\":{},\"clientInfo\":{\"name\":\"smoke-test\",\"version\":\"1.0.0\"}}}" > /dev/null

echo "== notifications/initialized =="
mcp_post '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' > /dev/null || true

echo "== cursor_whoami =="
WHOAMI_RESP=$(mcp_post '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"cursor_whoami","arguments":{}}}')
echo "$WHOAMI_RESP" | head -c 500
echo ""

echo "== cursor_create_agent (no-repo PDF task) =="
CREATE_BODY=$(cat <<'JSON'
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"cursor_create_agent","arguments":{"name":"smoke-test-pdf","prompt":"生成一份仅 1 页的中文 PDF,标题为 Smoke Test,保存文件名 smoke-test.pdf"}}}
JSON
)
CREATE_RESP=$(mcp_post "$CREATE_BODY")
CREATE_TEXT=$(echo "$CREATE_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result',{}).get('content',[{}])[0].get('text','{}'))")
AGENT_ID=$(echo "$CREATE_TEXT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('agent',{}).get('id') or d.get('agent_id',''))")
RUN_ID=$(echo "$CREATE_TEXT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('run',{}).get('id') or d.get('run_id',''))")
echo "agent=$AGENT_ID run=$RUN_ID"
if [[ -z "$AGENT_ID" || -z "$RUN_ID" ]]; then
  echo "Failed to parse agent/run from create response" >&2
  exit 1
fi

echo "== cursor_wait_run =="
WAIT_BODY=$(printf '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"cursor_wait_run","arguments":{"agent_id":"%s","run_id":"%s","timeout_seconds":45}}}' "$AGENT_ID" "$RUN_ID")
WAIT_RESP=$(mcp_post "$WAIT_BODY")
echo "$WAIT_RESP" | head -c 800
echo ""

echo "== cursor_list_artifacts =="
LIST_BODY=$(printf '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"cursor_list_artifacts","arguments":{"agent_id":"%s"}}}' "$AGENT_ID")
LIST_RESP=$(mcp_post "$LIST_BODY")
echo "$LIST_RESP" | head -c 800
echo ""

ART_PATH=$(echo "$LIST_RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
text=d.get('result',{}).get('content',[{}])[0].get('text','{}')
data=json.loads(text)
items=data.get('items') or []
print(items[0]['path'] if items else '')
")
if [[ -z "$ART_PATH" ]]; then
  echo "No artifacts listed (Agent may still be writing or path wrong)" >&2
  exit 1
fi

echo "== cursor_get_artifact path=$ART_PATH =="
GET_ART=$(printf '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"cursor_get_artifact","arguments":{"agent_id":"%s","path":"%s"}}}' "$AGENT_ID" "$ART_PATH")
mcp_post "$GET_ART" | head -c 800
echo ""
echo "Smoke test finished."
