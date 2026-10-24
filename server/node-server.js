// Node HTTP entry for the self-hosted edition: /mcp (stateless streamable HTTP), /healthz,
// optional bearer auth, and a safe no-library mode. Wraps the unchanged createServer();
// deliberately NOT the Cloudflare default export (no budget, metrics, .well-known, OpenAI routes).
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createServer } from "../src/server.js";
import { listToolsInProcess } from "../src/inprocess.js";
import { libraryInfo } from "../src/library-info.js";

export const NO_LIBRARY_MESSAGE =
  "The regulation library is not installed yet. Set C4C_LICENSE_KEY or a mirror C4C_UPDATE_URL so the server can fetch it, or load a library file, then retry.";


let stubToolsPromise;
function stubTools() {
  stubToolsPromise ??= listToolsInProcess({ CORPUS: null });
  return stubToolsPromise;
}

async function createNoLibraryServer() {
  const server = new McpServer({ name: "c4c-mortgage-regs", version: "1.0.0" });
  for (const t of await stubTools()) {
    server.registerTool(
      t.name,
      { description: t.description ?? t.name, inputSchema: z.object({}).passthrough() },
      async () => ({ content: [{ type: "text", text: NO_LIBRARY_MESSAGE }], isError: true }),
    );
  }
  return server;
}

function bearerOk(header, token) {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export const MAX_BODY_BYTES = 4 * 1024 * 1024;

class BodyTooLarge extends Error {}
class BadHost extends Error {}

async function readBody(req) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new BodyTooLarge();
  // Manual reads: breaking out of `for await` would destroy the socket before the 413 is sent.
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const onData = (c) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        req.off("data", onData);
        req.on("data", () => {}); // discard the rest; never buffered
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(c);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("request aborted")));
  });
}

async function toWebRequest(req) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x)); else if (v != null) headers.set(k, v);
  }
  const init = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") init.body = await readBody(req);
  const host = (req.headers.host ?? "").trim();
  let url;
  try { url = new URL(req.url, `http://${host}`); if (!host) throw new Error("empty"); } catch { throw new BadHost(); }
  return new Request(url, init);
}

async function sendWebResponse(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  const reader = response.body.getReader();
  res.on("close", () => { reader.cancel().catch(() => {}); });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    res.end();
  }
}

// C4C_WORKSPACE=1: the env createServer sees turns on the Decision Workspace tools
// (WORKSPACE_TOOLS) and serves the hidden decision-workspace playbook (PLAYBOOKS_PREVIEW).
export function workspaceEnv(config, env) {
  if (!config.workspace) return env;
  const preview = [env.PLAYBOOKS_PREVIEW, "decision-workspace"].filter(Boolean).join(",");
  return { ...env, WORKSPACE_TOOLS: "1", PLAYBOOKS_PREVIEW: preview };
}

export function createNodeServer({ config, getCorpus, getLibrary, record }) {
  const ctx = { waitUntil() {}, passThroughOnException() {} };

  async function handleMcp(req, res) {
    const corpus = getCorpus();
    const lib = getLibrary();
    const factory = corpus
      ? () => createServer(workspaceEnv(config, corpus.env), { ...(record ? { record } : {}), library: lib ? libraryInfo(lib, new Date(), config.staleDays) : null })
      : () => createNoLibraryServer();
    const webReq = await toWebRequest(req);
    const response = await createMcpHandler(factory)(webReq, corpus?.env ?? {}, ctx);
    await sendWebResponse(res, response);
  }

  return http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://x").pathname;
      if (!(req.headers.host ?? "").trim() && path === "/mcp") throw new BadHost();
      if (path === "/healthz") {
        const lib = getCorpus() ? getLibrary() : null;
        if (!lib) return json(res, 503, { ok: false, reason: "no_library" });
        {
          const i = libraryInfo(lib, new Date(), config.staleDays);
          return json(res, 200, { ok: true, library_version: i.version, age_days: i.age_days, stale: i.stale });
        }
      }
      if (path === "/mcp") {
        if (config.authToken && !bearerOk(req.headers.authorization, config.authToken)) {
          res.setHeader("www-authenticate", "Bearer");
          return json(res, 401, { error: "unauthorized" });
        }
        return await handleMcp(req, res);
      }
      return json(res, 404, { error: "not_found" });
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        // Let the 413 flush (an immediate destroy resets the connection before the client reads it),
        // then drop whatever the client is still sending.
        res.on("finish", () => { setTimeout(() => req.destroy(), 1000).unref(); });
        json(res, 413, { error: { code: "payload_too_large", message: `Request body must be at most ${MAX_BODY_BYTES} bytes.` } });
        return;
      }
      if (e instanceof BadHost) {
        console.error("rejected request: malformed or empty Host header");
        if (!res.headersSent) json(res, 400, { error: "bad_request" });
        return;
      }
      console.error("request failed:", e);
      if (!res.headersSent) json(res, 500, { error: "internal_error" }); else res.end();
    }
  });
}
