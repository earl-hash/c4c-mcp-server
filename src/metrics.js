// Launch instrumentation: aggregate, PII-free usage counters (launch-prep plan §1.2).
//
// One table, `metrics(day, name, n)` (migrations-corpus/0002_usage.sql), one row per UTC
// day per counter name. Names recorded:
//   req                        every Worker invocation (also the budget counter, budget.js)
//   initialize                 JSON-RPC `initialize` handshakes: the distinct-sessions proxy
//   tool:<tool>:<outcome>      one per tool call; outcome from outcomeOf() below, plus
//                              `refused` (over budget) and `error` (the tool threw). For the
//                              playbook tools the outcome is the playbook id (a fixed list).
//   prompt:<name>              one per prompts/get of a prompt (playbooks, regulatory-text)
//   client:<platform>          one per `initialize`, platform from clientInfo.name mapped onto a
//                              FIXED list (claude, claude-code, chatgpt, cursor, ...) or "other";
//                              if that name is other/unknown, the User-Agent's platform is used
//                              instead when it is a known one (still ONE client: per initialize)
//   platform:<platform>:tool   one per JSON-RPC `tools/call`, platform from the request's
//                              User-Agent mapped onto the SAME fixed list (uaPlatform below), so
//                              reused connections (no fresh initialize) are still attributed
//   via:<token>                one per `initialize` whose server URL carried ?via=<token> (the
//                              site shows /mcp?via=site); install attribution by SOURCE, never
//                              by person. Token must match [a-z0-9-]{1,24} or it is ignored.
//   via:<token>:tool           one per `tools/call` on such a URL: use by source (2026-10-09)
//   tool:<tool>:args_repaired  one per tools/call whose arguments src/lenient.js repaired before
//                              validation (alias, casing, text number, clamp) (2026-10-11)
//   tool:<tool>:rejected:<why> a call the SDK still turned away: unknown_tool or invalid_args;
//                              <tool> is one of ours, "unknown" or "batch", never caller text
//   bot:<name>                 EVERY counter above except `req`, when the request looks
//                              automated (automatedReason below), plus bot:why:<reason> once per
//                              JSON-RPC request. Replaces via-bot:* (2026-10-10)
//   hour:<HH>:tool             one per `tools/call`, by UTC hour (00-23) (2026-10-09)
//   agent:<kind>, agent:<kind>:tool
//                              per `initialize` / `tools/call` whose platform is other or
//                              unknown: WHAT KIND of program it is (python, node, curl,
//                              directory, monitor, crawler, browser, ...), from the User-Agent
//                              mapped onto a FIXED list (agentKind below), so a developer's
//                              script can be told from a directory crawler (2026-10-09)
//   doc:<register_id>          one per successful get_reg / get_obligation (first page only) /
//                              find_in_section / lookup_citation: which LIBRARY documents are
//                              used, by our own id read from the result, never from the
//                              arguments (privacy policy, 2026-10-09) (2026-10-09)
//   get_playbook_reference's outcome is <playbook id>:<reference name> once the name is
//   found in that playbook (a fixed list), so the funnel shows which stages are reached.
// NEVER arguments, results, IPs, user agents or any other identifier: same discipline as
// functions/api/pv.js. Every increment is ONE UPSERT inside ctx.waitUntil, off the hot
// path, and every failure is swallowed -- counting must never become an outage.

export const UPSERT_SQL =
  "INSERT INTO metrics (day, name, n) VALUES (?1, ?2, ?3) " +
  "ON CONFLICT (day, name) DO UPDATE SET n = n + excluded.n";

export function createRecorder(env, ctx, day) {
  return function record(name, n = 1) {
    try {
      if (!env?.CORPUS) return;
      const write = Promise.resolve()
        .then(() => env.CORPUS.prepare(UPSERT_SQL).bind(day, name, n).run())
        .catch(() => {});
      ctx?.waitUntil?.(write);
    } catch {
      // fail open
    }
  };
}

// Over budget the recorder is sampled: 1 in `every` events is written with weight
// `every`, so a flood past the stop stays visible (approximately) without buying a D1
// write per refused request -- the refusal path must stay cheaper than the service path.
export function sampledRecorder(record, every, random = Math.random) {
  return (name) => {
    if (random() < 1 / every) record(name, every);
  };
}

// JSON-RPC methods in a request body, read from a CLONE so the MCP handler still gets the
// original stream. Handles batches. Anything unreadable is [] -- never a throw.
async function rpcMessages(request) {
  if (request.method !== "POST") return [];
  try {
    const body = await request.clone().json();
    const msgs = Array.isArray(body) ? body : [body];
    return msgs.filter((m) => m && typeof m === "object" && typeof m.method === "string");
  } catch {
    return [];
  }
}

export async function rpcMethods(request) {
  return (await rpcMessages(request)).map((m) => m.method);
}

// Which AI platform opened a session, from the `clientInfo.name` every MCP client sends in
// `initialize` (Earl, 2026-09-25: count by platform, never by person). The raw name is
// NEVER stored: a client can put any text there, including an email address, so it is
// mapped onto a fixed list and everything else becomes "other". Order matters: the more
// specific pattern (claude-code) is tested before the general one (claude).
const CLIENT_PLATFORMS = [
  [/claude[\s_-]*code/i, "claude-code"],
  [/claude|anthropic/i, "claude"],
  [/openai|chatgpt/i, "chatgpt"],
  [/cursor/i, "cursor"],
  [/visual\s*studio\s*code|vscode|vs[\s_-]code/i, "vscode"],
  // Microsoft 365 Copilot (and other Copilot clients outside VS Code), 2026-10-09; before
  // this it was counted as vscode.
  [/copilot|microsoft/i, "copilot"],
  [/windsurf|codeium/i, "windsurf"],
  [/cline/i, "cline"],
  [/goose/i, "goose"],
];

// Our own domains contain "claude", so a registry bot that names the server it is probing
// ("BrickBlueBot/0.1 (+https://brick.blue/bot?h=mcp.claudeforcompliance.com)") read as the Claude
// platform, which also exempted it from the bot filter (2026-10-11: its 3 tool calls, rejected
// for bad arguments, were counted as Claude use). They are removed before matching.
const OWN_DOMAINS_RE = /claudeforcompliance|complianceforclaude/gi;

export function clientPlatform(name) {
  if (typeof name !== "string" || !name.trim()) return "unknown";
  const n = name.replace(OWN_DOMAINS_RE, "");
  for (const [re, platform] of CLIENT_PLATFORMS) if (re.test(n)) return platform;
  return "other";
}

// Install-source tag from the server URL's ?via= parameter (e.g. "site" for the address the
// website shows). A source label, not an identifier: short, fixed charset, else null (ignored).
const VIA_RE = /^[a-z0-9-]{1,24}$/;
// Known tokens only (security review 2026-10-12): any [a-z0-9-] value used to create its own
// permanent metrics row. Newsletter editions are news-NN; anything else is "other".
const VIA_KNOWN = new Set(["site", "eval", "sitecheck"]);
const VIA_NEWS = /^news-\d{2}$/;
export function viaTag(url) {
  try {
    const v = new URL(url).searchParams.get("via");
    if (!v || !VIA_RE.test(v)) return null;
    return VIA_KNOWN.has(v) || VIA_NEWS.test(v) ? v : "other";
  } catch {
    return null;
  }
}

// Directory crawlers, health probes and scripts that read the address off the website and
// connect with ?via=site are not installs (2026-10-07: 9 "installs" in a day, all probes such as
// mcplookup/mcphub/agentrank, against 1 human page view). Their initialize is counted as
// via-bot:<token> instead, so via:<token> stays a count of real clients. Generic HTTP tools
// (curl, wget, python-requests, urllib, aiohttp) count as bots; MCP SDK runtimes (node, httpx,
// Bun) and clients that send no user agent are kept, since real apps use them.
const AUTOMATED_UA_RE =
  /bot\b|crawl|spider|probe|scan|checker|sonda|monitor|harvest|collector|observatory|census|registry|-sync|lookup|liveness|stats|watch|prober|curl\/|wget|python-requests|python-urllib|aiohttp|go-http-client|okhttp|headless/i;
export function isAutomatedClient(userAgent) {
  return typeof userAgent === "string" && AUTOMATED_UA_RE.test(userAgent);
}

// Scraper filter (Earl, 2026-10-10: "they won't always pull the same chapter, look for other
// indicia"). On 2026-10-10 the only public reads of the day were VA M26-4 ch09 and its 2024
// superseded version, pulled by a scraper family that sends "Mozilla/5.0 (compatible;
// ziwei-ore/5.0)", "Ziwei-Seat/1.0" and a bare "Chrome/120.0" browser string from CN/HK. The
// signals below are about HOW a request looks, not what it reads, so they keep working when
// the target changes. Returns one reason from a fixed list, or null for a client we keep:
//   declared      the UA names itself a bot, probe, survey, audit or research tool, or carries
//                 the bot conventions "(+https://...)" or a contact email
//   fake-browser  a browser UA without the Sec-Fetch-Mode header every real browser sends on
//                 fetch(), or the "Mozilla/5.0 (compatible; X)" form crawlers use. A browser
//                 never talks MCP by itself, so a browser string from a script is a disguise
//   no-ua         no User-Agent at all (Claude, ChatGPT, Copilot and the MCP SDKs all send one)
//   listed        a scraper family seen in the logs whose UA has none of the tells above
// Known AI platforms (Claude, ChatGPT, Copilot, ...) are never flagged.
const DECLARED_RE =
  /\(\+|\+https?:\/\/|[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}|research|survey|audit|census|scoring|bench|trust|readiness|index|registry/i;
const LISTED_SCRAPERS_RE = /ziwei/i;
export function automatedReason(headers) {
  let ua;
  try { ua = headers?.get?.("user-agent"); } catch { ua = null; }
  if (typeof ua !== "string" || !ua.trim()) return "no-ua";
  if (KNOWN(uaPlatform(ua))) return null;
  if (LISTED_SCRAPERS_RE.test(ua)) return "listed";
  if (AUTOMATED_UA_RE.test(ua) || DECLARED_RE.test(ua)) return "declared";
  if (/mozilla/i.test(ua)) {
    if (/\(compatible;/i.test(ua)) return "fake-browser";
    let mode = null;
    try { mode = headers.get("sec-fetch-mode"); } catch { /* treat as absent */ }
    if (!mode) return "fake-browser";
  }
  return null;
}

// Automated traffic is moved out of the public counters the same way the owner's testing is:
// every name it would bump is written as "bot:<name>", so tool, doc, hour, platform and via
// counts describe real clients. The one exception is `req`, the daily budget counter
// (budget.js), which must count everything that costs a Worker invocation.
export function botRecorder(record, reqMetric) {
  return (name, n) => record(name === reqMetric ? name : `bot:${name}`, n);
}

// The owner's own testing (Earl, 2026-10-06): his connectors use the server URL with ?t=owner,
// and every counter that request would bump is written as "owner:<name>" instead, so public
// usage excludes him and his use stays countable on its own. A label on the URL, not an
// identity: nothing about the client is stored. Anyone could add it; it only moves their own
// traffic out of the public counts.
export function isOwner(url) {
  try {
    return new URL(url).searchParams.get("t") === "owner";
  } catch {
    return false;
  }
}

// The owner's tests through the PUBLIC ChatGPT app (2026-10-12). That app calls the bare
// server URL, so ?t=owner can't mark it. ChatGPT sends `_meta["openai/subject"]` on tool
// calls, documented by OpenAI as an "anonymized user id sent to MCP servers for the purposes
// of rate limiting and identification". It is hashed (SHA-256) in memory and compared with
// the owner's hash in the OWNER_OPENAI_SUBJECTS secret (comma-separated); nothing about any
// other user is kept. One-time setup: the owner asks ChatGPT to search for the secret
// OWNER_CLAIM_CODE; that call's hash is counted as "owner:claim:<hash>", the only place a
// hash is ever written, and only for the person who knows the code.
export async function ownerBySubject(request, env = {}) {
  const owners = String(env.OWNER_OPENAI_SUBJECTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const code = String(env.OWNER_CLAIM_CODE ?? "");
  const out = { owner: false, claim: null };
  if (!owners.length && code.length < 12) return out;
  for (const m of await rpcMessages(request)) {
    if (m.method !== "tools/call") continue;
    const subject = m.params?._meta?.["openai/subject"];
    if (typeof subject !== "string" || !subject) continue;
    const hash = await sha256Hex(subject);
    if (owners.includes(hash)) out.owner = true;
    if (code.length >= 12 && JSON.stringify(m.params?.arguments ?? {}).includes(code)) out.claim = hash;
  }
  return out;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// UTC hour "00".."23" for the hour:<HH>:tool counter.
export function hourOf(now = new Date()) {
  return String(now.getUTCHours()).padStart(2, "0");
}

// `req` stays unprefixed, as in botRecorder: it is the daily budget counter (budget.js reads
// only `req`), and before 2026-10-12 ?t=owner -- which anyone can add -- skipped the budget.
export function ownerRecorder(record) {
  return (name, n) => record(name === "req" ? name : `owner:${name}`, n);
}

// Which AI platform sent a request, from its User-Agent header. Connector back ends put a
// product token there: Anthropic's proxy "Claude-User" / "claude-code/<v>" / "anthropic",
// OpenAI's "openai-mcp/<v>", "ChatGPT-User", or an "OAI-" bot token. The raw header is NEVER
// stored (it can carry versions, OS and more): it is mapped onto the same fixed list as
// clientPlatform(), anything unrecognised (curl, python-requests, a browser) is "other" and
// a missing header is "unknown".
const UA_ONLY_PLATFORMS = [[/(^|[^a-z])oai-/i, "chatgpt"]];
export function uaPlatform(ua) {
  if (typeof ua !== "string" || !ua.trim()) return "unknown";
  for (const [re, platform] of UA_ONLY_PLATFORMS) if (re.test(ua.replace(OWN_DOMAINS_RE, ""))) return platform;
  return clientPlatform(ua);
}

const KNOWN = (p) => p !== "other" && p !== "unknown";

// What kind of program sent a request that is not a known AI platform, from its User-Agent,
// mapped onto a FIXED list (the raw header is never stored). Order matters: directory,
// monitor and crawler names are tested first, since their UAs often also name a language
// runtime or "Mozilla"; a browser is only what is left that says Mozilla.
const AGENT_KINDS = [
  [/mcplookup|mcphub|agentrank|smithery|glama|pulsemcp|mcp\.so|registry|census|observatory|catalog|directory|lookup|-sync/i, "directory"],
  [/probe|prober|liveness|uptime|monitor|watch|checker|sonda|stats|health/i, "monitor"],
  [/bot\b|crawl|spider|scan|harvest|collector|headless/i, "crawler"],
  [/python|httpx|aiohttp|urllib/i, "python"],
  [/\bnode\b|node-fetch|undici|axios/i, "node"],
  [/\bbun\b/i, "bun"],
  [/\bdeno\b/i, "deno"],
  [/curl\//i, "curl"],
  [/wget/i, "wget"],
  [/go-http-client/i, "go"],
  [/okhttp|java/i, "java"],
  [/mozilla/i, "browser"],
];
export function agentKind(ua) {
  if (typeof ua !== "string" || !ua.trim()) return "missing";
  for (const [re, kind] of AGENT_KINDS) if (re.test(ua)) return kind;
  return "other";
}

// The platform counter names for one request (batches included): one `client:<platform>`
// per `initialize` (clientInfo.name first, the User-Agent only as a fallback) and one
// `platform:<platform>:tool` per `tools/call` (User-Agent).
export async function rpcPlatformMetrics(request) {
  const msgs = await rpcMessages(request);
  if (!msgs.length) return [];
  let ua, rawUa;
  try { rawUa = request.headers.get("user-agent"); ua = uaPlatform(rawUa); } catch { ua = "unknown"; }
  const out = [];
  for (const m of msgs) {
    if (m.method === "initialize") {
      const c = clientPlatform(m.params?.clientInfo?.name);
      const p = KNOWN(c) || !KNOWN(ua) ? c : ua;
      out.push(`client:${p}`);
      if (!KNOWN(p)) out.push(`agent:${agentKind(rawUa)}`);
    } else if (m.method === "tools/call") {
      out.push(`platform:${ua}:tool`);
      if (!KNOWN(ua)) out.push(`agent:${agentKind(rawUa)}:tool`);
    }
  }
  return out;
}

function payloadOf(result) {
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return undefined;
  }
}

import { ALL_PLAYBOOK_IDS } from "./tools/playbooks.js";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import { enrichIncorporated } from "./incorporated.js";
import { withLibraryInfo } from "./library-info.js";

const VERIFY_OUTCOMES = new Set(["exact", "normalized", "composed", "not_found", "not_checked"]);

// The outcome a tool reported, read from the response it already returns (the response
// shapes are unchanged by instrumentation). Only a fixed vocabulary ever leaves here.
export function outcomeOf(tool, result) {
  const p = payloadOf(result);
  if (!p || typeof p !== "object") return "unknown";
  switch (tool) {
    case "search_regs":
      if (Array.isArray(p.results) && p.results.length) return "results";
      return p.reason === "empty_query" ? "empty_query" : "zero";
    case "verify_quote":
      if (VERIFY_OUTCOMES.has(p.outcome)) return p.outcome;
      return p.error === "not_found" ? "bad_register" : "unknown";
    case "lookup_citation":
      if (["ambiguous", "not_found", "unparsed"].includes(p.error)) return p.error;
      if (p.kind === "renumbered") return "renumbered"; // src/renumbered.js
      return p.register_id ? "resolved" : "unknown";
    case "get_reg":
    case "get_obligation":
      if (p.kind === "renumbered") return "renumbered";
      return p.error === "not_found" ? "not_found" : "ok";
    case "find_in_section":
      if (p.error === "not_found" || p.error === "empty_terms") return p.error;
      return p.total_matches > 0 ? "hits" : "none";
    case "list_playbooks":
      return Array.isArray(p.playbooks) ? "ok" : "unknown";
    case "get_playbook_reference":
      if (ALL_PLAYBOOK_IDS.includes(p.id) && typeof p.name === "string" && typeof p.content === "string" &&
          /^[A-Za-z0-9-]{1,64}$/.test(p.name)) return `${p.id}:${p.name}`;
    // falls through: errors and odd shapes are counted as before
    case "start_playbook":
    case "get_playbook_kit":
      if (p.error === "unknown_playbook") return "unknown_id";
      if (p.error === "unknown_reference" || p.error === "offset_out_of_range") return p.error;
      return ALL_PLAYBOOK_IDS.includes(p.id) ? p.id : "unknown";
    default:
      return "unknown";
  }
}

// The library document a successful result is about: OUR register_id, from the result (an
// error result can echo the caller's input, so any error yields null), checked against a
// fixed charset. get_obligation's later pages are not counted again.
const DOC_TOOLS = new Set(["get_reg", "get_obligation", "find_in_section", "lookup_citation"]);
const DOC_ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
export function docOf(tool, result) {
  if (!DOC_TOOLS.has(tool) || result?.isError) return null;
  const p = payloadOf(result);
  if (!p || typeof p !== "object" || p.error) return null;
  if (tool === "get_obligation" && p.chars_offset) return null;
  return typeof p.register_id === "string" && DOC_ID_RE.test(p.register_id) ? p.register_id : null;
}

// Display names for the directory listings (Claude and ChatGPT both read `title` and the
// annotations). A tool that sets its own title keeps it.
export const TOOL_TITLES = {
  search_regs: "Search regulations",
  lookup_citation: "Look up citation",
  get_reg: "Get regulation",
  get_obligation: "Get obligation",
  find_in_section: "Find in section",
  verify_quote: "Verify quote",
  list_playbooks: "List playbooks",
  start_playbook: "Start playbook",
  get_playbook_reference: "Get playbook reference",
  get_playbook_kit: "Get playbook kit",
};

// Every tool is a read of public text: read-only, non-destructive, idempotent, closed world.
export const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// Owner-approved wording (2026-09-26), exact. Added as `notice` to every tool's JSON result.
export const NOTICE =
  "For research purposes only. Information provided as-is; not legal advice. Verify against " +
  "the primary source. Terms: https://claudeforcompliance.com/terms/";

export function annotateConfig(name, config = {}) {
  const title = config.title ?? TOOL_TITLES[name] ?? name;
  const outputSchema = config.outputSchema ?? OUTPUT_SCHEMAS[name];
  return {
    ...config,
    title,
    annotations: { title, ...TOOL_ANNOTATIONS, ...(config.annotations ?? {}) },
    ...(outputSchema ? { outputSchema } : {}),
  };
}

// Adds `notice` to a JSON-object result (content[0].text), re-serialized in the tool's own
// compact form. Anything else (non-JSON text, arrays, odd shapes) is returned untouched.
export function withNotice(result) {
  try {
    const first = result?.content?.[0];
    if (!first || first.type !== "text" || typeof first.text !== "string") return result;
    const p = JSON.parse(first.text);
    if (!p || typeof p !== "object" || Array.isArray(p)) return result;
    const text = JSON.stringify({ ...p, notice: NOTICE });
    return { ...result, content: [{ ...first, text }, ...result.content.slice(1)] };
  } catch {
    return result;
  }
}

// Adds `structuredContent` (MCP 2025-06-18): the SAME object as the JSON in content[0].text,
// which is left exactly as it was (clients rely on it). A tool with an outputSchema
// (src/output-schemas.js) must carry structuredContent on every non-error result, so a
// result whose text is not a JSON object (none today) gets { text } rather than none.
// isError results are passed through untouched.
export function withStructuredContent(result) {
  if (!result || typeof result !== "object" || result.isError || result.structuredContent !== undefined) {
    return result;
  }
  const first = result.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") return result;
  let p;
  try { p = JSON.parse(first.text); } catch { p = undefined; }
  const structuredContent = p && typeof p === "object" && !Array.isArray(p) ? p : { text: first.text };
  return { ...result, structuredContent };
}

// Wraps server.registerTool (and registerPrompt, count only) so every tool handler is counted by outcome and, over budget,
// replaced by the refusal. Every tool config gets its title + annotations + outputSchema, and
// every JSON result (the refusal included) its `notice` and `structuredContent`. Call BEFORE the register*Tools functions run.
export function instrumentTools(server, { record = () => {}, refusal = null, env = null, library = null } = {}) {
  const safe = (name) => { try { record(name); } catch { /* fail open */ } };
  const register = server.registerTool.bind(server);
  const refused = refusal ? withStructuredContent(withNotice(refusal)) : null;
  server.registerTool = (name, config, handler) =>
    register(name, annotateConfig(name, config), async (...args) => {
      if (refused) {
        safe(`tool:${name}:refused`);
        return refused;
      }
      let result;
      try {
        result = await handler(...args);
      } catch (e) {
        safe(`tool:${name}:error`);
        throw e;
      }
      safe(`tool:${name}:${outcomeOf(name, result)}`);
      const doc = docOf(name, result);
      if (doc) safe(`doc:${doc}`);
      if (env) result = await enrichIncorporated(env, result); // src/incorporated.js
      return withLibraryInfo(withStructuredContent(withNotice(result)), library);
    });
  // Prompts serve static text, so they are counted but never refused.
  if (typeof server.registerPrompt !== "function") return server;
  const registerPrompt = server.registerPrompt.bind(server);
  server.registerPrompt = (name, config, cb) =>
    registerPrompt(name, config, (...args) => {
      safe(`prompt:${name}`);
      return cb(...args);
    });
  return server;
}
