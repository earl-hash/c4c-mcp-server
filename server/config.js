// Environment configuration for the self-hosted C4C MCP server.
import { join } from "node:path";

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
    dataDir,
    corpusPath: join(dataDir, "corpus.sqlite"),
    manifestPath: join(dataDir, "manifest.json"),
    licenseKey: env.C4C_LICENSE_KEY || null,
    updateUrl,
    mirror: isMirror(updateUrl),
    staleDays: int(env.C4C_STALE_DAYS, 14),
    authToken: env.C4C_AUTH_TOKEN?.trim() || null,
    usageReport: env.C4C_USAGE_REPORT === "1" || env.C4C_USAGE_REPORT === "true",
    // Decision Workspace tools and playbook (record_rules, propose_file_note, tag_record).
    workspace: env.C4C_WORKSPACE === "1",
    updateIntervalH: int(env.C4C_UPDATE_INTERVAL_H, 24),
    // Overall ceiling for one library download (the body also aborts after 60 s with no bytes).
    downloadTimeoutMin: int(env.C4C_DOWNLOAD_TIMEOUT_MIN, 30) || 30,
  };
}
