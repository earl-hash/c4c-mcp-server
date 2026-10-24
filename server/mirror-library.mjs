// Mirror the C4C library feed into a folder, for customers whose servers must not reach C4C:
//   node server/mirror-library.mjs --out <dir> [--source <url>] [--keep <n>] [--public-key <pem>]
// Run it at the customer's gate (an IT jump host, an artifact-repository job, a managed file
// transfer step). It reads the license key from C4C_LICENSE_KEY, fetches the newest signed release,
// verifies the signature and the library checksum, and writes the same layout the feed serves:
//   <dir>/manifest.json, <dir>/manifest.sig, <dir>/<version>/corpus.sqlite.gz
// Serve <dir> over HTTPS inside the network (any static web server or artifact repository) and point
// each server's C4C_UPDATE_URL at it; the servers need no license key and verify the signature again.
// The manifest is written last, so a reader never sees a manifest for a file that is not there yet.
// Exit 0 = mirrored or already current, 1 = refused or failed, 2 = usage.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { verifyManifest, compareVersions } from "./manifest.js";
import { C4C_FEED } from "./config.js";

const BUNDLED_KEY = fileURLToPath(new URL("./library-public-key.pem", import.meta.url));
const USAGE = "usage: C4C_LICENSE_KEY=<key> node server/mirror-library.mjs --out <dir> [--source <url>] [--keep <n>] [--public-key <pem>]";
const MAX_MANIFEST = 64 * 1024, MAX_SIG = 1024, MAX_GZ = 2 * 1024 ** 3;

class MirrorError extends Error {}

async function get(fetchFn, url, key) {
  let res;
  try {
    res = await fetchFn(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, redirect: "error" });
  } catch (err) {
    throw new MirrorError(`network error fetching ${new URL(url).pathname}: ${err?.message ?? err}`);
  }
  if (res.status === 401 || res.status === 403) throw new MirrorError(`the feed refused the license key (HTTP ${res.status})`);
  if (!res.ok) throw new MirrorError(`the feed answered HTTP ${res.status} for ${new URL(url).pathname}`);
  return res;
}

async function small(fetchFn, url, key, max) {
  const b = Buffer.from(await (await get(fetchFn, url, key)).arrayBuffer());
  if (b.length > max) throw new MirrorError(`${new URL(url).pathname} is larger than ${max} bytes`);
  return b;
}

// Download the .gz to `dest` while hashing its decompressed bytes; returns that sha256.
async function downloadAndHash(fetchFn, url, key, dest) {
  const res = await get(fetchFn, url, key);
  if (!res.body) throw new MirrorError("empty download");
  const hash = createHash("sha256");
  let n = 0;
  const out = fs.createWriteStream(dest, { flags: "wx" });
  const gunzip = createGunzip();
  let gzError = null;
  gunzip.on("data", (c) => hash.update(c));
  gunzip.on("error", (e) => { gzError ??= new MirrorError(`not a valid gzip file: ${e.message}`); });
  const gunzipDone = new Promise((resolve) => { gunzip.once("end", resolve); gunzip.once("error", resolve); });
  const tee = new Writable({
    write(chunk, _enc, cb) {
      if (gzError) return cb(gzError);
      n += chunk.length;
      if (n > MAX_GZ) return cb(new MirrorError(`download exceeds ${MAX_GZ} bytes`));
      gunzip.write(chunk);
      out.write(chunk, cb);
    },
    final(cb) {
      gunzip.end();
      Promise.all([gunzipDone, new Promise((r) => out.end(r))]).then(() => cb(gzError));
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), tee);
  } finally {
    out.destroy();
  }
  if (gzError) throw gzError;
  return hash.digest("hex");
}

const writeAtomic = (file, bytes) => {
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
};

export async function runMirror(argv, { env = process.env, fetch: fetchFn = globalThis.fetch, out = console.log, err = console.error } = {}) {
  let dir = null, source = C4C_FEED, keep = 2, keyPath = BUNDLED_KEY;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (["--out", "--source", "--keep", "--public-key"].includes(a)) {
      if (!v) { err(`${a} needs a value\n${USAGE}`); return 2; }
      i++;
      if (a === "--out") dir = v;
      else if (a === "--source") source = v;
      else if (a === "--keep") keep = Number.parseInt(v, 10);
      else keyPath = v;
    } else { err(`unknown argument ${a}\n${USAGE}`); return 2; }
  }
  if (!dir || !Number.isInteger(keep) || keep < 1) { err(USAGE); return 2; }
  const key = env.C4C_LICENSE_KEY || null;
  let publicKey;
  try { publicKey = fs.readFileSync(keyPath); } catch { err(`No public key at ${keyPath}; cannot verify a library.`); return 1; }
  const base = source.replace(/\/+$/, "");
  const scrub = (s) => (key ? String(s).split(key).join("[redacted]") : String(s));

  try {
    const manifestBytes = await small(fetchFn, `${base}/manifest.json`, key, MAX_MANIFEST);
    const sigBytes = await small(fetchFn, `${base}/manifest.sig`, key, MAX_SIG);
    let manifest;
    try { manifest = verifyManifest(manifestBytes, sigBytes, publicKey); }
    catch (e) { throw new MirrorError(`refused: ${e.message}`); }

    fs.mkdirSync(dir, { recursive: true });
    const localPath = path.join(dir, "manifest.json");
    if (fs.existsSync(localPath) && fs.existsSync(path.join(dir, "manifest.sig"))) {
      try {
        const local = verifyManifest(fs.readFileSync(localPath), fs.readFileSync(path.join(dir, "manifest.sig")), publicKey);
        if (compareVersions(manifest.version, local.version) <= 0) {
          out(`Already current: ${local.version}.`);
          return 0;
        }
      } catch { /* an unreadable or unsigned local manifest is replaced */ }
    }

    const verDir = path.join(dir, manifest.version);
    if (path.dirname(path.resolve(verDir)) !== path.resolve(dir)) throw new MirrorError("manifest version is not a safe folder name");
    fs.mkdirSync(verDir, { recursive: true });
    const gz = path.join(verDir, "corpus.sqlite.gz");
    const part = `${gz}.part-${randomBytes(4).toString("hex")}`;
    try {
      const digest = await downloadAndHash(fetchFn, `${base}/${manifest.version}/corpus.sqlite.gz`, key, part);
      if (digest !== manifest.sha256) throw new MirrorError("library bytes do not match the signed manifest sha256");
      fs.renameSync(part, gz);
    } finally {
      fs.rmSync(part, { force: true });
    }
    writeAtomic(path.join(dir, "manifest.sig"), sigBytes);
    writeAtomic(localPath, manifestBytes);

    // Keep the newest `keep` versions so a server mid-download is never left without its file.
    const versions = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}\.\d+$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => compareVersions(b, a));
    for (const old of versions.slice(keep)) fs.rmSync(path.join(dir, old), { recursive: true, force: true });

    out(`Mirrored ${manifest.version} (${manifest.rows.registers} registers, ${manifest.rows.obligations} obligations) to ${dir}.`);
    return 0;
  } catch (e) {
    err(scrub(e instanceof MirrorError ? e.message : `mirror failed: ${e?.message ?? e}`));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runMirror(process.argv.slice(2));
}
