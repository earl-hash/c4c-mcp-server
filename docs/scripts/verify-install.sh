#!/usr/bin/env bash
# C4C self-hosted: post-install check with bash and curl.
#
#   export C4C_AUTH_TOKEN='<your token>'      # read from the environment, never printed
#   ./verify-install.sh https://c4c.example.internal/mcp
#
# Checks /healthz, MCP initialize, tools/list and one lookup_citation call.
# Exit 0 when every check passes, 1 when any fails, 2 on bad usage.
# Research use only. C4C returns regulatory text and citations; it is not legal advice.
set -u

URL="${1:-}"
if [ -z "$URL" ] || [ "$URL" = "-h" ] || [ "$URL" = "--help" ]; then
  echo "Usage: C4C_AUTH_TOKEN=<token> $0 <http(s)://host:8080/mcp>" >&2
  exit 2
fi
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 2; }

BASE="${URL%/}"
HEALTH="${BASE%/mcp}/healthz"
TOKEN="${C4C_AUTH_TOKEN:-}"
FAILED=0
pass() { printf '[PASS] %-10s %s\n' "$1" "$2"; }
warn() { printf '[WARN] %-10s %s\n' "$1" "$2"; }
fail() { printf '[FAIL] %-10s %s\n' "$1" "$2"; FAILED=1; }

# The token goes to curl through a header file in a private temp dir, so it never shows in
# the process list (curl -H on the command line would).
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
chmod 700 "$TMP"
HDRS="$TMP/headers"
{
  echo "Content-Type: application/json"
  echo "Accept: application/json, text/event-stream"
  [ -n "$TOKEN" ] && echo "Authorization: Bearer $TOKEN"
} > "$HDRS"

# rpc <json-body>: sets STATUS (HTTP code, 000 if unreachable) and BODY (the JSON-RPC message).
rpc() {
  STATUS="$(curl -sS -m 20 -o "$TMP/body" -w '%{http_code}' -H @"$HDRS" -X POST --data "$1" "$BASE" 2>"$TMP/err")" || STATUS="000"
  # Streamable HTTP answers in JSON or as SSE "data:" lines; keep the JSON either way.
  if grep -q '^data:' "$TMP/body" 2>/dev/null; then BODY="$(sed -n 's/^data: \{0,1\}//p' "$TMP/body" | tail -n 1)"; else BODY="$(cat "$TMP/body" 2>/dev/null)"; fi
}

if [ -n "$TOKEN" ]; then echo "C4C install check: $BASE (token from C4C_AUTH_TOKEN)"; else echo "C4C install check: $BASE (token not set)"; fi
echo

# 1. Health
H_STATUS="$(curl -sS -m 20 -o "$TMP/health" -w '%{http_code}' "$HEALTH" 2>"$TMP/err")" || H_STATUS="000"
H_BODY="$(cat "$TMP/health" 2>/dev/null)"
if [ "$H_STATUS" = "200" ]; then
  if echo "$H_BODY" | grep -q '"stale":true'; then warn Health "STALE library: $H_BODY"; else pass Health "$H_BODY"; fi
elif [ "$H_STATUS" = "503" ]; then
  fail Health "no library installed yet: $H_BODY"
elif [ "$H_STATUS" = "000" ]; then
  fail Health "cannot reach $HEALTH: $(cat "$TMP/err")"; echo; echo "RESULT: FAIL"; exit 1
else
  fail Health "HTTP $H_STATUS from $HEALTH"
fi

# 2. Initialize
rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c4c-verify-sh","version":"1.0.0"}}}'
if [ "$STATUS" = "401" ]; then
  fail Initialize "HTTP 401: set C4C_AUTH_TOKEN to the server's token"; echo; echo "RESULT: FAIL"; exit 1
elif [ "$STATUS" = "200" ] && echo "$BODY" | grep -q '"serverInfo"'; then
  pass Initialize "$(echo "$BODY" | grep -o '"serverInfo":{[^}]*}')"
else
  fail Initialize "HTTP $STATUS: $(echo "$BODY" | head -c 200)"; echo; echo "RESULT: FAIL"; exit 1
fi

# 3. tools/list
rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
MISSING=""
for t in search_regs lookup_citation get_obligation find_in_section verify_quote get_reg list_playbooks start_playbook; do
  echo "$BODY" | grep -q "\"name\":\"$t\"" || MISSING="$MISSING $t"
done
if [ "$STATUS" = "200" ] && [ -z "$MISSING" ]; then pass Tools "all 8 core tools present"; else fail Tools "HTTP $STATUS, missing:${MISSING:- (no answer)}"; fi

# 4. lookup_citation
rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"lookup_citation","arguments":{"citation":"12 CFR 1026.43"}}}'
if [ "$STATUS" = "200" ] && echo "$BODY" | grep -q 'register_id' && echo "$BODY" | grep -q '1026.43' \
   && ! echo "$BODY" | grep -q '"isError":true' && ! echo "$BODY" | grep -q '\\"error\\"'; then
  pass Lookup "12 CFR 1026.43 resolved"
else
  fail Lookup "HTTP $STATUS: $(echo "$BODY" | head -c 200)"
fi

# 5. Without the token
STATUS="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -X POST --data '{"jsonrpc":"2.0","id":4,"method":"tools/list","params":{}}' "$BASE" 2>/dev/null)" || STATUS="000"
if [ "$STATUS" = "401" ]; then pass Auth "a request without the token is refused (401)"
else warn Auth "a request without the token got HTTP $STATUS; set C4C_AUTH_TOKEN on the server"; fi

echo
if [ "$FAILED" = 0 ]; then echo "RESULT: PASS"; exit 0; else echo "RESULT: FAIL"; exit 1; fi
