// CURRENCY LISTING (batch 13, eval G14/G16/G17). search_regs' currency_kind filter needed a
// placeholder query word, and the word changed the answer: "effective date" + pending gave 0
// rows, "mortgage" + pending gave 25; VA + revised gave 0 for "loan" and empty_query for
// "guidance" although 26 VA registers are revised; ML 2026-07 never surfaced for "what changed
// at FHA". When currency_kind is set and the query holds no topic word of its own (only
// words like "changes", "effective date", "mortgage", "guidance", or an agency name), the
// filter is answered as a LIST: every register (or obligation) carrying that currency kind in
// the family, newest currency date first, one row per register -- independent of the
// placeholder word.
import { contentTokens } from "./tools/search.js";
import { extractAgencies, familyFilterSql } from "./agency.js";
import { CURRENCY_COLUMNS_BRIEF, currencyJoin, withObligationCurrency } from "./currency.js";

export const GENERIC_WORDS = new Set(`
  effective date dates mortgage mortgages loan loans lending lender lenders guidance change changes changed
  new newest latest recent recently update updates updated revise revised revision revisions
  pending upcoming future list all every section sections topic topics rule rules guide guides
  handbook handbooks requirement requirements policy policies current currency kind kinds
  version versions status signal signals provision provisions text document documents what's whats
  show give find search happened happening month months year years week weeks today soon
  expire expires expiring expired superseded supersede proposed modified amended amendment amendments
  time limited
`.split(/\s+/).filter(Boolean));

// True when the query, minus agency names and generic words, has no content word left.
export function isGenericQuery(query) {
  const { tokens } = extractAgencies(contentTokens(String(query ?? "")));
  return tokens.every((t) => GENERIC_WORDS.has(t) || /^(?:19|20)\d\d$/.test(t));
}

const KIND_MATCH = (alias, param) =>
  `(?${param} = 'any' OR ${alias}.kind = ?${param})`;

export async function listByCurrency(env, { family, currency_kind, limit }) {
  const fam = family ?? "";
  const regs = await env.CORPUS.prepare(`
    SELECT c.register_id, NULL AS obligation_id, c.effective_date AS d
    FROM currency c JOIN registers r ON r.register_id = c.register_id
    WHERE ${familyFilterSql(1)} AND ${KIND_MATCH("c", 2)}
    UNION ALL
    SELECT oc.register_id, oc.obligation_id, oc.effective_date AS d
    FROM obligation_currency oc JOIN registers r ON r.register_id = oc.register_id
    WHERE ${familyFilterSql(1)} AND ${KIND_MATCH("oc", 2)}`).bind(fam, currency_kind).all();
  // One entry per register: an obligation-level match names the obligation; the newest date.
  const by = new Map();
  for (const x of regs.results ?? []) {
    const cur = by.get(x.register_id);
    if (!cur) { by.set(x.register_id, { ...x }); continue; }
    if (x.obligation_id && (!cur.obligation_id || String(x.d ?? "") > String(cur.d ?? ""))) cur.obligation_id = x.obligation_id;
    if (String(x.d ?? "") > String(cur.d ?? "")) cur.d = x.d;
  }
  const total = by.size;
  const picked = [...by.values()]
    .sort((a, b) => String(b.d ?? "").localeCompare(String(a.d ?? "")) || a.register_id.localeCompare(b.register_id))
    .slice(0, limit);
  if (!picked.length) return { rows: [], total };
  const { results } = await env.CORPUS.prepare(`
    SELECT o.obligation_id, o.register_id, o.section, o.authority, r.family,
           substr(o.verbatim, 1, 300) AS excerpt, ${CURRENCY_COLUMNS_BRIEF},
           r.authority AS register_title
    FROM obligations o JOIN registers r ON r.register_id = o.register_id
    ${currencyJoin("o.register_id")}
    WHERE o.obligation_id IN (SELECT value FROM json_each(?1))
       OR o.rowid IN (SELECT min(o2.rowid) FROM obligations o2
                      WHERE o2.register_id IN (SELECT value FROM json_each(?2)) GROUP BY o2.register_id)`)
    .bind(JSON.stringify(picked.filter((p) => p.obligation_id).map((p) => p.obligation_id)),
      JSON.stringify(picked.filter((p) => !p.obligation_id).map((p) => p.register_id))).all();
  const rowOf = new Map();
  for (const r of results ?? []) {
    const want = picked.find((p) => p.register_id === r.register_id);
    if (!want) continue;
    if (want.obligation_id ? r.obligation_id === want.obligation_id : !rowOf.has(r.register_id)) rowOf.set(r.register_id, r);
  }
  const rows = picked.map((p) => rowOf.get(p.register_id)).filter(Boolean);
  return { rows, total };
}

export { withObligationCurrency };
