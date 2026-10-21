// In-process tool runner for the /v1 REST router: drives the real MCP server through the public
// MCP client over a linked in-memory pair, so REST and /mcp share one tool implementation.
// One server/client pair per call; both are always closed.
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { createServer } from "./server.js";

export class InvalidArgumentsError extends Error {
  constructor(message) { super(message); this.name = "InvalidArgumentsError"; }
}
export class UnknownToolError extends Error {
  constructor(name) { super(`Unknown tool: ${name}`); this.name = "UnknownToolError"; }
}

async function withClient(env, opts, fn) {
  const server = createServer(env, opts);
  const [st, ct] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c4c-rest", version: "1.0.0" });
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

export function listToolsInProcess(env) {
  return withClient(env, {}, async (client) => (await client.listTools()).tools);
}

const text = (res) => (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const isInvalidText = (t) => t.startsWith("MCP error -32602") || t.startsWith("Input validation error");

export function callToolInProcess(env, name, args, opts = {}) {
  return withClient(env, { record: opts.record, refusal: opts.refusal, library: opts.library }, async (client) => {
    const { tools } = await client.listTools();
    if (!tools.some((t) => t.name === name)) throw new UnknownToolError(name);
    let res;
    try {
      res = await client.callTool({ name, arguments: args ?? {} });
    } catch (e) {
      if (e?.code === -32602) throw new InvalidArgumentsError(e.message);
      throw e;
    }
    const t = text(res);
    if (res.isError && isInvalidText(t)) throw new InvalidArgumentsError(t);
    return { result: res.structuredContent ?? { text: t }, isError: !!res.isError };
  });
}
