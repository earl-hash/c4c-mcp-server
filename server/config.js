// Environment configuration for the self-hosted C4C MCP server.
import { join } from "node:path";

const int = (v, d) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export function readConfig(env = process.env) {
  const dataDir = env.C4C_DATA_DIR || "/data";
  return {
    port: int(env.PORT, 8080),
    dataDir,
    corpusPath: join(dataDir, "corpus.sqlite"),
    manifestPath: join(dataDir, "manifest.json"),
    licenseKey: env.C4C_LICENSE_KEY || null,
    updateUrl: env.C4C_UPDATE_URL || "https://mcp.claudeforcompliance.com/library",
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
