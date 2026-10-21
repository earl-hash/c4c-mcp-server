// FORGIVING MATCHING (batch 15, four live eval rounds, ~200 questions).
//
// search_regs is AND over content terms, so a long natural question ("How do I document pension
// or retirement account distribution income for Fannie Mae and must it continue three years?"),
// a scenario question or an NMLS-CE fill-in-the-blank ("... are ____ and ____ of one percent of
// the transaction amount") came back no_match: some filler word -- "document", "continue",
// "levels" -- is missing from the governing text. The relaxed gates in search.js still demand
// a title that names most of the words, which a long question never satisfies.
//
// When everything else returns nothing, search.js asks this module for a ranked "most terms"
// match: question scaffolding is stripped, every remaining term is weighted by how rare it is in
// the corpus (BM25's inverse document frequency, read from the FTS index itself), and a row
// is accepted when the terms it holds carry at least FORGIVE_MIN_SHARE of the query's total
// weight. Rarity is what keeps an off-topic question refused: its distinctive words ("tire",
// "cookies", "Capital One") are absent from the corpus or rare, so they carry most of the
// weight and no row covers them; the words a stray row shares with it ("change", "long") are
// common and weigh little. Rows found this way are partial matches (match "partial",
// missing_terms names what they lack).

// Question scaffolding: phrases that say what kind of answer is wanted, never words the
// regulator's text must hold. Removed before the terms are weighed.
const SCAFFOLD = [
  /\bfill\s+in\s+the\s+blanks?\b/gi,
  /_{2,}/g,
  /\bwhat\s+does\s+it\s+mean\s+when\b/gi,
  /\b(?:can|could|may)\s+(?:i|we|you|they|he|she)\s+still\b/gi,
  /\bis\s+it\s+(?:true|correct|accurate)\s+that\b/gi,
  /\b(?:true|false)\s*(?:or|\/)\s*(?:true|false)\b/gi,
  /\bwithin\s+how\s+many\s+(?:days|months|years|business\s+days)\b/gi,
  /\bhow\s+do\s+(?:i|we|you)\b/gi,
  /\bwhat\s+(?:does|do)\s+\w+\s+need\s+to\s+see\b/gi,
  /\bdoes\s+it\s+(?:have|need)\s+to\b/gi,
];
// Single words of question framing that survive the stopword list ("still", "true").
export const SCAFFOLD_WORDS = new Set(["still", "true", "false", "blank", "blanks", "fill",
  "following", "statement", "correct", "incorrect", "answer", "question", "example", "scenario",
  "my", "borrower's", "someone", "situation", "case", "ok", "okay", "allowed", "able", "possible"]);

export function stripScaffold(query) {
  let q = String(query ?? "");
  for (const re of SCAFFOLD) q = q.replace(re, " ");
  return q;
}

// Minimum share of the query's IDF weight a row must hold; minimum groups it must hold.
export const FORGIVE_MIN_SHARE = 0.55;
export const FORGIVE_MIN_GROUPS = 2;
// Rows fetched by weighted coverage before the full ranking runs.
export const FORGIVE_POOL = 120;

// A group carrying FORGIVE_MUST_SHARE or more of the query's weight is its subject and must be
// held: "how do I change a car tire on the highway" has "highway" and "car" in a Freddie
// section, but "tire" -- the rarest word -- in no row with them. A word the corpus never uses
// (df 0) weighs in the total, so it lowers every row's share, but cannot be required.
export const FORGIVE_MUST_SHARE = 0.3;
export function mustHold(weights, dfs) {
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w, i) => (dfs[i] > 0 && total && w / total >= FORGIVE_MUST_SHARE ? i : -1)).filter((i) => i >= 0);
}

// BM25's (Robertson-Sparck Jones) inverse document frequency, never negative.
export function idf(df, n) {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

// Document frequency of each rendered group MATCH, and the corpus size.
export async function groupWeights(env, groupMatches) {
  const total = await env.CORPUS.prepare("SELECT count(*) AS n FROM obligations").all();
  const n = Number(total?.results?.[0]?.n ?? 0);
  const dfs = [];
  for (const m of groupMatches) {
    const row = await env.CORPUS
      .prepare("SELECT count(*) AS df FROM obligations_fts WHERE obligations_fts MATCH ?1")
      .bind(m).all();
    dfs.push(Number(row?.results?.[0]?.df ?? 0));
  }
  return { n, dfs, weights: dfs.map((df) => idf(df, n)) };
}

// SQL: obligation rowids ranked by the summed weight of the groups they match. One bound
// MATCH and one bound weight per group, then the family parameter.
export function coverageSql(nGroups, familySql) {
  const parts = Array.from({ length: nGroups }, (_, i) =>
    `SELECT rowid AS rid, ?${2 * i + 2} AS w FROM obligations_fts WHERE obligations_fts MATCH ?${2 * i + 1}`);
  return `SELECT u.rid AS rid, sum(u.w) AS wsum FROM (${parts.join(" UNION ALL ")}) u
    JOIN obligations o ON o.rowid = u.rid JOIN registers r ON r.register_id = o.register_id
    WHERE ${familySql}
    GROUP BY u.rid ORDER BY wsum DESC LIMIT ?${2 * nGroups + 2}`;
}

// The weighted share of a row's matched groups (bit i of cov_mask = group i).
export function weightedShare(mask, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let got = 0;
  weights.forEach((w, i) => { if (Number(mask) & (2 ** i)) got += w; });
  return got / total;
}

export function popcount(mask) {
  let m = Number(mask) || 0;
  let c = 0;
  while (m) { c += m & 1; m = Math.floor(m / 2); }
  return c;
}

// SECTION LEVEL (batch 21): a query's terms can span two paragraphs of one section -- "TRID
// tolerance 10 percent cumulative refund cure" has "good faith" + "10" + "aggregate" in 12 CFR
// 1026.19(e)(3) and "good faith" + "refund" in (f)(2)(v), and neither paragraph alone holds
// FORGIVE_MIN_SHARE. A register is admitted when TWO of its paragraphs (each holding at least
// FORGIVE_MIN_GROUPS groups) together hold FORGIVE_PAIR_SHARE of the query's weight -- a pair,
// not the whole register, so a long handbook's many paragraphs cannot pool every common word.
export const FORGIVE_PAIR_SHARE = 0.7;
export const FORGIVE_PAIR_POOL = 4000;

// SQL: per obligation rowid, its register and the bitmask of the groups it matches (bit i =
// group i), rows holding at least FORGIVE_MIN_GROUPS groups. Binds as coverageSql, with each
// weight replaced by the group's bit.
export function sectionMaskSql(nGroups, familySql) {
  const parts = Array.from({ length: nGroups }, (_, i) =>
    `SELECT rowid AS rid, ?${2 * i + 2} AS b FROM obligations_fts WHERE obligations_fts MATCH ?${2 * i + 1}`);
  return `SELECT u.rid AS rid, o.register_id AS register_id, sum(u.b) AS mask FROM (${parts.join(" UNION ALL ")}) u
    JOIN obligations o ON o.rowid = u.rid JOIN registers r ON r.register_id = o.register_id
    WHERE ${familySql}
    GROUP BY u.rid HAVING count(*) >= ${FORGIVE_MIN_GROUPS} LIMIT ?${2 * nGroups + 2}`;
}

// The best pair of paragraphs per register: { register_id, rids: [a, b], share } for each
// register whose best pair holds FORGIVE_PAIR_SHARE and more than its best single paragraph,
// and holds every group in `need` (the must-hold and proper-name groups). "Best" is the pair's
// share x the sum of its paragraphs' own shares: two paragraphs that each carry the query
// (1026.19(e)(3) + (f)(2)) beat a pair where one adds a single word ((e)(4) + (b)).
export function sectionPairs(rows, weights, need = []) {
  const byReg = new Map();
  for (const r of rows) {
    const list = byReg.get(r.register_id) ?? [];
    list.push({ rid: r.rid, mask: Number(r.mask) });
    byReg.set(r.register_id, list);
  }
  const out = [];
  for (const [register_id, list] of byReg) {
    if (list.length < 2) continue;
    const solo = Math.max(...list.map((x) => weightedShare(x.mask, weights)));
    let best = null;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const m = orMask(list[i].mask, list[j].mask);
        if (!need.every((g) => m & (2 ** g))) continue;
        const share = weightedShare(m, weights);
        const fit = share * (weightedShare(list[i].mask, weights) + weightedShare(list[j].mask, weights));
        if (!best || fit > best.fit) best = { register_id, rids: [list[i].rid, list[j].rid], share, fit };
      }
    }
    if (best && best.share >= FORGIVE_PAIR_SHARE && best.share > solo) out.push(best);
  }
  return out.sort((a, b) => b.fit - a.fit);
}

function orMask(a, b) {
  let m = 0;
  for (let i = 0; i < 31; i++) if ((a & (2 ** i)) || (b & (2 ** i))) m += 2 ** i;
  return m;
}
