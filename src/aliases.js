// Same-text register aliases (migrations-corpus/0004_aliases.sql; rows from
// scripts/build-mcp-index.py build_aliases, which documents the canonical rule).
//
// The owner's Claude Desktop test (2026-09-25): lookup_citation("4000.1 II.A.8.d") refused
// as "ambiguous" between hud-4000-1-ii-a-8-refinances, hud-4000-1-ii-d-refinances and
// hud-4000-1-programs-and-products-refinances -- three registers with IDENTICAL text. The
// `aliases` table maps every non-canonical member of a same-text group to its canonical
// register (the canonical has no row). Candidates that share a canonical are collapsed
// BEFORE ambiguity is decided; different texts for one citation still refuse.
//
// DEPLOY ORDER: the table must exist before this Worker ships (apply the aliases SQL
// first). Queries JOIN it unconditionally, like the `currency` table.

// Every alias row in the groups of the given register ids (json array bound as ?1): the
// candidates' own rows, and the rows of every register sharing their canonical.
export const ALIAS_GROUP_SQL = `
  WITH ids(id) AS (SELECT value FROM json_each(?1)),
       canon(c) AS (
         SELECT COALESCE((SELECT a.canonical_id FROM aliases a WHERE a.register_id = ids.id), ids.id)
         FROM ids)
  SELECT register_id, canonical_id FROM aliases WHERE canonical_id IN (SELECT c FROM canon)
  ORDER BY register_id`;

export async function fetchAliasRows(env, ids) {
  if (!ids.length) return [];
  const { results } = await env.CORPUS.prepare(ALIAS_GROUP_SQL).bind(JSON.stringify(ids)).all();
  return results ?? [];
}

// { canonOf(id), membersOf(canonical) } over alias rows.
export function aliasIndex(aliasRows = []) {
  const canon = new Map();
  const members = new Map();
  for (const { register_id, canonical_id } of aliasRows ?? []) {
    canon.set(register_id, canonical_id);
    if (!members.has(canonical_id)) members.set(canonical_id, new Set([canonical_id]));
    members.get(canonical_id).add(register_id);
  }
  return {
    canonOf: (id) => canon.get(id) ?? id,
    membersOf: (c) => [...(members.get(c) ?? [c])].sort(),
  };
}

// Collapse candidate register ids by canonical. Each group is represented by its only
// candidate when just one member matched (keep what the citation actually named), else by
// the canonical. Returns [{ register_id, canonical_id, also_at }], sorted by register_id;
// also_at lists the group's other members (same text), empty when there are none.
export function collapseCandidates(ids, aliasRows = []) {
  const { canonOf, membersOf } = aliasIndex(aliasRows);
  const groups = new Map();
  for (const id of ids) {
    const c = canonOf(id);
    if (!groups.has(c)) groups.set(c, new Set());
    groups.get(c).add(id);
  }
  const out = [];
  for (const [c, hit] of groups) {
    const register_id = hit.size === 1 ? [...hit][0] : c;
    out.push({
      register_id,
      canonical_id: c,
      also_at: membersOf(c).filter((m) => m !== register_id),
    });
  }
  return out.sort((a, b) => a.register_id.localeCompare(b.register_id));
}

// search_regs: drop result rows that are same-text copies of a better-ranked row. Rows must
// carry canonical_id (COALESCE(alias, own id)) and text_key (a prefix of the normalized
// text plus its length -- distinguishes a canonical register's several obligations). The
// best-ranked copy is kept and gains `also_at` (the dropped copies' register ids).
export function collapseCopies(rows) {
  const kept = new Map();
  const out = [];
  for (const r of rows) {
    const key = `${r.canonical_id ?? r.register_id}\u0000${r.text_key ?? r.obligation_id}`;
    const first = kept.get(key);
    if (!first) {
      const row = { ...r, also_at: [...(r.also_at ?? [])] };
      kept.set(key, row);
      out.push(row);
    } else if (r.register_id !== first.register_id && !first.also_at.includes(r.register_id)) {
      first.also_at.push(r.register_id);
    }
  }
  return out;
}

// OBLIGATION ALIASES (2026-09-26, Round 4; migrations-corpus/0007_obligation_aliases.sql; rows
// from scripts/build-mcp-index.py obligation_alias_rows). scripts/resegment-cfr.py rebuilt ~80
// CFR registers on the eCFR paragraph hierarchy, so obligations the old splitter cut at every
// "(i)"/"(v)" (reg-x-1024.35-i-2, ...) no longer exist; the Freddie chapter registers retired
// their duplicate "-full" obligations (source.obligation_redirects). A client may still hold an
// old id, so an obligation_id that is not in `obligations` is looked up here:
//   alias_id       "<register_id>::<old obligation id>"
//   obligation_id  the obligation that holds the old text now
// A bare old id (without the "<register_id>::" prefix) matches too, when it names one target.
// Fails open: a missing table (a Worker deployed before the migration) or any error is "no
// alias", so the caller's not_found stands.
export const OBLIGATION_ALIAS_SQL = `
  SELECT alias_id, obligation_id FROM obligation_aliases
  WHERE alias_id = ?1 OR substr(alias_id, instr(alias_id, '::') + 2) = ?1
  ORDER BY (alias_id = ?1) DESC, alias_id LIMIT 5`;

export async function resolveObligationAlias(env, id) {
  if (!id) return null;
  let results;
  try {
    ({ results } = await env.CORPUS.prepare(OBLIGATION_ALIAS_SQL).bind(id).all());
  } catch {
    return null;
  }
  const rows = (results ?? []).filter((r) =>
    typeof r?.alias_id === "string" && typeof r?.obligation_id === "string" &&
    (r.alias_id === id || r.alias_id.slice(r.alias_id.indexOf("::") + 2) === id));
  if (!rows.length) return null;
  if (rows[0].alias_id === id) return rows[0].obligation_id;
  // A bare old id shared by two registers' aliases with different targets is ambiguous.
  const targets = new Set(rows.map((r) => r.obligation_id));
  return targets.size === 1 ? rows[0].obligation_id : null;
}
