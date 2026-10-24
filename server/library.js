// Library verifier, installer and background updater for the self-hosted edition.
//
// On-disk layout (<dataDir>):
//   corpus-<version>.sqlite   one file per installed version; never renamed or overwritten while served
//   manifest.json             the exact signed manifest bytes of the CURRENT library (the commit point)
//   manifest.sig              its Ed25519 signature
//   manifest.prev.json/.sig   the previous library's signed manifest; its corpus-<version>.sqlite is
//                             kept as the rollback copy, and startup falls back to it when
//                             manifest.json is missing, torn or fails verification
//   corpus.sqlite             legacy/hand-placed file: served only when no verified versioned library exists
//   install.lock              exclusive lock held for the whole install (a lock older than 2 h is broken)
//
// Why versioned names instead of renaming corpus.sqlite -> corpus.prev.sqlite: on Windows a file
// that SQLite holds open cannot be renamed, deleted or replaced (EBUSY / EPERM; SQLite opens without
// FILE_SHARE_DELETE), and openCorpus().swap keeps the old handle open for a 60 s grace period so
// in-flight requests finish. So an install never touches the file being served:
//   0. verify the signature over the exact manifest bytes (installLibrary ALWAYS verifies; there is
//      no trusted pre-parsed form), take install.lock, re-read the current library under the lock;
//   1. stream-gunzip into a uniquely named corpus.next-<pid>-<rand>.sqlite, hashing as it goes (capped);
//   2. sha256 must equal manifest.sha256; open read-only, PRAGMA integrity_check = ok,
//      row counts = manifest.rows; fsync the file;
//   3. rename it -> corpus-<version>.sqlite (a name nothing has open);
//   4. synchronously, with every temp file fsynced before its rename:
//      old manifest/sig -> manifest.prev.json/.sig, new sig -> manifest.sig,
//      new manifest -> manifest.json (THE COMMIT POINT; manifest.json is never held open, so the
//      rename works on Windows); then fsync the directory (POSIX only).
//      A crash between these renames leaves manifest.json failing verification, so startup falls
//      back to manifest.prev.json, which names the old library: a valid library is always served;
//   5. best-effort delete of library files that are neither the new nor the previous library
//      (a file still open in its grace period just stays until the next install).
// The caller then swaps the serving handle to the new path. The same steps work unchanged on Linux.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { verifyManifest, compareVersions } from "./manifest.js";
import { openCorpus } from "./d1-sqlite.js";

export const MAX_GZ_BYTES = 1024 ** 3;        // 1 GiB download cap
export const MAX_DB_BYTES = 2 * 1024 ** 3;    // 2 GiB decompressed cap (the manifest has no size field)
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_SIG_BYTES = 1024;
export const FETCH_TIMEOUT_MS = 60_000;       // manifest, signature, and .gz response headers
export const IDLE_TIMEOUT_MS = 60_000;        // .gz body: abort when no bytes arrive for this long
export const STALE_LOCK_MS = 2 * 3600_000;

const VERSION_RE = /^\d{4}-\d{2}-\d{2}\.\d+$/;
const LEGACY = "corpus.sqlite";
const LOCK = "install.lock";
const LIBRARY_FILE_RE = /^corpus(-\d{4}-\d{2}-\d{2}\.\d+)?\.sqlite$/;
const NEXT_RE = /^corpus\.next-.+\.sqlite$/;
const TMP_RE = /^manifest\..+\.tmp$/;
const PART_RE = /^download-.+\.gz\.part$/;
const DISK_CODES = new Set(["ENOSPC", "EACCES", "EPERM", "EBUSY", "EROFS", "EDQUOT", "EIO", "EMFILE", "ENOENT", "EEXIST", "EISDIR", "ENOTDIR"]);

export class InstallError extends Error {
  constructor(reason, message = reason) { super(message); this.name = "InstallError"; this.reason = reason; }
}

export const corpusFileName = (version) => `corpus-${version}.sqlite`;
const unique = () => `${process.pid}-${randomBytes(6).toString("hex")}`;
const rmQuiet = (p) => { try { fs.rmSync(p, { force: true }); } catch { /* best effort */ } };
const readQuiet = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
const asDiskError = (err) => (err instanceof InstallError ? err : new InstallError("disk", `disk error: ${err.code || err.message}`));

// Parse (and, given a public key, verify) a manifest file; null when absent, torn or invalid.
function loadManifest(dataDir, name, sigName, publicKey) {
  const bytes = readQuiet(path.join(dataDir, name));
  if (!bytes || !bytes.length) return null;
  const sigBytes = readQuiet(path.join(dataDir, sigName));
  let manifest;
  if (publicKey) {
    try { manifest = verifyManifest(bytes, sigBytes ?? Buffer.alloc(0), publicKey); } catch { return null; }
  } else {
    try { manifest = JSON.parse(bytes.toString("utf8")); } catch { return null; }
    if (!manifest || typeof manifest.version !== "string" || !VERSION_RE.test(manifest.version)) return null;
  }
  const p = path.join(dataDir, corpusFileName(manifest.version));
  return fs.existsSync(p) ? { path: p, manifest, manifestBytes: bytes, sigBytes } : null;
}

// The library currently on disk: { path, manifest, manifestBytes, sigBytes, source }.
// source: "current" | "prev" (manifest.json unusable, fell back to the rollback copy) | "legacy" | null.
// With a public key, manifests must verify; without one they are only parsed.
export function readCurrent(dataDir, { publicKey = null } = {}) {
  const cur = loadManifest(dataDir, "manifest.json", "manifest.sig", publicKey);
  if (cur) return { ...cur, source: "current" };
  const prev = loadManifest(dataDir, "manifest.prev.json", "manifest.prev.sig", publicKey);
  if (prev) return { ...prev, source: "prev" };
  const legacy = path.join(dataDir, LEGACY);
  if (fs.existsSync(legacy)) return { path: legacy, manifest: null, manifestBytes: null, sigBytes: null, source: "legacy" };
  return { path: null, manifest: null, manifestBytes: null, sigBytes: null, source: null };
}

// Open the library for serving and probe it, so a corrupt hand-placed file means no-library mode, not a crash.
export async function openServingCorpus(p, { log = (m) => console.error(m), open = openCorpus } = {}) {
  let c = null;
  try {
    c = open(p);
    await c.env.CORPUS.prepare("SELECT COUNT(*) AS n FROM sqlite_master").first();
    return c;
  } catch (err) {
    try { c?.close(); } catch { /* ignore */ }
    log(`Library file ${p} cannot be opened (${err?.message ?? err}); serving in no-library mode.`);
    return null;
  }
}

function fsyncFile(p) {
  const fd = fs.openSync(p, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Directory fsync makes renames durable on POSIX; Windows cannot open a directory for it, so skip.
function fsyncDir(dir) {
  if (process.platform === "win32") return;
  let fd;
  try { fd = fs.openSync(dir, "r"); fs.fsyncSync(fd); } catch { /* unsupported here; not fatal */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

// Write a uniquely named temp file next to dest, fsynced; returns its path.
function writeTemp(dest, bytes) {
  const tmp = `${dest}.${unique()}.tmp`;
  const fd = fs.openSync(tmp, "wx");
  try { fs.writeSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return tmp;
}

function acquireLock(dataDir, log) {
  const lockPath = path.join(dataDir, LOCK);
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try { fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`); } catch { /* content is informational */ }
      return () => { try { fs.closeSync(fd); } catch { /* ignore */ } rmQuiet(lockPath); };
    } catch (err) {
      if (err.code !== "EEXIST") throw asDiskError(err);
      let age = 0;
      try { age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { continue; } // vanished: retry
      if (age > STALE_LOCK_MS && tries === 0) {
        log(`Breaking a stale install lock (${Math.round(age / 60000)} min old) at ${lockPath}.`);
        rmQuiet(lockPath);
        continue;
      }
      throw new InstallError("busy", "another library install is in progress");
    }
  }
  throw new InstallError("busy", "another library install is in progress");
}

// Remove leftovers of a crashed install. Runs under the lock; download parts only when stale
// (a concurrent download is not under the lock).
function sweep(dataDir) {
  try {
    for (const f of fs.readdirSync(dataDir)) {
      const p = path.join(dataDir, f);
      if (NEXT_RE.test(f) || TMP_RE.test(f)) rmQuiet(p);
      else if (PART_RE.test(f)) {
        try { if (Date.now() - fs.statSync(p).mtimeMs > STALE_LOCK_MS) rmQuiet(p); } catch { /* ignore */ }
      }
    }
  } catch { /* best effort */ }
}

// Gunzip source -> dest, hashing the uncompressed bytes; caps output at maxBytes.
async function gunzipTo(source, dest, maxBytes) {
  const hash = createHash("sha256");
  let total = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      if (total > maxBytes) return cb(new InstallError("too_large", `library exceeds ${maxBytes} bytes uncompressed`));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(source, createGunzip(), meter, fs.createWriteStream(dest, { flags: "wx", flush: true }));
  } catch (err) {
    if (err instanceof InstallError) throw err;
    if (typeof err.code === "string" && err.code.startsWith("Z_")) throw new InstallError("corrupt", `library download is not a valid gzip: ${err.message}`);
    if (err.code === "ERR_STREAM_PREMATURE_CLOSE") throw new InstallError("corrupt", "library download ended early");
    throw asDiskError(err);
  }
  return hash.digest("hex");
}

function validate(dbPath, manifest) {
  let db;
  try {
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const r = db.prepare("PRAGMA integrity_check").all();
      if (r.length !== 1 || r[0].integrity_check !== "ok") throw new Error("integrity_check failed");
    } catch (err) { throw new InstallError("integrity", `library failed integrity check: ${err.message}`); }
    const want = manifest.rows;
    if (!(want.registers > 0 && want.obligations > 0)) throw new InstallError("row_counts", "manifest declares an empty library");
    for (const t of ["registers", "obligations", "snapshots"]) {
      let n;
      try { n = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; }
      catch (err) { throw new InstallError("integrity", `library is missing table ${t}: ${err.message}`); }
      if (n !== want[t]) throw new InstallError("row_counts", `${t}: ${n} rows, manifest says ${want[t]}`);
    }
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

// Install a library package. Always verifies manifestBytes against sigBytes with publicKey and uses
// only the manifest parsed from those verified bytes. Supply `gzBytes` (Buffer) or `gzPath` (file).
export async function installLibrary({
  gzBytes, gzPath, manifestBytes, sigBytes, publicKey, dataDir,
  allowDowngrade = false, maxDbBytes = MAX_DB_BYTES, log = (m) => console.warn(m),
}) {
  if (!publicKey) throw new InstallError("bad_signature", "no public key: refusing to install an unverified library");
  if (!manifestBytes || !sigBytes) throw new InstallError("bad_signature", "manifest and signature are both required");
  let manifest;
  try { manifest = verifyManifest(manifestBytes, sigBytes, publicKey); } // also validates the version format
  catch (err) { throw new InstallError("bad_signature", err.message); }
  manifestBytes = Buffer.from(manifestBytes);
  sigBytes = Buffer.from(sigBytes);

  const dir = path.resolve(dataDir);
  const finalPath = path.join(dir, corpusFileName(manifest.version));
  if (path.dirname(finalPath) !== dir) throw new InstallError("bad_signature", "manifest version is not a safe file name");

  try { fs.mkdirSync(dir, { recursive: true }); } catch (err) { throw asDiskError(err); }
  const release = acquireLock(dir, log);
  const nextPath = path.join(dir, `corpus.next-${unique()}.sqlite`);
  const temps = [];
  let placed = false, committed = false;
  try {
    // Re-read under the lock: another process may have installed since the caller looked.
    const current = readCurrent(dir, { publicKey });
    if (current.path && current.manifest) {
      const cmp = compareVersions(manifest.version, current.manifest.version);
      if (cmp === 0) throw new InstallError("not_newer", `version ${manifest.version} is already installed`);
      if (cmp < 0 && !allowDowngrade) throw new InstallError("downgrade", `version ${manifest.version} is older than installed ${current.manifest.version}`);
    }
    if (current.path && path.resolve(current.path) === finalPath) throw new InstallError("not_newer", "that file is being served");
    sweep(dir);

    try {
      const source = gzPath ? fs.createReadStream(gzPath) : Readable.from([gzBytes]);
      const digest = await gunzipTo(source, nextPath, maxDbBytes);
      if (digest !== manifest.sha256) throw new InstallError("sha_mismatch", "library bytes do not match the signed manifest sha256");
      validate(nextPath, manifest);
      try { fsyncFile(nextPath); fs.renameSync(nextPath, finalPath); placed = true; } catch (err) { throw asDiskError(err); }

      // Commit, fully synchronous so no request interleaves; each temp is fsynced before its rename.
      const at = (n) => path.join(dir, n);
      try {
        const prevJson = current.manifestBytes ? writeTemp(at("manifest.prev.json"), current.manifestBytes) : null;
        const prevSig = current.manifestBytes && current.sigBytes ? writeTemp(at("manifest.prev.sig"), current.sigBytes) : null;
        const newSig = writeTemp(at("manifest.sig"), sigBytes);
        const newJson = writeTemp(at("manifest.json"), manifestBytes);
        temps.push(prevJson, prevSig, newSig, newJson);
        if (prevJson) {
          fs.renameSync(prevJson, at("manifest.prev.json"));
          if (prevSig) fs.renameSync(prevSig, at("manifest.prev.sig")); else rmQuiet(at("manifest.prev.sig"));
        }
        fs.renameSync(newSig, at("manifest.sig"));
        fs.renameSync(newJson, at("manifest.json")); // commit point
        committed = true;
        fsyncDir(dir);
      } catch (err) { throw asDiskError(err); }
    } catch (err) {
      if (placed && !committed) rmQuiet(finalPath);
      throw err;
    }

    // Keep the new library and the previous one (rollback copy); drop older library files.
    const keep = new Set([finalPath, current.path ? path.resolve(current.path) : null]);
    try {
      for (const f of fs.readdirSync(dir)) {
        if (LIBRARY_FILE_RE.test(f) && !keep.has(path.join(dir, f))) rmQuiet(path.join(dir, f));
      }
    } catch { /* best effort */ }
    return { path: finalPath, manifest };
  } finally {
    rmQuiet(nextPath);
    for (const t of temps) if (t) rmQuiet(t);
    release();
  }
}

// http(s) URL check: https anywhere, plain http only to this machine.
export function updateUrlOk(u) {
  let url;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

// Updates run with a license key (from the C4C feed or a mirror) or from a mirror alone.
export const updatesEnabled = (config) => Boolean(config.licenseKey || config.mirror);

async function feedGet(fetchFn, url, licenseKey, signal) {
  let res;
  const headers = licenseKey ? { authorization: `Bearer ${licenseKey}` } : {};
  try {
    res = await fetchFn(url, { headers, redirect: "error", signal });
  } catch (err) {
    throw new InstallError("network", `network error: ${err?.message ?? err}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new InstallError("license", licenseKey
      ? `the update feed refused the license key (HTTP ${res.status})`
      : `the update source refused the request (HTTP ${res.status})`);
  }
  if (!res.ok) throw new InstallError("feed", `the update feed answered HTTP ${res.status} for ${new URL(url).pathname}`);
  return res;
}

// Read a small body with a hard cap.
async function readCapped(res, max, what) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new InstallError("too_large", `${what} exceeds ${max} bytes`);
  if (!res.body) return Buffer.alloc(0);
  const chunks = []; let total = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) { reader.cancel().catch(() => {}); throw new InstallError("too_large", `${what} exceeds ${max} bytes`); }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    if (err instanceof InstallError) throw err;
    throw new InstallError("network", `network error: ${err?.message ?? err}`);
  }
  return Buffer.concat(chunks);
}

// Fetch the .gz: 60 s to response headers, then an idle timeout per chunk plus an overall ceiling.
async function download(fetchFn, url, licenseKey, dest, { maxBytes, headerMs, idleMs, totalMs }) {
  const ctl = new AbortController();
  let why = null;
  const abort = (msg) => { if (!why) { why = msg; ctl.abort(new Error(msg)); } };
  const timer = (ms, msg) => { const t = setTimeout(() => abort(msg), ms); t.unref?.(); return t; };
  const total = timer(totalMs, `download exceeded ${Math.round(totalMs / 60000)} min`);
  let idle = timer(headerMs, `no response within ${Math.round(headerMs / 1000)} s`);
  try {
    const res = await feedGet(fetchFn, url, licenseKey, ctl.signal).catch((err) => {
      if (why) throw new InstallError("network", why);
      throw err;
    });
    clearTimeout(idle);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new InstallError("too_large", `download exceeds ${maxBytes} bytes`);
    if (!res.body) throw new InstallError("network", "empty download");
    const idleMsg = `no data for ${Math.round(idleMs / 1000)} s`;
    idle = timer(idleMs, idleMsg);
    let n = 0;
    const cap = new Transform({
      transform(chunk, _enc, cb) {
        clearTimeout(idle); idle = timer(idleMs, idleMsg);
        n += chunk.length;
        if (n > maxBytes) return cb(new InstallError("too_large", `download exceeds ${maxBytes} bytes`));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body), cap, fs.createWriteStream(dest, { flags: "wx", flush: true }), { signal: ctl.signal });
    } catch (err) {
      if (err instanceof InstallError) throw err;
      if (why) throw new InstallError("network", `download aborted: ${why}`);
      if (typeof err.code === "string" && DISK_CODES.has(err.code)) throw asDiskError(err);
      throw new InstallError("network", `download failed: ${err?.message ?? err}`);
    }
  } finally {
    clearTimeout(idle); clearTimeout(total);
  }
}

// One update cycle. Never throws; returns { installed, reason?, detail?, manifest?, path? }.
export async function checkForUpdate({
  config, current, fetch: fetchFn = globalThis.fetch, publicKey,
  timeoutMs = FETCH_TIMEOUT_MS, idleMs = IDLE_TIMEOUT_MS,
  downloadTimeoutMs = (config.downloadTimeoutMin || 30) * 60_000,
  maxGzBytes = MAX_GZ_BYTES, maxDbBytes = MAX_DB_BYTES, log,
}) {
  if (!updatesEnabled(config)) return { installed: false, reason: "no_license" };
  if (!publicKey) return { installed: false, reason: "no_public_key" };
  if (!updateUrlOk(config.updateUrl)) return { installed: false, reason: "bad_url", detail: "C4C_UPDATE_URL must be https (plain http only to localhost / 127.0.0.1)" };
  const base = config.updateUrl.replace(/\/+$/, "");
  let manifest;
  let tmp = null;
  try {
    const small = async (name, max) => {
      const signal = AbortSignal.timeout(timeoutMs);
      return readCapped(await feedGet(fetchFn, `${base}/${name}`, config.licenseKey, signal), max, name);
    };
    const manifestBytes = await small("manifest.json", MAX_MANIFEST_BYTES);
    const sigBytes = await small("manifest.sig", MAX_SIG_BYTES);
    try { manifest = verifyManifest(manifestBytes, sigBytes, publicKey); }
    catch (err) { return { installed: false, reason: "bad_signature", detail: err.message }; }

    current ??= readCurrent(config.dataDir, { publicKey });
    if (current.path && current.manifest && compareVersions(manifest.version, current.manifest.version) <= 0) {
      return { installed: false, reason: "not_newer", manifest };
    }
    try { fs.mkdirSync(config.dataDir, { recursive: true }); } catch (err) { throw asDiskError(err); }
    tmp = path.join(config.dataDir, `download-${unique()}.gz.part`);
    await download(fetchFn, `${base}/${manifest.version}/corpus.sqlite.gz`, config.licenseKey, tmp,
      { maxBytes: maxGzBytes, headerMs: timeoutMs, idleMs, totalMs: downloadTimeoutMs });
    const r = await installLibrary({ gzPath: tmp, manifestBytes, sigBytes, publicKey, dataDir: config.dataDir, maxDbBytes, log });
    return { installed: true, manifest: r.manifest, path: r.path };
  } catch (err) {
    if (err instanceof InstallError) return { installed: false, reason: err.reason, detail: err.message, manifest };
    return { installed: false, reason: "error", detail: String(err?.message ?? err), manifest };
  } finally {
    if (tmp) rmQuiet(tmp);
  }
}

const scrub = (s, key) => (key && typeof s === "string" ? s.split(key).join("[redacted]") : s);

// Background updater: one attempt now, then every config.updateIntervalH hours (0 = only at start).
// `corpus` is the serving openCorpus() object, or a function returning it (null when none is open).
// onInstalled(manifest, { path, swapped }) runs after every install, and after a re-swap when the
// library on disk differs from the one being served (e.g. a failed swap, or an offline load).
// Returns stop(); stop.first is the first attempt's promise, stop.attempt() runs a cycle now.
export function startUpdater({
  config, corpus, onInstalled, log = (o) => console.log(JSON.stringify(o)),
  setInterval: every = globalThis.setInterval, clearInterval: cancel = globalThis.clearInterval,
  fetch: fetchFn = globalThis.fetch, publicKey, now = () => new Date(), checkOptions = {},
}) {
  const key = config.licenseKey;
  const emit = (o) => {
    const line = { at: now().toISOString(), ...o };
    if (line.detail) line.detail = scrub(line.detail, key);
    try { log(line); } catch { /* logging never breaks the updater */ }
  };
  const off = !publicKey ? ["no_public_key", "library-public-key.pem is missing; refusing to install unverified libraries, automatic updates are off"]
    : !updatesEnabled(config) ? ["no_license", "neither C4C_LICENSE_KEY nor a mirror C4C_UPDATE_URL is set; automatic library updates are off"]
    : !updateUrlOk(config.updateUrl) ? ["bad_url", "C4C_UPDATE_URL must be https (plain http only to localhost / 127.0.0.1); automatic updates are off"]
    : null;
  if (off) {
    const stop = () => {};
    emit({ result: "disabled", reason: off[0], version: null, detail: off[1] });
    stop.first = Promise.resolve();
    stop.attempt = async () => {};
    return stop;
  }

  const serving = () => (typeof corpus === "function" ? corpus() : corpus);
  const deliver = (manifest, info) => {
    try { onInstalled?.(manifest, info); }
    catch (err) { emit({ result: "warning", reason: "on_installed", version: manifest?.version ?? null, detail: String(err?.message ?? err) }); }
  };

  let busy = null;
  const cycle = async () => {
    // Re-swap if the verified library on disk is not the one being served.
    const c0 = serving();
    const disk = readCurrent(config.dataDir, { publicKey });
    if (c0 && disk.path && disk.manifest && path.resolve(disk.path) !== path.resolve(c0.path)) {
      try { c0.swap(disk.path); deliver(disk.manifest, { path: disk.path, swapped: true }); }
      catch (err) { emit({ result: "failed", reason: "swap", version: disk.manifest.version, detail: String(err?.message ?? err) }); }
    }
    const r = await checkForUpdate({
      config, fetch: fetchFn, publicKey, ...checkOptions,
      log: (m) => emit({ result: "warning", reason: "stale_lock", version: null, detail: m }),
    });
    if (r.installed) {
      let swapped = false;
      try {
        const c = serving();
        if (c) { c.swap(r.path); swapped = true; }
      } catch (err) {
        emit({ result: "failed", reason: "swap", version: r.manifest.version, detail: String(err?.message ?? err) });
        return;
      }
      deliver(r.manifest, { path: r.path, swapped });
      emit({ result: "installed", reason: null, version: r.manifest.version });
    } else {
      const line = { result: r.reason === "not_newer" ? "current" : "failed", reason: r.reason, version: r.manifest?.version ?? null };
      if (r.detail) line.detail = r.detail;
      emit(line);
    }
  };
  const attempt = () => {
    busy ??= cycle()
      .catch((err) => emit({ result: "failed", reason: "error", version: null, detail: String(err?.message ?? err) }))
      .finally(() => { busy = null; });
    return busy;
  };

  const first = attempt();
  const hours = config.updateIntervalH;
  const handle = hours > 0 ? every(() => { attempt(); }, hours * 3600_000) : null;
  handle?.unref?.();
  const stop = () => { if (handle != null) cancel(handle); };
  stop.first = first;
  stop.attempt = attempt;
  return stop;
}
