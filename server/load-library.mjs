// Offline library load, for sites that cannot reach the update server:
//   node server/load-library.mjs <corpus.sqlite.gz> <manifest.json> <manifest.sig> [--allow-downgrade] [--data-dir <dir>]
// Verifies the signed manifest with the bundled public key (server/library-public-key.pem) and installs
// into the data directory exactly like an online update. Exit 0 = installed, 1 = refused or failed, 2 = usage.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { installLibrary, InstallError } from "./library.js";

const BUNDLED_KEY = fileURLToPath(new URL("./library-public-key.pem", import.meta.url));
const USAGE = "usage: node server/load-library.mjs <corpus.sqlite.gz> <manifest.json> <manifest.sig> [--allow-downgrade] [--data-dir <dir>] [--public-key <pem>]";

export async function runLoad(argv, { out = console.log, err = console.error, env = process.env } = {}) {
  const files = [];
  let allowDowngrade = false, dataDir = env.C4C_DATA_DIR || "/data", keyPath = BUNDLED_KEY;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--allow-downgrade") allowDowngrade = true;
    else if (a === "--data-dir" || a === "--public-key") {
      const v = argv[++i];
      if (!v) { err(`${a} needs a value\n${USAGE}`); return 2; }
      if (a === "--data-dir") dataDir = v; else keyPath = v;
    } else if (a.startsWith("--")) { err(`unknown option ${a}\n${USAGE}`); return 2; }
    else files.push(a);
  }
  if (files.length !== 3) { err(USAGE); return 2; }
  const [gzPath, manifestPath, sigPath] = files;

  let publicKey, manifestBytes, sigBytes;
  try { publicKey = fs.readFileSync(keyPath); }
  catch { err(`No public key at ${keyPath}; this image cannot verify a library, so it cannot install one.`); return 1; }
  for (const f of [gzPath, manifestPath, sigPath]) {
    if (!fs.existsSync(f)) { err(`File not found: ${f}`); return 1; }
  }
  manifestBytes = fs.readFileSync(manifestPath);
  sigBytes = fs.readFileSync(sigPath);

  try {
    const r = await installLibrary({ gzPath, manifestBytes, sigBytes, publicKey, dataDir, allowDowngrade, log: err });
    out(`Installed library ${r.manifest.version} into ${dataDir}. Restart the C4C container to serve ${r.manifest.version} now; a licensed running server also picks it up on its next update check.`);
    return 0;
  } catch (e) {
    if (e instanceof InstallError) {
      err(e.reason === "busy"
        ? `busy: another library install or update is in progress; try again in a few minutes. (${e.message})`
        : `Refused (${e.reason}): ${e.message}`);
    } else err(`Failed: ${e?.message ?? e}`);
    return 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await runLoad(process.argv.slice(2));
}
