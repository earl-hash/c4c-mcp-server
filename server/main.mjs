// Entry point: config -> corpus (if a library is installed) -> HTTP server -> updater (when licensed).
// The current library is what <dataDir>/manifest.json names (falling back to manifest.prev.json when
// manifest.json is torn or fails verification; see server/library.js for the layout). A hand-placed
// <dataDir>/corpus.sqlite is served when no versioned library exists.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readConfig } from "./config.js";
import { openCorpus } from "./d1-sqlite.js";
import { createNodeServer } from "./node-server.js";
import { createUsageRecorder } from "./usage-report.js";
import { readCurrent, startUpdater, openServingCorpus, updatesEnabled } from "./library.js";

const PUBLIC_KEY_PATH = fileURLToPath(new URL("./library-public-key.pem", import.meta.url));

const config = readConfig();
const publicKey = existsSync(PUBLIC_KEY_PATH) ? readFileSync(PUBLIC_KEY_PATH) : null;
const initial = readCurrent(config.dataDir, { publicKey });
if (initial.source === "prev") {
  console.warn(`manifest.json in ${config.dataDir} is missing or fails verification; serving the previous library ${initial.manifest.version}.`);
}
// A corrupt file logs one line and the server runs in no-library mode instead of crashing.
let corpus = initial.path ? await openServingCorpus(initial.path) : null;
// The manifest of the library actually being served (updated together with each swap).
let library = corpus ? initial.manifest : null;
if (!corpus && !initial.path) console.warn(`No library in ${config.dataDir}; serving in no-library mode.`);

const usage = config.usageReport ? createUsageRecorder({ dataDir: config.dataDir }) : null;
if (usage) setInterval(() => usage.flush(), 3600_000).unref();

const server = createNodeServer({ config, getCorpus: () => corpus, getLibrary: () => library, record: usage?.record });
server.listen(config.port, () => console.log(`C4C MCP listening on :${config.port}`));
if (config.auditLog !== "off") console.log(`audit log on: ${config.auditLog === "file" ? `${config.dataDir}/audit` : "stdout"}`);

let stopUpdater = () => {};
if (updatesEnabled(config)) {
  stopUpdater = startUpdater({
    config,
    publicKey,
    corpus: () => corpus,
    // swapped: the serving handle already points at the new file; otherwise this is the first library.
    onInstalled: (manifest, { path, swapped }) => {
      if (!swapped) corpus = openCorpus(path);
      library = manifest;
    },
  });
}

const shutdown = () => { stopUpdater(); usage?.flush(); server.close(); corpus?.close(); process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
