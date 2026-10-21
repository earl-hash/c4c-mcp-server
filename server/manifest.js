// Library manifest: shared by the package builder (Earl's machine) and the updater (container).
// The manifest is canonical JSON bytes; manifest.sig is an Ed25519 signature over those exact bytes.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export class ManifestError extends Error {
  constructor(message) { super(message); this.name = "ManifestError"; }
}

const VERSION_RE = /^(\d{4}-\d{2}-\d{2})\.(\d+)$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function makeManifest({ version, builtAt, sha256, rows, sourceSqlSha256, schemaVersion = 7 }) {
  return {
    version,
    built_at: builtAt,
    schema_version: schemaVersion,
    sha256,
    rows: { registers: rows.registers, obligations: rows.obligations, snapshots: rows.snapshots },
    source_sql_sha256: sourceSqlSha256,
  };
}

export function signManifest(bytes, privatePem) {
  return sign(null, Buffer.from(bytes), createPrivateKey(privatePem));
}

export function verifyManifest(bytes, sig, publicPem) {
  let ok = false;
  try { ok = verify(null, Buffer.from(bytes), createPublicKey(publicPem), Buffer.from(sig)); } catch { ok = false; }
  if (!ok) throw new ManifestError("manifest signature is invalid");
  let m;
  try { m = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new ManifestError("manifest is not valid JSON"); }
  if (!m || typeof m !== "object") throw new ManifestError("manifest is not an object");
  if (typeof m.version !== "string" || !VERSION_RE.test(m.version)) throw new ManifestError("manifest version is missing or malformed");
  if (typeof m.built_at !== "string" || Number.isNaN(Date.parse(m.built_at))) throw new ManifestError("manifest built_at is missing or malformed");
  if (!Number.isInteger(m.schema_version)) throw new ManifestError("manifest schema_version is missing");
  if (typeof m.sha256 !== "string" || !HEX64.test(m.sha256)) throw new ManifestError("manifest sha256 is missing or malformed");
  if (typeof m.source_sql_sha256 !== "string" || !HEX64.test(m.source_sql_sha256)) throw new ManifestError("manifest source_sql_sha256 is missing or malformed");
  const r = m.rows;
  if (!r || !["registers", "obligations", "snapshots"].every((k) => Number.isInteger(r[k]))) throw new ManifestError("manifest rows is missing or malformed");
  return m;
}

// Versions are YYYY-MM-DD.N: compare by date, then N numerically.
export function compareVersions(a, b) {
  const pa = VERSION_RE.exec(a), pb = VERSION_RE.exec(b);
  if (!pa || !pb) throw new ManifestError(`bad version: ${!pa ? a : b}`);
  if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
  const na = Number(pa[2]), nb = Number(pb[2]);
  return na === nb ? 0 : na < nb ? -1 : 1;
}
