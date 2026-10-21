// Currency warnings (migrations-corpus/0003_currency.sql; rows from build-mcp-index.py).
//
// The owner's claude.ai test (2026-09-25) read FHA 4000.1 II.A.8.d in full and was never
// told it is a dual-version section: the signal existed in the YAML and on the site but
// never reached the MCP. Every tool that returns a register or its text now LEFT JOINs
// the `currency` side table (one row per register with a signal, PK lookup) and returns
// `currency` -- an object, or null when the corpus holds no currency signal for it.
//
// This is OUR editorial layer, never the regulator's words (envelope rule 1): it sits in
// its own field, beside the verbatim text, never inside it.

// Columns for a query that aliases the side table as `c`, prefixed so they cannot collide
// with the obligation / register columns they are selected beside.
export const CURRENCY_COLUMNS =
  "c.kind AS currency_kind, c.headline AS currency_headline, c.detail AS currency_detail, " +
  "c.effective_date AS currency_effective_date, c.mandatory_date AS currency_mandatory_date, " +
  "c.expires_on AS currency_expires_on, c.as_of AS currency_as_of, " +
  "c.links_json AS currency_links_json";

// search_regs returns up to 25 rows: the short form (kind + headline + dates) keeps a
// result list cheap; get_obligation / find_in_section / get_reg carry the full detail.
export const CURRENCY_COLUMNS_BRIEF =
  "c.kind AS currency_kind, c.headline AS currency_headline, " +
  "c.mandatory_date AS currency_mandatory_date, c.expires_on AS currency_expires_on";

export function currencyJoin(registerIdExpr) {
  return `LEFT JOIN currency c ON c.register_id = ${registerIdExpr}`;
}

function links(json) {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// The `currency` object for a row selected with CURRENCY_COLUMNS(_BRIEF), or null.
// Absent fields are omitted rather than sent as null, to keep responses short.
export function currencyOf(row) {
  if (!row || !row.currency_kind) return null;
  const out = { kind: row.currency_kind, headline: row.currency_headline ?? "" };
  if (row.currency_detail) out.detail = row.currency_detail;
  if (row.currency_effective_date) out.effective_date = row.currency_effective_date;
  if (row.currency_mandatory_date) out.mandatory_date = row.currency_mandatory_date;
  if (row.currency_expires_on) out.expires_on = row.currency_expires_on;
  if (row.currency_as_of) out.as_of = row.currency_as_of;
  if (row.currency_links_json !== undefined) {
    const l = links(row.currency_links_json);
    if (l.length) out.links = l;
  }
  return out;
}

// OBLIGATION-LEVEL CURRENCY (2026-09-26; migrations-corpus/0006_obligation_currency.sql).
// Some signals belong to one obligation, not its register: a Freddie Mac section holds the
// text in force AND "PENDING VERSION, takes effect 2026-11-16" rows. Those obligations get
// their own row in `obligation_currency` (same columns as `currency`, keyed by
// obligation_id); it replaces the register's currency on that obligation only.
//
// Read with its own query and an empty result on any error, so a Worker deployed before
// the table exists degrades to register-level currency (no deploy-order constraint).
const OBLIGATION_CURRENCY_SQL = `
  SELECT obligation_id, kind, headline, detail, effective_date, mandatory_date, expires_on,
         as_of, links_json
  FROM obligation_currency WHERE obligation_id IN (SELECT value FROM json_each(?1))`;

export async function fetchObligationCurrency(env, ids) {
  const list = [...new Set((ids ?? []).filter(Boolean))];
  if (!list.length) return new Map();
  try {
    const { results } = await env.CORPUS.prepare(OBLIGATION_CURRENCY_SQL)
      .bind(JSON.stringify(list)).all();
    return new Map((results ?? [])
      .filter((r) => r?.obligation_id && r.kind && r.headline)
      .map((r) => [r.obligation_id, r]));
  } catch {
    return new Map();
  }
}

// `row` with its currency_* columns replaced by the obligation's own currency row, if it
// has one. A row selected with the full CURRENCY_COLUMNS (it has currency_detail) gets
// every field; a search row (CURRENCY_COLUMNS_BRIEF) only the brief ones.
export function withObligationCurrency(row, map) {
  const oc = map?.get?.(row?.obligation_id);
  if (!oc) return row;
  const out = {
    ...row,
    // The register's own kind survives the override: a dual-version section's in-force text
    // with an obligation-level "superseded-in-part" row still has its Update 18 pair
    // (src/versions.js dualVersionIds reads this).
    register_currency_kind: row.register_currency_kind ?? row.currency_kind ?? null,
    currency_kind: oc.kind,
    currency_headline: oc.headline,
    currency_mandatory_date: oc.mandatory_date ?? null,
    currency_expires_on: oc.expires_on ?? null,
  };
  if ("currency_detail" in row) {
    out.currency_detail = oc.detail ?? "";
    out.currency_effective_date = oc.effective_date ?? null;
    out.currency_as_of = oc.as_of ?? null;
    out.currency_links_json = oc.links_json ?? "[]";
  }
  return out;
}

// Kinds whose text is NOT the rule in force today: search ranks them below current text
// (tools/search.js STALE_FACTOR) -- demoted, never dropped; the warning travels with them.
//   superseded        a later version replaced it
//   predates-statute  older than the statute that now sets the requirements (VA IRRRL
//                     text vs 38 U.S.C. 3709)
//   incorporated      a Mortgagee Letter whose provisions HUD folded into Handbook 4000.1
//   expired           past its own expiry date
//   pending           published, not yet in force
//
// NOT stale (Round 4 follow-up): "superseded-in-part" (a Mortgagee Letter already governs SOME
// provisions of this text -- the rest is current, so the row keeps its rank and its currency
// travels with it on every result) and "modified-by" (a later issuance changes it, optional now,
// mandatory later).
//   time-limited      (batch 3) a program the source itself limits in time whose last stated
//                     date has passed, without saying it ended (Ginnie Mae PTAP/COVID-19)
export const STALE_KINDS = new Set(["superseded", "predates-statute", "incorporated", "expired", "pending",
  "time-limited"]);

export function isStale(row) {
  return STALE_KINDS.has(row?.currency_kind);
}

// The row without its currency_* columns (for spreading the rest into a response).
export function withoutCurrency(row) {
  const out = {};
  for (const [k, v] of Object.entries(row ?? {})) if (!k.startsWith("currency_")) out[k] = v;
  return out;
}

// Every currency kind the index writes (scripts/build-mcp-index.py; counted in the local
// corpus 2026-09-26), plus "any". search_regs' `currency_kind` filter (C4C-11) accepts
// exactly these, so a model can list what is pending or what Update 18 revises.
export const CURRENCY_KINDS = [
  "any", "dual-version", "revision-pending", "pending", "expires", "expired", "superseded",
  "predates-statute", "incorporated", "incorporated-update-18", "revised",
  "revised-this-update", "source-relocated", "proposed", "directive-watch", "vacated-watch",
  // Round 4 (FHA/VA/SBA corpus job): obligation-level Mortgagee Letter signals.
  "superseded-in-part", "modified-by",
  // Round 4 (Freddie deleted-section registers, source.status: deleted).
  "deleted",
  // Batch 3: usable now, mandatory on mandatory_date (UAD 3.6 / URAR appendices; not stale);
  // a Ginnie Mae APM naming the MBS Guide sections it changes; a time-limited program.
  "optional-now", "amends", "time-limited",
  // Batch 10: an editorial note on a current register (a table row the statute overrides, a
  // cross-reference to a later removal). NOT stale: it ranks as current text; its headline
  // travels with the register (search/get) and with a verify_quote match (register_note).
  "note",
];
