// INLINE OPERATIVE TEXT (batch 17, 2026-10-02; OpenAI neutral A/B test): gpt-4o made one
// search_regs call in 30 of 40 answers, opened full text 3 times and answered from snippets --
// often from the wrong hit ("fannie mae other income" answered from rental income). A model
// that calls ONE tool and stops must get the rule in that one response:
//
//   search_regs     on a confident top result (all_terms with a clear margin over #2, or a
//                   citation-anchored hit) the top row carries `operative_text`: the verbatim
//                   passages of the section that hold the query's words (find_in_section's
//                   passage logic), best first, bounded. Not confident but the top row
//                   matches every term: the top TWO all_terms rows carry it, smaller each.
//                   Every row's `excerpt` is cut from its best-matching passage, not the
//                   section opening or its table of contents.
//   lookup_citation a register with one governing obligation (or a statute section split into
//                   short paragraphs) carries that text inline; a cite pinned to one paragraph
//                   carries the paragraph. `obligations` lists the register's obligation ids
//                   (gpt-4o passed the register_id to get_obligation and got not_found, N37).
//
// Text is never paraphrased: pieces are verbatim slices of the section, joined by "\n[...]\n"
// where text between them is omitted; `operative_spans` gives each piece's [offset, chars] in
// the section (get_obligation offsets).
import { findPassages } from "./tools/find.js";
import { obligationType } from "./tools/search.js";
import { buildDigest, DIGEST_NOTE } from "./digest.js";
import {
  currencyLead, fetchCurrencyRows, historicalLabel, historicalScope, leadsText, queryNamesPast, withLead,
} from "./currency-lead.js";

export const INLINE_SOLO_CHARS = 3000;
export const INLINE_ROW_CHARS = 2000;
export const INLINE_TOTAL_CHARS = 4000;
export const CONFIDENT_RATIO = 1.4;
export const EXCERPT_CHARS = 320;
export const LOOKUP_INLINE_CHARS = 4000;
// A register split into paragraphs is "one rule" for lookup_citation when its rule text
// together is at most this long (a statute section, not a handbook chapter).
export const LOOKUP_SPLIT_MAX_CHARS = 12000;
export const LOOKUP_LIST_MAX = 30;
const GAP = "\n[...]\n";

// The find_in_section terms for a search query: the phrase (2-4 words) first, then each word.
export function inlineTerms(tokens) {
  const t = [...new Set((tokens ?? []).filter((x) => /[a-z0-9]/i.test(x)))];
  return [...(t.length >= 2 && t.length <= 4 ? [t.join(" ")] : []), ...t].slice(0, 6);
}

// Cut [start, end) of text to at most max chars, ending on a sentence (else word) boundary.
function cutTo(text, start, end, max) {
  if (end - start <= max) return { start, end };
  const piece = text.slice(start, start + max);
  const sent = Math.max(piece.lastIndexOf(". "), piece.lastIndexOf(".\n"), piece.lastIndexOf("; "));
  const word = piece.lastIndexOf(" ");
  const cut = sent > max * 0.5 ? sent + 1 : word > max * 0.5 ? word : max;
  return { start, end: start + cut };
}

function ranked(row, terms) {
  if (!row?.verbatim || !terms.length) return [];
  let out;
  try { out = findPassages(row, terms, 8); } catch { return []; }
  return (out.passages ?? [])
    .map((p, i) => ({ ...p, i }))
    .sort((a, b) => b.matched_terms.length - a.matched_terms.length ||
      // At equal coverage a table first: it holds the figures (waiting periods, limits).
      Number(Boolean(b.table)) - Number(Boolean(a.table)) || a.i - b.i);
}

// Verbatim operative text for one section: whole when it fits, else its best passages.
export function operativeText(row, terms, budget, now = Date.now()) {
  const text = String(row?.verbatim ?? "");
  if (!text.trim()) return null;
  if (text.length <= budget) {
    return { operative_text: text, operative_text_truncated: false, char_count: text.length,
      operative_spans: [[0, text.length]] };
  }
  const spans = [];
  let used = 0;
  // Batch 22: passages the text scopes to a past period go after the rest (unless the query
  // names that period) and are labelled with their own scope words.
  const pastOk = queryNamesPast(terms.join(" "), now);
  const cands = ranked(row, terms).map((p) => ({ ...p, hist: historicalScope(text, p.offset, p.chars, now) }));
  const hist = new Map();
  for (const p of pastOk ? cands : [...cands.filter((x) => !x.hist), ...cands.filter((x) => x.hist)]) {
    const room = budget - used - (spans.length ? GAP.length : 0);
    if (room < 200) break;
    if (spans.some(([s, e]) => p.offset < e && p.offset + p.chars > s)) continue;
    const { start, end } = cutTo(text, p.offset, p.offset + p.chars, room);
    spans.push([start, end]);
    if (p.hist) hist.set(start, p.hist);
    used += end - start + (spans.length > 1 ? GAP.length : 0);
  }
  if (!spans.length) spans.push(Object.values(cutTo(text, 0, text.length, budget)));
  spans.sort((a, b) => a[0] - b[0]);
  const body = spans.map(([s, e]) => (hist.has(s) ? `${historicalLabel(hist.get(s))} ` : "") +
    text.slice(s, e).trim()).join(GAP);
  return { operative_text: body, operative_text_truncated: true, char_count: text.length,
    operative_spans: spans.map(([s, e]) => [s, e - s]) };
}

// A ~EXCERPT_CHARS window of the best-matching passage, centred on its first term hit.
export function passageExcerpt(row, terms) {
  const best = ranked(row, terms)[0];
  if (!best) return null;
  const text = String(row.verbatim);
  const body = text.slice(best.offset, best.offset + best.chars);
  let hit = -1;
  for (const t of terms) {
    const at = body.toLowerCase().indexOf(String(t).toLowerCase());
    if (at >= 0 && (hit < 0 || at < hit)) hit = at;
  }
  let s = best.offset + Math.max(0, (hit < 0 ? 0 : hit) - 80);
  let e = Math.min(best.offset + best.chars, s + EXCERPT_CHARS);
  if (e - s < EXCERPT_CHARS) s = Math.max(best.offset, e - EXCERPT_CHARS);
  if (s > best.offset) { const sp = text.indexOf(" ", s); if (sp > 0 && sp < s + 30) s = sp + 1; }
  if (e < best.offset + best.chars) { const sp = text.lastIndexOf(" ", e); if (sp > s + 100) e = sp; }
  const out = text.slice(s, e).replace(/\s+/g, " ").trim();
  return (s > 0 ? "..." : "") + out + (e < text.length ? "..." : "");
}

export async function fetchVerbatim(env, ids) {
  if (!ids.length) return new Map();
  const { results } = await env.CORPUS
    .prepare(`SELECT obligation_id, register_id, authority, section, verbatim FROM obligations ` +
      `WHERE obligation_id IN (${ids.map((_, i) => `?${i + 1}`).join(", ")})`)
    .bind(...ids).all();
  return new Map((results ?? []).map((r) => [r.obligation_id, r]));
}

// Which shaped search rows get operative text, and how much each: [[index, budget], ...].
export function inlinePlan(results, citedIds) {
  const top = results[0];
  if (!top || top.section_status || top.obligation_type) return [];
  const anchored = citedIds?.length && citedIds.includes(top.register_id);
  if (!anchored && top.match !== "all_terms") return [];
  const second = results[1];
  const clear = !second || second.match !== "all_terms" ||
    (top.rank_score ?? 0) >= CONFIDENT_RATIO * (second.rank_score ?? 0);
  if (anchored || clear) return [[0, INLINE_SOLO_CHARS]];
  const pick = [0];
  const j = results.findIndex((r, i) => i > 0 && r.match === "all_terms" && !r.section_status &&
    !r.obligation_type && r.register_id !== top.register_id);
  if (j > 0 && j <= 2) pick.push(j);
  return pick.map((i) => [i, pick.length > 1 ? INLINE_ROW_CHARS : INLINE_SOLO_CHARS]);
}

// search_regs: better excerpts on every row, operative text on the confident top row(s).
export async function withInlineText(env, results, tokens, citedIds) {
  const terms = inlineTerms(tokens);
  if (!terms.length || !results.length) return { results, inlined: false };
  let rows;
  try { rows = await fetchVerbatim(env, results.map((r) => r.obligation_id)); } catch {
    return { results, inlined: false };
  }
  const plan = new Map(inlinePlan(results, citedIds));
  let total = 0;
  const out = results.map((r, i) => {
    const row = rows.get(r.obligation_id);
    if (!row) return r;
    const excerpt = passageExcerpt(row, terms) ?? r.excerpt;
    const budget = plan.has(i) ? Math.min(plan.get(i), INLINE_TOTAL_CHARS - total) : 0;
    const op = budget >= 500 ? operativeText(row, terms, budget) : null;
    if (op) total += op.operative_text.length;
    // Batch 22: the row's active currency leads its operative text (src/currency-lead.js).
    const lead = op ? currencyLead([r.currency].filter(Boolean)) : "";
    if (lead) op.operative_text = withLead(op.operative_text, lead);
    const out = { ...r, excerpt, ...(op ?? {}) };
    return lead ? hoistKeys(out, "obligation_id", ["operative_text"]) : out;
  });
  return { results: out, inlined: total > 0 };
}

export const INLINE_NOTE = "operative_text on the top result(s) is the section's verbatim text " +
  "(whole, or the passages holding the query's words; [...] marks omitted text; " +
  "operative_spans = [offset, chars]). Quote it with its canonical_citation and currency; " +
  "get_obligation for the full section.";

// lookup_citation: the governing obligation's text inline, and the register's obligation ids.
// The first words of a section's verbatim text (whitespace collapsed), cut at a word
// boundary near OPENING_CHARS and marked with "..." when cut.
export const OPENING_CHARS = 160;
export function openingWords(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= OPENING_CHARS) return t;
  const cut = t.slice(0, OPENING_CHARS);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > OPENING_CHARS * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:]$/, "")}...`;
}

export async function withCitationText(env, result) {
  if (!result?.register_id || result.error) return result;
  try {
    const { results } = await env.CORPUS
      .prepare("SELECT obligation_id, section, verbatim FROM obligations WHERE register_id = ?1 ORDER BY rowid")
      .bind(result.register_id).all();
    const all = results ?? [];
    if (!all.length) return result;
    const rules = all.filter((r) => !obligationType(r.obligation_id));
    const pinned = result.obligation_id && all.find((r) => r.obligation_id === result.obligation_id);
    let inline = null;
    // Batch 18: a chapter, chapter index or whole-document register gets its key-rules digest
    // (src/digest.js) -- not its heading line, table of contents or revision history.
    const digest = !pinned || obligationType(pinned.obligation_id) === "index" || rules.length === 1
      ? await buildDigest(env, result.register_id, { topicIds: (result.topics ?? []).map((t) => t.register_id) })
      : null;
    if (digest) {
      const { child_ids: childIds, ...rest } = digest;
      // child ids only where nothing else lists them (`topics`, or `obligations` below).
      inline = { ...rest, ...(result.topics?.length || all.length > 1 || !childIds ? {} : { child_ids: childIds }) };
    } else if (pinned) inline = joinRules([pinned]);
    else if (rules.length === 1) inline = joinRules(rules);
    else if (rules.length > 1 && rules.reduce((n, r) => n + (r.verbatim ?? "").length, 0) <= LOOKUP_SPLIT_MAX_CHARS) {
      inline = joinRules(rules, true);
    }
    // Batch 22: the register's / the shown obligation's active currency leads the inline text
    // (a digest already carries its own lead).
    if (inline?.operative_text && !digest) {
      const shown = pinned ? [pinned] : rules.length === 1 ? rules : inline ? rules : [];
      const cur = await fetchCurrencyRows(env, [result.register_id], shown.map((r) => r.obligation_id));
      const own = shown.length === 1 ? cur.find((c) => c.obligation_id === shown[0].obligation_id) : null;
      // An obligation's own row replaces its register's (src/currency.js withObligationCurrency).
      const lead = currencyLead(own ? [own] : [...cur.filter((c) => c.register_id), ...cur.filter((c) => c.obligation_id)]);
      if (lead) inline = { ...inline, operative_text: withLead(inline.operative_text, lead) };
    }
    // No text block (a long multi-section register): its active signal still comes first.
    let regCurrency = null;
    if (!inline?.operative_text) {
      const c = (await fetchCurrencyRows(env, [result.register_id])).find((x) => leadsText(x));
      if (c) regCurrency = { kind: c.kind, headline: c.headline };
    }
    const out = {
      ...result,
      ...(all.length > 1 ? {
        // No text block (a long multi-section rule, e.g. 12 CFR 1026.43): each subsection carries
        // its opening words, the regulator's own heading, so "pull up 1026.43" gets an outline,
        // not bare numbers (Microsoft reviewer's test, 2026-10-05).
        obligations: all.slice(0, LOOKUP_LIST_MAX).map((r) => ({ obligation_id: r.obligation_id, section: r.section,
          ...(inline?.operative_text ? {} : { opening: openingWords(r.verbatim) }) })),
        ...(all.length > LOOKUP_LIST_MAX ? { obligations_total: all.length } : {}),
      } : { obligation_id: result.obligation_id ?? all[0].obligation_id }),
      ...(inline ?? {}),
    };
    if (regCurrency) return hoistKeys({ ...out, currency: regCurrency }, "register_id", ["currency"]);
    return /^CURRENCY[ :(]/.test(out.operative_text ?? "") ? hoistKeys(out, "register_id", ["operative_text"]) : out;
  } catch {
    return result;
  }
}

// `obj` with `keys` moved to right after `anchor` (key order is what a model reads first;
// batch 22 puts a currency-led text block within the first few hundred chars).
export function hoistKeys(obj, anchor, keys) {
  if (!obj || !(anchor in obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (keys.includes(k)) continue;
    out[k] = v;
    if (k === anchor) for (const m of keys) if (m in obj) out[m] = obj[m];
  }
  return out;
}

function joinRules(rows, labelled = false) {
  let used = 0;
  const parts = [];
  let truncated = false;
  let chars = 0;
  for (const r of rows) {
    const t = String(r.verbatim ?? "").trim();
    chars += t.length;
    if (truncated) continue;
    const piece = labelled ? `${r.section}\n${t}` : t;
    const room = LOOKUP_INLINE_CHARS - used - (parts.length ? 2 : 0);
    if (piece.length <= room) { parts.push(piece); used += piece.length + (parts.length > 1 ? 2 : 0); continue; }
    if (room >= 300) parts.push(piece.slice(0, cutTo(piece, 0, piece.length, room).end));
    truncated = true;
  }
  if (!parts.length) return null;
  return {
    operative_text: parts.join("\n\n"), operative_text_truncated: truncated, char_count: chars,
    ...(rows.length === 1 ? { operative_obligation_id: rows[0].obligation_id } : {}),
    operative_note: (labelled ? "Each paragraph's verbatim text under its section title. " : "Verbatim text. ") +
      (truncated ? "Truncated: get_obligation (an id from `obligations`) for the rest." : "Complete."),
  };
}

// Batch 18: search_regs on a chapter / whole document. A bare citation of a chapter ("va
// handbook chapter 4") or a query that is only a document's own title ("appendix f-1 urar
// reference guide") gets that register's key-rules digest (src/digest.js): on the top row
// when the top row is that register, else as `digest` beside the results (the other rows then
// keep their excerpts but not their own operative_text -- the question is about the whole).
export async function withSearchDigest(env, out, { cited, tokens }) {
  const rows = out.results ?? [];
  const top = rows[0];
  if (!top) return out;
  let id = null;
  if (cited?.citationOnly && cited.ids?.length) id = cited.ids[0];
  else {
    const words = [...new Set((tokens ?? []).map((t) => String(t).toLowerCase()).filter((t) => /[a-z0-9]/.test(t)))];
    const title = ` ${String(top.authority ?? top.section ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
    if (words.length >= 2 && words.every((w) => title.includes(` ${w.replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `))) id = top.register_id;
  }
  if (!id) return out;
  const digest = await buildDigest(env, id, { query: (tokens ?? []).join(" ") });
  if (!digest) return out;
  const strip = ({ operative_text: _a, operative_text_truncated: _b, char_count: _c, operative_spans: _d, ...r }) => r;
  if (top.register_id === id) {
    const first = { ...strip(top), ...digest };
    return { ...out, results: [/^CURRENCY[ :(]/.test(digest.operative_text) ? hoistKeys(first, "obligation_id", ["operative_text"]) : first,
      ...rows.slice(1).map(strip)],
      inline_note: DIGEST_NOTE };
  }
  const { operative_note: _n, ...d } = digest;
  // A currency-led digest goes first, ahead of the result list.
  const digestFirst = /^CURRENCY[ :(]/.test(d.operative_text) ? { digest: { register_id: id, ...d } } : {};
  return { ...digestFirst, ...out, results: rows.map(strip), digest: { register_id: id, ...d }, inline_note: DIGEST_NOTE };
}
