// Post-install check for the self-hosted C4C MCP server. No dependencies beyond Node 24.
//
//   C4C_AUTH_TOKEN=<token> node server/verify-install.mjs --url https://c4c.example.internal/mcp
//
// Inside the container the token is already in the environment:
//   docker exec c4c-mcp node server/verify-install.mjs --url http://127.0.0.1:8080/mcp
//
// The token is read only from the C4C_AUTH_TOKEN environment variable, never from the command
// line (it would land in shell history and process lists), and it is never printed.
// Steps: /healthz, initialize, tools/list (core tools), tools/call lookup_citation, and a request
// without the token (expects 401). Prints a PASS/WARN/FAIL checklist; exit 0 when nothing FAILs.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CORE_TOOLS = [
  "search_regs", "lookup_citation", "get_obligation", "find_in_section",
  "verify_quote", "get_reg", "list_playbooks", "start_playbook",
];
export const TEST_CITATION = "12 CFR 1026.43";
const PROTOCOL_VERSION = "2025-06-18";

export function healthzUrl(mcpUrl) {
  const u = new URL(mcpUrl);
  u.pathname = u.pathname.replace(/\/mcp\/?$/, "").replace(/\/$/, "") + "/healthz";
  u.search = "";
  return u.toString();
}

// A streamable HTTP response is either plain JSON or an SSE stream of `data:` lines.
export function parseRpcBody(text) {
  const t = (text ?? "").trim();
  if (!t) return null;
  if (t.startsWith("{") || t.startsWith("[")) return JSON.parse(t);
  let last = null;
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    try { const m = JSON.parse(buf.join("\n")); if (m && (m.result !== undefined || m.error !== undefined)) last = m; } catch {}
    buf = [];
  };
  for (const line of t.split(/\r?\n/)) {
    if (line.startsWith("data:")) buf.push(line.slice(5).replace(/^ /, ""));
    else if (line === "") flush();
  }
  flush();
  return last;
}

function describeError(e) {
  const c = e?.cause;
  const code = c?.code ?? e?.code;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "timed out";
  if (code === "ECONNREFUSED") return "connection refused (is the container running and the port published?)";
  if (code === "ENOTFOUND") return "host name not found";
  if (code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return `TLS certificate not trusted (${code}); set NODE_EXTRA_CA_CERTS to your CA bundle`;
  return c?.message ?? e?.message ?? String(e);
}

export async function runChecks({ url, token = null, fetchFn = fetch, timeoutMs = 20_000 } = {}) {
  const results = [];
  const add = (status, name, detail) => results.push({ status, name, detail });
  const signal = () => AbortSignal.timeout(timeoutMs);
  let session = null;
  let protocol = null;

  async function rpc(body, { auth = true } = {}) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (auth && token) headers.authorization = `Bearer ${token}`;
    if (session) headers["mcp-session-id"] = session;
    if (protocol) headers["mcp-protocol-version"] = protocol;
    const res = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(body), signal: signal() });
    const text = await res.text();
    let json = null;
    try { json = parseRpcBody(text); } catch {}
    return { res, json, text };
  }

  try { new URL(url); } catch {
    add("FAIL", "URL", `not a valid URL: ${url}`);
    return results;
  }

  // 1. /healthz
  try {
    const res = await fetchFn(healthzUrl(url), { signal: signal() });
    const body = await res.json().catch(() => null);
    if (res.status === 200 && body?.ok) {
      const d = `library ${body.library_version}, ${body.age_days} days old`;
      if (body.stale) add("WARN", "Health", `${d}, STALE (no new library within C4C_STALE_DAYS; check updates)`);
      else add("PASS", "Health", `${d}, current`);
    } else if (res.status === 503 && body?.reason === "no_library") {
      add("FAIL", "Health", "server is up but no library is installed yet (see INSTALL.md First start / Offline load)");
    } else {
      add("FAIL", "Health", `unexpected HTTP ${res.status} from ${healthzUrl(url)}`);
    }
  } catch (e) {
    add("FAIL", "Health", `cannot reach ${healthzUrl(url)}: ${describeError(e)}`);
    return results;
  }

  // 2. initialize
  try {
    const r = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "c4c-verify-install", version: "1.0.0" } } });
    if (r.res.status === 401) {
      add("FAIL", "Initialize", token ? "HTTP 401: the token in C4C_AUTH_TOKEN does not match the server's" : "HTTP 401: the server requires a token; set C4C_AUTH_TOKEN in this shell");
      return results;
    }
    const info = r.json?.result?.serverInfo;
    if (r.res.status !== 200 || !info) {
      add("FAIL", "Initialize", `HTTP ${r.res.status}${r.json?.error ? `: ${r.json.error.message}` : ""}`);
      return results;
    }
    session = r.res.headers.get("mcp-session-id");
    protocol = r.json.result.protocolVersion ?? null;
    add("PASS", "Initialize", `${info.name} ${info.version ?? ""}`.trim() + (protocol ? `, protocol ${protocol}` : ""));
    await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
  } catch (e) {
    add("FAIL", "Initialize", describeError(e));
    return results;
  }

  // 3. tools/list
  try {
    const r = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = (r.json?.result?.tools ?? []).map((t) => t.name);
    const missing = CORE_TOOLS.filter((n) => !names.includes(n));
    if (r.res.status === 200 && names.length && !missing.length) add("PASS", "Tools", `${names.length} tools, all ${CORE_TOOLS.length} core tools present`);
    else add("FAIL", "Tools", names.length ? `missing: ${missing.join(", ")}` : `no tools returned (HTTP ${r.res.status})`);
  } catch (e) {
    add("FAIL", "Tools", describeError(e));
  }

  // 4. tools/call lookup_citation
  try {
    const r = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "lookup_citation", arguments: { citation: TEST_CITATION } } });
    const result = r.json?.result;
    const text = (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    if (r.res.status === 200 && result && !result.isError && text.includes("1026.43") && parsed && !parsed.error && parsed.register_id) {
      add("PASS", "Lookup", `${TEST_CITATION} -> ${parsed.register_id}`);
    } else if (result?.isError) {
      add("FAIL", "Lookup", `tool error: ${text.slice(0, 200)}`);
    } else if (parsed?.error) {
      add("FAIL", "Lookup", `${TEST_CITATION} returned ${parsed.error}; the library may be incomplete`);
    } else {
      add("FAIL", "Lookup", `unexpected answer (HTTP ${r.res.status}): ${(text || r.text || "").slice(0, 200)}`);
    }
  } catch (e) {
    add("FAIL", "Lookup", describeError(e));
  }

  // 5. Auth enforced?
  try {
    const r = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }, { auth: false });
    if (r.res.status === 401) add("PASS", "Auth", "a request without the token is refused (401)");
    else add("WARN", "Auth", `a request without the token got HTTP ${r.res.status}; set C4C_AUTH_TOKEN on the server unless a gateway in front enforces auth`);
  } catch (e) {
    add("WARN", "Auth", `could not test: ${describeError(e)}`);
  }

  return results;
}

export function formatResults(results) {
  const lines = results.map((r) => `[${r.status}] ${r.name.padEnd(10)} ${r.detail}`);
  const failed = results.some((r) => r.status === "FAIL");
  lines.push("", failed ? "RESULT: FAIL" : "RESULT: PASS");
  return { text: lines.join("\n"), ok: !failed };
}

export function parseArgs(argv) {
  const out = { url: null, timeoutMs: 20_000, help: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--url") out.url = argv[++i] ?? null;
    else if (a.startsWith("--url=")) out.url = a.slice(6);
    else if (a === "--timeout") out.timeoutMs = Number(argv[++i]) * 1000;
    else if (/^--(token|auth|bearer)/.test(a)) { out.error = "Do not pass the token on the command line. Set the C4C_AUTH_TOKEN environment variable instead."; break; }
    else { out.error = `unknown argument: ${a}`; break; }
  }
  if (!out.help && !out.error && !out.url) out.error = "missing --url (for example --url https://c4c.example.internal/mcp)";
  if (!out.error && (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0)) out.error = "--timeout must be a number of seconds";
  return out;
}

const USAGE = `Usage: node server/verify-install.mjs --url <http(s)://host:8080/mcp> [--timeout <seconds>]
The bearer token is read from the C4C_AUTH_TOKEN environment variable (never from the command line).`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return 0; }
  if (args.error) { console.error(`${args.error}\n${USAGE}`); return 2; }
  const token = process.env.C4C_AUTH_TOKEN?.trim() || null;
  console.log(`C4C install check: ${args.url} (token ${token ? "from C4C_AUTH_TOKEN" : "not set"})\n`);
  const { text, ok } = formatResults(await runChecks({ url: args.url, token, timeoutMs: args.timeoutMs }));
  console.log(text);
  return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  process.exitCode = await main();
}
