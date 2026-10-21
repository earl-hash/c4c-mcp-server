// INCORPORATED MORTGAGEE LETTERS point to the handbook sections that carry them
// (2026-10-08). Asked "Did FHA remove the covid income exception?", one Copilot run reached
// ML 2022-09, whose currency said only "Incorporated into HUD Handbook 4000.1: quote the
// handbook, not ML 2022-09", stopped there and answered "No" -- never learning that the
// handbook sections holding the letter (4000.1 II.A.4.c, II.A.5.b) have an Update 18
// revision that removes that text. The build already records those sections (the currency
// row's links); tool results carried only kind + headline.
//
// So every tool result (and every search hit) whose currency is "incorporated" gets
// `incorporated_into` (the handbook registers), and, when any of them is dual-version, the
// headline says so with the mandatory date. Read-only, two small indexed queries, fail-open.
const LINKS_SQL = "SELECT register_id, links_json FROM currency WHERE register_id IN (SELECT value FROM json_each(?1)) " +
  "AND kind = 'incorporated'";
const TARGET_SQL = "SELECT register_id, kind, mandatory_date FROM currency WHERE register_id IN (SELECT value FROM json_each(?1))";

function handbookTargets(json) {
  try {
    const v = JSON.parse(json ?? "[]");
    return [...new Set((Array.isArray(v) ? v : []).map((l) => l?.register_id).filter((r) => /^hud-4000-1/.test(r ?? "")))];
  } catch {
    return [];
  }
}

export function incorporatedItems(p) {
  if (!p || typeof p !== "object") return [];
  const items = [p, ...(Array.isArray(p.results) ? p.results : [])];
  return items.filter((i) => i && i.register_id && i.currency?.kind === "incorporated" && !i.currency.incorporated_into);
}

export function annotate(currency, targets, targetRows) {
  const dual = targets.filter((t) => targetRows.get(t)?.kind === "dual-version");
  const out = { ...currency, incorporated_into: targets };
  if (dual.length) {
    const mand = dual.map((t) => targetRows.get(t)?.mandatory_date).filter(Boolean).sort().pop();
    out.headline = `${currency.headline}. The handbook sections holding it (${dual.join(", ")}) have an ` +
      `Update 18 revision${mand ? ` (optional now, mandatory ${mand})` : ""}: read both versions there before answering`;
  }
  return out;
}

export async function enrichIncorporated(env, result) {
  try {
    const first = result?.content?.[0];
    if (!env?.CORPUS || !first || first.type !== "text" || typeof first.text !== "string") return result;
    if (!first.text.includes('"incorporated"')) return result; // cheap pre-check
    const p = JSON.parse(first.text);
    const items = incorporatedItems(p);
    if (!items.length) return result;
    const ids = [...new Set(items.map((i) => i.register_id))];
    const { results: linkRows } = await env.CORPUS.prepare(LINKS_SQL).bind(JSON.stringify(ids)).all();
    const targetsOf = new Map((linkRows ?? []).map((r) => [r.register_id, handbookTargets(r.links_json)]));
    const all = [...new Set([...targetsOf.values()].flat())];
    if (!all.length) return result;
    const { results: tRows } = await env.CORPUS.prepare(TARGET_SQL).bind(JSON.stringify(all)).all();
    const targetRows = new Map((tRows ?? []).map((r) => [r.register_id, r]));
    let changed = false;
    for (const i of items) {
      const t = targetsOf.get(i.register_id) ?? [];
      if (!t.length) continue;
      i.currency = annotate(i.currency, t, targetRows);
      changed = true;
    }
    if (!changed) return result;
    return { ...result, content: [{ ...first, text: JSON.stringify(p) }, ...result.content.slice(1)] };
  } catch {
    return result;
  }
}
