// Opt-in audit log (C4C_AUDIT_LOG=stdout|file): one JSON line per tool call, written only to the
// customer's own console (e.g. CloudWatch) or to <dataDir>/audit/audit-YYYY-MM-DD.jsonl. Never sent anywhere.
// Records what was asked (tool + arguments), what came back (citations), and from which library version.
import fs from "node:fs";
import path from "node:path";

export const AUDIT_MODES = ["off", "stdout", "file"];
const MAX_ARG_CHARS = 4000;
const MAX_CITATIONS = 50;
const MAX_HEADER_CHARS = 200;

export function parseAuditMode(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "1" || s === "true") return "stdout";
  return AUDIT_MODES.includes(s) ? s : "off";
}

export function clip(v, n = MAX_HEADER_CHARS) {
  if (v == null) return null;
  const s = String(Array.isArray(v) ? v[0] : v);
  return s.length > n ? s.slice(0, n) : s;
}

// Arguments are kept as given, unless their JSON is too long; then they are cut and flagged.
export function boundedArgs(args) {
  let s;
  try { s = JSON.stringify(args ?? {}); } catch { return { _unserializable: true }; }
  if (s.length <= MAX_ARG_CHARS) return args ?? {};
  return { _truncated: true, json: s.slice(0, MAX_ARG_CHARS) };
}

// tools/call messages in a JSON-RPC body (single message or batch): [{ id, name, arguments }]
export function toolCallsIn(body) {
  let msg;
  try { msg = JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : body); } catch { return []; }
  const list = Array.isArray(msg) ? msg : [msg];
  return list
    .filter((m) => m && m.method === "tools/call" && m.params && typeof m.params.name === "string")
    .map((m) => ({ id: m.id ?? null, name: m.params.name, arguments: m.params.arguments }));
}

// JSON-RPC responses in a response body, which is plain JSON or SSE ("data: {...}" lines).
export function responsesIn(text) {
  const out = [];
  const add = (v) => { for (const m of Array.isArray(v) ? v : [v]) if (m && typeof m === "object") out.push(m); };
  const t = (text ?? "").trim();
  if (!t) return out;
  try { add(JSON.parse(t)); return out; } catch { /* SSE */ }
  for (const line of t.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try { add(JSON.parse(line.slice(5).trim())); } catch { /* skip */ }
  }
  return out;
}

// What a tool result pointed to: the citations it gave (canonical_citation, or the parsed canonical form
// of a looked-up cite) and the exact sections (obligation_id, else register_id). Reads structured content,
// falling back to JSON in the text content.
export function returnedIn(result) {
  const citations = new Set();
  const sections = new Set();
  const add = (set, v) => { if (typeof v === "string" && v && set.size < MAX_CITATIONS) set.add(v.slice(0, 300)); };
  const walk = (v, depth) => {
    if (depth > 8 || v == null || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    add(citations, v.canonical_citation);
    if (v.parsed && typeof v.parsed === "object") add(citations, v.parsed.canonical);
    if (typeof v.obligation_id === "string") add(sections, v.obligation_id);
    else add(sections, v.register_id);
    for (const [k, x] of Object.entries(v)) if (k !== "parsed" && typeof x === "object") walk(x, depth + 1);
  };
  let body = result?.structuredContent;
  if (!body) {
    for (const part of result?.content ?? []) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      try { body = JSON.parse(part.text); break; } catch { /* not JSON */ }
    }
  }
  walk(body, 0);
  return { citations: [...citations], sections: [...sections] };
}

export function createAuditLogger({ mode, dataDir, now = () => new Date(), out = (line) => process.stdout.write(line + "\n") }) {
  if (mode !== "stdout" && mode !== "file") return null;
  let warned = false;

  function write(entry) {
    try {
      const line = JSON.stringify({ type: "c4c_audit", ts: now().toISOString(), ...entry });
      if (mode === "stdout") return out(line);
      const dir = path.join(dataDir, "audit");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `audit-${now().toISOString().slice(0, 10)}.jsonl`), line + "\n");
    } catch (err) {
      // An audit failure must never take the server down; say so once.
      if (!warned) { warned = true; console.warn(`audit log write failed: ${err.message}`); }
    }
  }

  return { write };
}
