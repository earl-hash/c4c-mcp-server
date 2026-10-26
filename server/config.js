// Environment configuration for the self-hosted C4C MCP server.
import { join } from "node:path";
import { parseAuditMode } from "./audit-log.js";

const int = (v, d) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export const C4C_FEED = "https://mcp.claudeforcompliance.com/library";

// True when `url` is a source other than the C4C feed: the customer's own mirror, artifact
// repository or file share behind their gates. A mirror needs no license key; the license key
// lives at the gate that fetches from C4C (server/mirror-library.mjs), not on the server.
export function isMirror(url) {
  try { return new URL(url).hostname !== new URL(C4C_FEED).hostname; } catch { return false; }
}

export function readConfig(env = process.env) {
  const dataDir = env.C4C_DATA_DIR || "/data";
  const updateUrl = env.C4C_UPDATE_URL || C4C_FEED;
  return {
    port: int(env.PORT, 8080),
    // All IPv4 interfaces by default (Amazon Bedrock AgentCore Runtime requires 0.0.0.0).
    host: env.HOST?.trim() || "0.0.0.0",
    dataDir,
    corpusPath: join(dataDir, "corpus.sqlite"),
    manifestPath: join(dataDir, "manifest.json"),
    licenseKey: env.C4C_LICENSE_KEY || null,
    updateUrl,
    mirror: isMirror(updateUrl),
    staleDays: int(env.C4C_STALE_DAYS, 14),
    authToken: env.C4C_AUTH_TOKEN?.trim() || null,
    // Read-only library built into the image (AgentCore edition): served when nothing newer is in dataDir.
    bundledDir: env.C4C_BUNDLED_LIBRARY_DIR?.trim() || null,
    usageReport: env.C4C_USAGE_REPORT === "1" || env.C4C_USAGE_REPORT === "true",
    // Audit log of tool calls to the customer's console or /data/audit (off, stdout, file).
    auditLog: parseAuditMode(env.C4C_AUDIT_LOG),
    // Request header carrying the user's identity, set by the customer's gateway (e.g. x-user-email).
    auditUserHeader: env.C4C_AUDIT_USER_HEADER?.trim().toLowerCase() || null,
    // Decision Workspace tools and playbook (record_rules, propose_file_note, tag_record).
    workspace: env.C4C_WORKSPACE === "1",
    updateIntervalH: int(env.C4C_UPDATE_INTERVAL_H, 24),
    // Overall ceiling for one library download (the body also aborts after 60 s with no bytes).
    downloadTimeoutMin: int(env.C4C_DOWNLOAD_TIMEOUT_MIN, 30) || 30,
  };
}
