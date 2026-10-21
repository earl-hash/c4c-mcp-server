// CHAPTER / DOCUMENT DIGEST (batch 18, 2026-10-02; live A/B test): "va handbook chapter 4" gave
// the model only the chapter's table of contents (no 41% DTI rule, no residual income table),
// and "appendix f-1 urar reference guide" only its version line and revision history. When
// lookup_citation or search_regs resolves to a chapter, a multi-part chapter register or a
// whole-document register, the inline text is a bounded "key rules" digest instead:
//
//   chapter index   (only a "-chapter"/"-index" heading obligation; the rules are in child
//                   registers: VA M26-7 topics, Freddie chapter sections) -> the best passage
//                   of each child, the strongest children first, until DIGEST_CHARS.
//   chapter         (a register titled "Chapter N" holding several parts, e.g. gnma-mbs-ch18)
//                   -> its purpose/overview paragraph, then the best passage of each part.
//   whole document  (one obligation over DOC_MIN_CHARS, e.g. the URAR Appendix F-1 guide)
//                   -> its purpose/scope paragraph(s) and its contents headings.
//
// A passage's strength is mechanical: figures (percent, dollars, periods), mandatory words
// (must, may not, required ...) and rule words (ratio, limit, minimum ...); revision notes,
// change dates and table-of-contents leaders count against it. Every piece is a verbatim
// slice of the stored text with its citation, obligation_id and offset -- never paraphrased.
import { canonicalCitation } from "./canonical.js";
import { obligationType } from "./tools/search.js";
import {
  currencyLead, fetchCurrencyRows, historicalLabel, historicalScope, leadsText, pieceTag, queryNamesPast, withLead,
} from "./currency-lead.js";

export const DIGEST_CHARS = 3000;
export const DOC_MIN_CHARS = 50000;
const PIECE_MIN = 220;
const PIECE_MAX = 650;
const CHILD_MAX = 40;

const SENT = /(?<=[.;:])\s+(?=[A-Z(“"\d$•])/g;
const PCT = /\d(?:[\d.,]*)\s?(?:%|percent\b)/gi;
const DOLLAR = /\$\s?\d[\d,]*/g;
const PERIOD = /\b(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s*(?:\(\d+\)\s*)?(?:calendar\s+|business\s+|consecutive\s+)?(?:days?|months?|years?)\b/gi;
const MODAL = /\b(?:must|shall|may not|must not|cannot|is required|are required|will not|not eligible|ineligible|prohibited|may only)\b/i;
const RULE = /\b(?:ratio|limit|maximum|minimum|threshold|residual income|eligib\w*|requires?)\b/i;
const NOISE = /\.{4,}|Page \d+ of \d+|Change Date|revised in its entirety|Revision History|\bVersion \d|©|Trademarks?\b/i;
const POINTER = /\b(?:refer to|see (?:Chapter|Topic|Section)|described in|listed in)\b/i;
const PURPOSE_STRONG = /\b(?:The (?:primary )?purpose of\b|is intended to (?:provide|describe))/g;
const PURPOSE = /\bThis (?:document|guide|chapter|handbook|appendix|part) (?:describes|provides|contains|sets forth|establishes|explains|covers)\b/g;
// Batch 19: core-rule pieces before side examples. A sentence naming the basic / general
// requirements, or heading the above-threshold tier of a table ("$80,000 and Above" -- the tier
// the typical loan falls in), gains; a worked example loses. A part whose title names a core
// topic (or whose passage is a ratio / residual-income rule) is preferred over its siblings.
const CORE_SENT = /\b(?:Basic|General) Requirements?\b/;
const TIER_UP = /\$\d[\d,]* and (?:Above|Over)\b/i;
const EXAMPLE = /\bExamples?\b|\bfor example\b|\bStep Procedure\b/i;
const CORE_TITLE = /\b(?:requirements?|general|eligib\w*|ratios?|residual|limits?|documentation)\b/i;
const CORE_TEXT = /\b(?:ratio|residual income)\b/i;
const INTRO = /\bIntroduction\s+(?=(?:The|This|These|A|An)\s)/g;

const DOC_TITLE = /\b(?:Reference|Implementation|Style) Guide\b|\bAppendix [A-Z]+-?\d/i;

const count = (s, re) => Math.min((s.match(re) ?? []).length, 12);

export function sentenceScore(s) {
  if (NOISE.test(s)) return -6;
  let n = 3 * Math.min(count(s, PCT), 3) + Math.min(count(s, DOLLAR), 10) + 2 * Math.min(count(s, PERIOD), 2);
  if (MODAL.test(s)) n += 2;
  if (RULE.test(s)) n += 1;
  if (POINTER.test(s)) n -= 1;
  if (s.length < 60) n -= 1;
  if (CORE_SENT.test(s)) n += 3;
  if (TIER_UP.test(s)) n += 2;
  if (EXAMPLE.test(s)) n -= 6;
  return n;
}

function sentences(text) {
  const out = [];
  let start = 0;
  for (const m of text.matchAll(SENT)) {
    out.push([start, m.index]);
    start = m.index + m[0].length;
  }
  out.push([start, text.length]);
  return out.filter(([s, e]) => e > s);
}

// End a piece on a word boundary at most `max` chars after `start`.
function cut(text, start, end, max) {
  if (end - start <= max) return end;
  const sp = text.lastIndexOf(" ", start + max);
  return sp > start + max / 2 ? sp : start + max;
}

// The best-scoring passages of one text: [{ offset, chars, score }], best first, disjoint.
export function keyPassages(text, maxPieces = 2) {
  const sents = sentences(text);
  const scored = sents.map(([s, e], i) => ({ i, s, e, score: sentenceScore(text.slice(s, e)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const out = [];
  for (const x of scored) {
    if (out.length >= maxPieces) break;
    let end = x.e;
    for (let j = x.i + 1; j < sents.length && end - x.s < PIECE_MIN; j++) {
      if (NOISE.test(text.slice(sents[j][0], sents[j][1]))) break;
      end = sents[j][1];
    }
    end = cut(text, x.s, end, PIECE_MAX);
    if (out.some((p) => x.s < p.offset + p.chars && end > p.offset)) continue;
    out.push({ offset: x.s, chars: end - x.s, score: x.score });
  }
  return out;
}

// The purpose / scope paragraph of a document (not a table-of-contents line).
export function purposePassage(text, max = 900, re = PURPOSE) {
  for (const m of text.matchAll(re)) {
    // Not a table-of-contents entry (dot leaders right after it).
    if (/\.{4,}/.test(text.slice(m.index, m.index + 120))) continue;
    const before = text.slice(Math.max(0, m.index - 300), m.index);
    const dot = Math.max(before.lastIndexOf(". "), -1);
    const start = re === INTRO ? m.index + m[0].length
      : dot >= 0 && m[0].startsWith("is intended") ? m.index - before.length + dot + 2 : m.index;
    return { offset: start, chars: cut(text, start, text.length, max) - start };
  }
  return null;
}

// Contents headings from a dot-leader table of contents ("01 Summary ....... 26"), verbatim.
export function contentsHeadings(text, max = 40) {
  const head = text.slice(0, 60000);
  const out = [];
  for (const m of head.matchAll(/([A-Z0-9][^.\n]{1,80}?)\s*\.{5,}\s*\d{1,4}/g)) {
    const h = m[1].trim();
    if (h.length > 2 && !/Table of Contents/i.test(h) && !out.includes(h)) out.push(h);
    if (out.length >= max) break;
  }
  return out;
}

async function registerRows(env, sql, ...args) {
  const { results } = await env.CORPUS.prepare(sql).bind(...args).all();
  return results ?? [];
}

const OBL_SQL = "SELECT o.obligation_id, o.register_id, o.section, o.authority, o.verbatim, " +
  "r.authority AS register_title FROM obligations o JOIN registers r ON r.register_id = o.register_id ";

function cite(row) {
  try { return canonicalCitation(row) ?? row.register_id; } catch { return row.register_id; }
}

// The kind of document-level register this is, from its obligations; null for an ordinary one.
export function digestKind(registerId, authority, obligations) {
  const rules = obligations.filter((o) => !obligationType(o.obligation_id));
  const idx = obligations.filter((o) => obligationType(o.obligation_id) === "index");
  if (!rules.length && idx.length) return "chapter_index";
  // A whole guide / appendix held as one (or a few) very long obligations -- not a handbook
  // section that happens to be long (FHA 4000.1 sections keep their own passages).
  if (rules.length && rules.length <= 4 && Math.max(...rules.map((r) => Number(r.chars ?? 0))) >= DOC_MIN_CHARS &&
      (DOC_TITLE.test(authority ?? "") || /-guide$|appendix/.test(registerId))) return "document";
  if (rules.length >= 3 && (/\bChapter \d/i.test(authority ?? "") || /-ch\d+$/.test(registerId)) &&
      !/§|CFR|U\.S\.C/.test(authority ?? "")) return "chapter";
  return null;
}

// The digest for one register: { digest_kind, operative_text, digest_pieces, child_ids, ... } or null.
export async function buildDigest(env, registerId, opts = {}) {
  try {
    const reg = (await registerRows(env, "SELECT register_id, authority FROM registers WHERE register_id = ?1", registerId))[0];
    if (!reg) return null;
    const obls = await registerRows(env, "SELECT obligation_id, length(verbatim) AS chars FROM obligations " +
      "WHERE register_id = ?1 ORDER BY rowid", registerId);
    const kind = digestKind(registerId, reg.authority, obls);
    if (!kind) return null;
    let children = [];
    let rows = [];
    if (kind === "chapter_index") {
      children = opts.topicIds?.length ? opts.topicIds : (await registerRows(env,
        "SELECT register_id FROM registers WHERE register_id LIKE ?1 || '-%' AND register_id NOT LIKE '%superseded%' " +
        "AND COALESCE(status, '') <> 'superseded' ORDER BY register_id LIMIT ?2", registerId, CHILD_MAX))
        .map((r) => r.register_id);
      if (!children.length) return null;
      rows = await registerRows(env, OBL_SQL + `WHERE o.register_id IN (SELECT value FROM json_each(?1)) ORDER BY o.rowid`,
        JSON.stringify(children));
      rows = rows.filter((r) => !obligationType(r.obligation_id) && !/::update-18$/.test(r.obligation_id));
      const order = new Map(children.map((c, i) => [c, i]));
      rows.sort((a, b) => (order.get(a.register_id) ?? 0) - (order.get(b.register_id) ?? 0));
    } else {
      rows = (await registerRows(env, OBL_SQL + "WHERE o.register_id = ?1 ORDER BY o.rowid", registerId))
        .filter((r) => !obligationType(r.obligation_id) && !/::update-18$/.test(r.obligation_id));
      children = rows.map((r) => r.obligation_id);
    }
    const budget = opts.budget ?? DIGEST_CHARS;
    const now = opts.now ?? Date.now();
    const pastOk = queryNamesPast(opts.query, now);
    const pieces = [];
    let used = 0;
    const add = (row, p, label) => {
      const text = String(row.verbatim).slice(p.offset, p.offset + p.chars).replace(/\s+/g, " ").trim();
      if (!text || used + text.length > budget) return false;
      pieces.push({ canonical_citation: cite(row), obligation_id: row.obligation_id, offset: p.offset,
        chars: p.chars, ...(label ? { role: label } : {}), ...(p.hist ? { historical_scope: p.hist } : {}), text });
      used += text.length + 40;
      return true;
    };
    // Purpose / scope first (chapter and whole-document registers).
    // A whole document: its introduction and purpose statement (the rest is its contents list).
    if (kind !== "chapter_index") {
      const res = kind === "document" ? [INTRO, PURPOSE_STRONG, PURPOSE] : [PURPOSE_STRONG, PURPOSE];
      const want = kind === "document" ? 2 : 1;
      let found = 0;
      for (const re of res) {
        if (found >= want) break;
        for (const row of rows) {
          const p = purposePassage(String(row.verbatim), kind === "document" ? 1100 : 700, re);
          if (p && !pieces.some((q) => q.obligation_id === row.obligation_id &&
              p.offset < q.offset + q.chars && p.offset + p.chars > q.offset) && add(row, p, "purpose")) {
            found++;
            break;
          }
        }
      }
    }
    // Then the strongest passage of each part, strongest parts first.
    // A whole document without a stated purpose keeps the ordinary inline text.
    if (kind === "document" && !pieces.length) return null;
    // Batch 22: a passage the text scopes to a past period ("securities issued between August 1
    // and December 1, 2002") yields to the part's next-best passage; shown only when the part
    // has no other -- last, and labelled -- unless the query names that period.
    const best = (text, want) => {
      const all = keyPassages(text, want + 3).map((p) => ({ ...p, hist: historicalScope(text, p.offset, p.chars, now) }));
      if (pastOk) return all.slice(0, want);
      const cur = all.filter((p) => !p.hist);
      return cur.length ? cur.slice(0, want) : all.slice(0, want).map((p) => ({ ...p, late: true }));
    };
    const per = (kind === "document" ? [] : rows)
      .map((row, i) => ({ row, i, best: best(String(row.verbatim), kind === "document" ? 3 : 1) }))
      .flatMap((x) => x.best.map((p, k) => ({ ...x, p, k: p.late ? 9 : k })))
      .filter((x) => !pieces.some((q) => q.obligation_id === x.row.obligation_id &&
        x.p.offset < q.offset + q.chars && x.p.offset + x.p.chars > q.offset))
      .map((x) => {
        const title = String((kind === "chapter_index" ? x.row.register_title : x.row.section) ?? "");
        const text = String(x.row.verbatim).slice(x.p.offset, x.p.offset + x.p.chars);
        const figures = PCT.test(text) || DOLLAR.test(text);
        PCT.lastIndex = 0; DOLLAR.lastIndex = 0;
        return { ...x, w: x.p.score + (CORE_TITLE.test(title.replace(/^.*?—/, "")) || CORE_TEXT.test(text) ? 3 : 0) +
          (figures ? 2 : 0) };
      })
      .sort((a, b) => a.k - b.k || b.w - a.w || a.i - b.i);
    // A passage whose figures all appear in an earlier pick adds nothing ("120 days old" in
    // three topics): skipped.
    const seen = new Set();
    const figs = (t) => (t.match(/\$?\d[\d,.]*%?/g) ?? []).map((f) => f.replace(/[.,]$/, ""));
    for (const x of per) {
      if (used >= budget - PIECE_MIN) break;
      const f = figs(String(x.row.verbatim).slice(x.p.offset, x.p.offset + x.p.chars));
      if (f.length && f.every((v) => seen.has(v))) continue;
      if (add(x.row, x.p, null)) f.forEach((v) => seen.add(v));
    }
    const order = new Map(rows.map((r, i) => [r.obligation_id, i]));
    pieces.sort((a, b) => Number(b.role === "purpose") - Number(a.role === "purpose") ||
      order.get(a.obligation_id) - order.get(b.obligation_id) || a.offset - b.offset);
    if (!pieces.length) return null;
    const contents = kind === "document" ? contentsHeadings(String(rows[0]?.verbatim ?? "")) : [];
    // Batch 22: the register's / its parts' active currency leads the text, and each piece in an
    // amended part (or child register) carries its signal's first clause.
    const cur = await fetchCurrencyRows(env, [registerId, ...(kind === "chapter_index" ? children : [])],
      rows.map((r) => r.obligation_id));
    const regOf = new Map(rows.map((r) => [r.obligation_id, r.register_id]));
    const ownCur = (p) => cur.find((c) => c.obligation_id === p.obligation_id) ??
      (kind === "chapter_index" ? cur.find((c) => c.register_id && c.register_id === regOf.get(p.obligation_id)) : null);
    for (const p of pieces) {
      const c = ownCur(p);
      if (c && leadsText(c, now)) p.currency = pieceTag(c.headline);
    }
    const scoped = (c) => {
      if (c.register_id === registerId) return c;
      const row = rows.find((r) => (c.obligation_id ? r.obligation_id === c.obligation_id : r.register_id === c.register_id));
      return row ? { ...c, scope: cite(row) } : c;
    };
    const lead = currencyLead([...cur.filter((c) => c.register_id === registerId),
      ...pieces.map(ownCur).filter(Boolean), ...cur].map(scoped), now);
    const line = (p) => `[${p.canonical_citation}] ${p.currency ? `(CURRENCY: ${p.currency}) ` : ""}` +
      `${p.historical_scope ? `${historicalLabel(p.historical_scope)} ` : ""}${p.text}`;
    return {
      digest_kind: kind,
      operative_text: withLead(pieces.map(line).join("\n\n"), lead),
      operative_text_truncated: true,
      digest_pieces: pieces.map(({ text: _t, ...p }) => p),
      ...(kind === "chapter_index" ? { child_ids: children } : kind === "chapter" ? { child_ids: children } : {}),
      ...(contents.length ? { contents } : {}),
      operative_note: DIGEST_NOTE,
    };
  } catch {
    return null;
  }
}

export const DIGEST_NOTE = "Key-rules digest of a chapter or whole document: verbatim passages " +
  "(each prefixed [citation]; digest_pieces gives obligation_id and offset) chosen for their " +
  "figures and mandatory language, plus its purpose/scope where stated -- not the whole text. " +
  "Quote with the bracketed citation; child_ids / find_in_section / get_obligation for the rest. " +
  "A leading CURRENCY line is the server's currency signal, not regulator text.";
