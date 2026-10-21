// The MCP server itself: identity, instructions and every tool and prompt. Shared by the
// Cloudflare Worker (index.js) and the self-hosted Node server (server/node-server.js).
// Imports nothing hosted-only (no OAuth, API keys, AWS, library feed, budget or sign-up), so
// the self-hosted image carries only what it runs.

import { McpServer } from "@modelcontextprotocol/server";
import { instrumentTools } from "./metrics.js";
import { registerGetTools } from "./tools/get.js";
import { registerSearchTools } from "./tools/search.js";
import { registerVerifyTools } from "./tools/verify.js";
import { registerFindTools } from "./tools/find.js";
import { registerTextPrompts } from "./prompts.js";
import { registerPlaybookPrompts, registerPlaybookTools } from "./tools/playbooks.js";
import { registerWorkspaceTools } from "./workspace/index.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";

// opts: { record, refusal } -- see metrics.js instrumentTools. Both default to off, so
// createServer(env) alone is the plain, uninstrumented server.
export function createServer(env, opts = {}) {
  const server = instrumentTools(
    new McpServer(
      // The MCP Registry listing's identity (server.json title). `name` stays a slug for
      // clients that show it raw; `title` is the display name.
      {
        name: "c4c-mortgage-regs",
        title: "C4C: Mortgage Industry Regulations",
        version: "1.0.0",
        websiteUrl: "https://claudeforcompliance.com/mcp/",
      },
      { instructions: SERVER_INSTRUCTIONS },
    ),
    { ...opts, env },
  );
  registerGetTools(server, env);
  registerSearchTools(server, env);
  registerFindTools(server, env);
  registerVerifyTools(server, env);
  registerPlaybookTools(server, env);
  registerWorkspaceTools(server, env);
  registerPlaybookPrompts(server, env);
  registerTextPrompts(server);
  return server;
}
