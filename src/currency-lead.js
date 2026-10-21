// CURRENCY LEAD + HISTORICAL SCOPE (batch 22, 2026-10-03; neutral A/B N27).
//
// "chapter 18 of gnma guide": Claude with C4C (a) never mentioned APM 26-09 (2026-09-11),
// although the corpus flags gnma-mbs-ch18's Part 3, Section B obligation as modified by it --
// the signal sat in a `currency` field the model skimmed past, ~700 chars into the row, while
// the digest text above it read as current; and (b) stated at High confidence a repooling rule
// ("repooled only once ... current for six months") that applies only to loans backing
// securities issued between August 1 and December 1, 2002.
//
//   currency lead   when an inline / digest text block concerns a register or obligation with
//                   an active currency signal (LEAD_KINDS), the block STARTS with
//                   "CURRENCY: <the existing headline>" -- our editorial words, labelled, never
//                   inside a verbatim field (get_obligation's `verbatim` is untouched; there the
//                   `currency` object is moved to the front instead). No new text is written:
//                   the line is the stored headline, capped.
//   historical      a digest / inline passage scoped to a past period ("between August 1 and
//                   December 1, 2002", "prior to January 1, 2003") is deprioritized and, when
//                   still shown, prefixed "[Historical/limited scope: applies to <the passage's
//                   own words>]".

// Kinds that lead the text block. "revised" only when recent (RECENT_DAYS).
export const LEAD_KINDS = new Set([
  "modified-by", "amends", "superseded-in-part", "revision-pending", "pending", "revised",
  "optional-now", "time-limited",
  // Text that is not today's rule leads too (the same reason, stronger).
  "superseded", "expired", "predates-statute", "incorporated", "dual-version", "deleted",
]);
export const RECENT_DAYS = 120;
export const LEAD_MAX = 420;
const LEAD_LINES = 2;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december"];
const MONTH = "(?:January|February|March|April|May|June|July|August|September|October|November|December|" +
  "Jan\\.?|Feb\\.?|Mar\\.?|Apr\\.?|Jun\\.?|Jul\\.?|Aug\\.?|Sept?\\.?|Oct\\.?|Nov\\.?|Dec\\.?)";

// The date a signal speaks of: its effective_date, else the first date in its headline.
export function signalDate(cur) {
  const d = cur?.effective_date ?? cur?.mandatory_date;
  if (d && /^\d{4}-\d{2}-\d{2}/.test(d)) return Date.parse(d.slice(0, 10));
  const h = String(cur?.headline ?? "");
  const iso = h.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return Date.parse(iso[1]);
  const m = h.match(new RegExp(`\\b(${MONTH})\\s+(\\d{1,2}),\\s+(\\d{4})`));
  if (m) {
    const mi = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().replace(/\.$/, "").slice(0, 3)));
    if (mi >= 0) return Date.UTC(Number(m[3]), mi, Number(m[2]));
  }
  return null;
}

// Whether a currency object ({kind, headline, ...}) leads the text block.
export function leadsText(cur, now = Date.now()) {
  if (!cur?.kind || !cur.headline || !LEAD_KINDS.has(cur.kind)) return false;
  if (cur.kind !== "revised") return true;
  const t = signalDate(cur);
  return t !== null && Math.abs(now - t) <= RECENT_DAYS * 86400000;
}

function cap(s, max) {
  const t = String(s).replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const sp = t.lastIndexOf(" ", max - 1);
  return `${t.slice(0, sp > max / 2 ? sp : max - 1)}…`;
}

// The lead block for a list of currency objects: "CURRENCY: <headline>" lines (distinct
// headlines, at most LEAD_LINES, then a count), or "" when none leads.
export function currencyLead(curs, now = Date.now()) {
  const seen = new Set();
  const lines = [];
  for (const c of curs ?? []) {
    if (!leadsText(c, now)) continue;
    const h = cap(c.headline, LEAD_MAX);
    if (seen.has(h)) continue;
    seen.add(h);
    // `scope`: the part / child register the signal belongs to, when not the whole text.
    lines.push(`CURRENCY${c.scope ? ` (${c.scope})` : ""}: ${h}`);
  }
  if (!lines.length) return "";
  const more = lines.length - LEAD_LINES;
  return lines.slice(0, LEAD_LINES).join("\n") +
    (more > 0 ? `\n(+${more} more currency signal${more > 1 ? "s" : ""} in this text: see currency)` : "");
}

// `text` with the lead block in front (unchanged when there is none).
export function withLead(text, lead) {
  return lead ? `${lead}\n\n${text}` : text;
}

// A short tag for a digest piece in an amended part: the headline's first clause
// ("Modified by APM 26-09 (2026-09-11)", "PENDING VERSION").
export function pieceTag(headline) {
  const h = String(headline ?? "").replace(/\s+/g, " ").trim();
  const cut = h.search(/[:;]|\.\s/);
  return cap(cut > 0 ? h.slice(0, cut) : h, 80);
}

// Currency rows for registers and obligations: [{ register_id?, obligation_id?, kind,
// headline, effective_date, mandatory_date }]. Fails open (no table / fake D1 -> []).
export async function fetchCurrencyRows(env, registerIds = [], obligationIds = []) {
  const out = [];
  const regs = [...new Set(registerIds.filter(Boolean))];
  const obls = [...new Set(obligationIds.filter(Boolean))];
  const read = async (sql, ids) => {
    if (!ids.length) return [];
    try {
      const { results } = await env.CORPUS.prepare(sql).bind(JSON.stringify(ids)).all();
      return (results ?? []).filter((r) => r?.kind && r.headline && (r.register_id ?? r.obligation_id));
    } catch {
      return [];
    }
  };
  out.push(...(await read("SELECT register_id, kind, headline, effective_date, mandatory_date FROM currency " +
    "WHERE register_id IN (SELECT value FROM json_each(?1))", regs)).filter((r) => regs.includes(r.register_id)));
  out.push(...(await read("SELECT obligation_id, kind, headline, effective_date, mandatory_date FROM obligation_currency " +
    "WHERE obligation_id IN (SELECT value FROM json_each(?1))", obls)).filter((r) => obls.includes(r.obligation_id)));
  return out;
}

// ---- Historical / limited-scope passages -------------------------------------------------

const DATE_Y = `${MONTH}\\s+\\d{1,2},?\\s+(\\d{4})`;
const HIST_RES = [
  // "between August 1 and December 1, 2002", "from January 1, 2020 through June 30, 2020"
  new RegExp(`\\b(?:between|from)\\s+${MONTH}\\s+\\d{1,2}(?:,?\\s+\\d{4})?,?\\s+(?:and|through|to|until)\\s+${DATE_Y}`, "i"),
  // "before January 1, 2003", "prior to March 1, 2010" (not "on or after")
  new RegExp(`\\b(?:before|prior to|earlier than)\\s+${DATE_Y}`, "i"),
  // "between 2002 and 2004", "from 1998 through 2001"
  /\b(?:between|from|during)\s+(?:calendar\s+years?\s+)?(?:\d{4})\s*(?:and|through|to|-|–)\s*(\d{4})\b/i,
];
export const HIST_YEARS = 5;
const ENUM_HEAD = /^\([a-z]{1,2}\)\s/;
const STOP = new Set(["on", "for", "to", "that", "which", "and", "of", "are", "is", "under", "the", "with"]);
const SENT_SPLIT = /(?<=[.;:])\s+(?=[A-Z(“"\d$•])/g;

// The text a passage is read under: the passage, plus -- when it continues a lead-in ending
// in ":" -- the sentences before it back to its subsection heading ("(b) ..."), at most 4.
export function scopeWindow(text, offset, chars) {
  const piece = text.slice(offset, offset + chars);
  const before = text.slice(Math.max(0, offset - 900), offset);
  if (!/:\s*$/.test(before)) return piece;
  const starts = [0];
  for (const m of before.matchAll(SENT_SPLIT)) starts.push(m.index + m[0].length);
  let from = before.length;
  for (let k = starts.length - 1, n = 0; k >= 0 && n < 4; k--, n++) {
    if (before.length - starts[k] > 700) break;
    from = starts[k];
    if (ENUM_HEAD.test(before.slice(from))) break;
  }
  return before.slice(from) + piece;
}

// The words a historical scope is stated in ("Loans Backing Securities Issued between August 1
// and December 1, 2002"), or null when the passage states none older than HIST_YEARS.
export function historicalScope(text, offset = 0, chars = String(text ?? "").length, now = Date.now()) {
  const win = scopeWindow(String(text ?? ""), offset, chars).replace(/\s+/g, " ");
  const year = new Date(now).getUTCFullYear();
  let best = null;
  for (const re of HIST_RES) {
    const m = win.match(re);
    if (!m || Number(m[1]) > year - HIST_YEARS) continue;
    if (/\bon or\s*$/i.test(win.slice(Math.max(0, m.index - 8), m.index))) continue;
    if (re === HIST_RES[1]) {
      // A dated split ("(i) ... issued prior to July 1, 2011 ... (ii) ... on or after") states the
      // current branch too; a prohibition ("no mortgage shall have had a loan application date
      // prior to June 1, 2009") is a rule in force, not a past scope.
      if (/\b(?:on or after|after)\s+[A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4}/.test(win)) continue;
      if (/\b(?:no|not|never|nor)\b/i.test(win.slice(Math.max(0, m.index - 100), m.index))) continue;
    }
    if (!best || m.index < best.index) best = { index: m.index, text: m[0] };
  }
  if (!best) return null;
  // Up to 6 words before the date clause, back to a clause boundary or a stop word.
  const words = win.slice(Math.max(0, best.index - 120), best.index).split(" ").filter(Boolean);
  const lead = [];
  for (let i = words.length - 1; i >= 0 && lead.length < 6; i--) {
    const w = words[i];
    if (/[.;:)]$/.test(w) || /^\(/.test(w) || STOP.has(w.toLowerCase())) break;
    lead.unshift(w);
  }
  return cap([...lead, best.text].join(" ").replace(/[,:;]$/, ""), 140);
}

export function historicalLabel(scope) {
  return `[Historical/limited scope: applies to ${scope}]`;
}

// Whether the query itself asks about a period: names a year HIST_YEARS+ ago.
export function queryNamesPast(query, now = Date.now()) {
  const year = new Date(now).getUTCFullYear();
  return (String(query ?? "").match(/\b(19|20)\d{2}\b/g) ?? []).some((y) => Number(y) <= year - HIST_YEARS);
}
