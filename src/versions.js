// Obligation versions (migrations-corpus/0005_versions.sql; rows from
// scripts/build-mcp-index.py version_pair).
//
// The owner's Claude Desktop test (2026-09-26): "C4C returned 4000.1 II.A.8.d as effective
// 5/25/2025. Update 18 (issued 8/12/2026) revises this section. The revision is optional
// now and mandatory 11/10/2026, and C4C doesn't return the revised text." A lender that has
// adopted Update 18 needs the revised text. Each FHA dual-version section now has two
// obligation rows -- the in-force text and `<id>::update-18`, the Update 18 revision -- and
// every tool that returns an obligation labels which one it is (`version`) and names the
// other (`other_version`).
//
// This is OUR editorial layer, never the regulator's words (envelope rule 1): the labels
// sit in their own fields, beside the verbatim text.
//
// DEPLOY ORDER: none. The table is read with its own query and a missing table reads as
// "no versions" (the revision rows arrive in the same SQL as the table, so there is nothing
// to label before it exists).

export const IN_FORCE = "in-force";
export const UPDATE_18 = "update-18-optional";
export const VERSION_SUFFIX = "::update-18";

const SQL = `
  SELECT obligation_id, register_id, version, pair_id, effective_date, mandatory_date
  FROM obligation_versions
  WHERE obligation_id IN (SELECT value FROM json_each(?1))
     OR pair_id IN (SELECT value FROM json_each(?1))`;

// Only a register whose currency row is kind "dual-version" can have versions: callers pass
// the rows they hold (with currency_kind) and only those registers' ids are looked up, so
// the common case costs no query.
export function dualVersionIds(rows) {
  return (rows ?? [])
    .filter((r) => r?.currency_kind === "dual-version" || r?.register_currency_kind === "dual-version")
    .map((r) => r.obligation_id);
}

// Map obligation_id -> version row for the given ids AND their pairs. Empty on any error
// (the table not yet created), so callers degrade to "one version".
export async function fetchVersions(env, ids) {
  const list = [...new Set((ids ?? []).filter(Boolean))];
  if (!list.length) return new Map();
  try {
    const { results } = await env.CORPUS.prepare(SQL).bind(JSON.stringify(list)).all();
    return new Map((results ?? [])
      .filter((r) => r?.obligation_id && r.version && r.pair_id)
      .map((r) => [r.obligation_id, r]));
  } catch {
    return new Map();
  }
}

function note(v, pair) {
  const other = pair ? ` The other version is obligation_id ${pair.obligation_id}.` : "";
  if (v.version === UPDATE_18) {
    return "HUD Handbook 4000.1 Update 18 revision (issued 2026-08-12), stamped effective " +
      `${v.effective_date ?? v.mandatory_date}. OPTIONAL until ${v.mandatory_date}: it ` +
      "governs a Mortgagee that has adopted Update 18, and every Mortgagee from " +
      `${v.mandatory_date}. Until then the in-force version governs by default.${other}`;
  }
  return `The text in force by default${v.effective_date ? ` (effective ${v.effective_date})` : ""}. ` +
    "HUD Handbook 4000.1 Update 18 revises this section: the revision may be implemented " +
    `now and must be implemented by ${pair?.mandatory_date ?? "its mandatory date"}.${other}`;
}

// { version, other_version } for one obligation, or {} when it has a single version.
export function versionFields(obligationId, versions) {
  const v = versions?.get?.(obligationId);
  if (!v) return {};
  const pair = versions.get(v.pair_id);
  const other = pair
    ? {
      obligation_id: pair.obligation_id,
      version: pair.version,
      ...(pair.effective_date ? { effective_date: pair.effective_date } : {}),
      ...(pair.mandatory_date ? { mandatory_date: pair.mandatory_date } : {}),
    }
    : { obligation_id: v.pair_id };
  return {
    version: {
      label: v.version,
      ...(v.effective_date ? { effective_date: v.effective_date } : {}),
      ...(v.mandatory_date ? { mandatory_date: v.mandatory_date } : {}),
      note: note(v, pair),
    },
    other_version: other,
  };
}

// Short form for a search result: the label and the other version's id.
export function versionBrief(obligationId, versions) {
  const v = versions?.get?.(obligationId);
  if (!v) return {};
  return {
    version: v.version,
    other_version: v.pair_id,
    ...(v.mandatory_date ? { mandatory_date: v.mandatory_date } : {}),
  };
}
