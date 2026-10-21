import { z } from "zod";
import { MAX_CHARS, provenance } from "../envelope.js";
import { VOCAB } from "../vocab.js";
import { contentTokens, ftsTokens } from "./search.js";
import { aliasNote, fetchObligationRow } from "./get.js";
import { dualVersionIds, fetchVersions } from "../versions.js";
import { passageCitation } from "../canonical.js";
import { reconstructGrid } from "../tables.js";

// find_in_section: the verbatim paragraphs of ONE obligation that contain the caller's
// terms. Why: the owner's claude.ai test ("fha requirements for underwriting refinances")
// read the 36,755-char II.A.8.d section in 24k pages, "took forever", and still answered
// in paraphrase. A model that needs "the credit score rule for a cash-out refinance" wants
// three paragraphs, not two pages. Every passage is an exact slice of the stored verbatim
// text -- never rewritten, only cut at paragraph boundaries -- with its char offset, so it
// can be quoted and checked with verify_quote like any other excerpt.

export const MAX_TERMS = 6;
export const MAX_TERM_CHARS = 60;
export const DEFAULT_PASSAGES = 8;
export const MAX_PASSAGES = 20;
// A unit longer than this is cut at sentence boundaries: eCFR and some guide text arrive as
// one unbroken line, and returning a 20k-char "paragraph" would defeat the tool.
export const MAX_UNIT_CHARS = 1500;
const PACK_CHARS = 900;
// A colon-ended passage grows by the list it introduces up to this many chars (Round 4).
export const LIST_MAX_CHARS = 3000;
// Room left under MAX_CHARS for provenance, currency and per-passage fields.
const PASSAGE_BUDGET = MAX_CHARS - 4000;

// A line that opens a new paragraph: a list marker -- "(A)", "(1)", "(iv)", "a.", "iv.",
// "12." -- or a bullet glyph. Letters are single, or roman numerals, so "No. 5" or "U.S."
// at the start of a wrapped line is not mistaken for one.
const MARKER =
  /^\s*(?:\((?:[ivxlcdm]{1,6}|[IVXLCDM]{1,6}|[A-Za-z]|\d{1,3})\)|(?:[ivxlcdm]{1,6}|[IVXLCDM]{1,6}|[A-Za-z]|\d{1,3})\.(?=\s)|[•▪■●◦‣⁃·*-](?=\s))/u;

// Sentence boundary inside an over-long unit: end punctuation, whitespace, then a capital,
// an opening parenthesis/quote or a digit.
const SENTENCE = /(?<=[.;:])\s+(?=[A-Z(“"\d])/g;

function span(text, start, end) {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { start, end };
}

// Cut [start, end) at sentence boundaries into pieces of about PACK_CHARS.
function packSentences(text, start, end) {
  const cuts = [start];
  const body = text.slice(start, end);
  SENTENCE.lastIndex = 0;
  let m;
  while ((m = SENTENCE.exec(body)) !== null) cuts.push(start + m.index + m[0].length);
  cuts.push(end);
  const out = [];
  let from = cuts[0];
  for (let i = 1; i < cuts.length; i++) {
    const next = cuts[i + 1];
    if (next === undefined || next - from > PACK_CHARS) {
      out.push(span(text, from, cuts[i]));
      from = cuts[i];
    }
  }
  return out.filter((u) => u.end > u.start);
}

// A unit that is one short marker line with no closing punctuation ("(A) Definition",
// "i. Overview") is a heading: the capitalized line after it starts a new paragraph. The
// marker is required so a short wrapped line of prose is never taken for a heading.
// Batch 5 (stress4 Q2): a bullet item is list text, never a heading, and a line ending on a
// function word ("... expected to follow 2S when a") is a wrapped sentence -- treating it as a
// heading split "Status Code 73 ... when a" from "Borrower redeems the Property ...".
const TRAILING_FUNCTION_WORD =
  /\b(?:a|an|the|of|and|or|to|for|in|on|at|by|with|from|when|if|that|which|as|is|are|be|must|may|will|not|than|under|into)$/i;
function isHeadingLine(t, u) {
  const s = t.slice(u.start, u.end).trim();
  return s.length <= 80 && !s.includes("\n") && !/[.;:,]$/.test(s) && MARKER.test(s) &&
    !/^\s*[•▪■●◦‣⁃·*-]\s/u.test(s) && !TRAILING_FUNCTION_WORD.test(s);
}

// Paragraph units of the verbatim text, as [start, end) offsets into it. A new unit starts
// at a blank line, a list-marker line, or after a heading line; wrapped lines (the
// PDF-extracted handbooks break mid-sentence) stay joined. Over-long units are cut at
// sentence boundaries.
export function splitParagraphs(text) {
  const t = String(text ?? "");
  const units = [];
  let cur = null;
  const lineRe = /[^\n]*(?:\n|$)/g;
  let m;
  while ((m = lineRe.exec(t)) !== null && m[0] !== "") {
    const line = m[0];
    const blank = line.trim() === "";
    if (blank || MARKER.test(line) || (cur && isHeadingLine(t, cur) && /^\s*[A-Z]/.test(line))) {
      if (cur) units.push(cur);
      cur = blank ? null : { start: m.index, end: m.index + line.length };
    } else if (cur) {
      cur.end = m.index + line.length;
    } else {
      cur = { start: m.index, end: m.index + line.length };
    }
  }
  if (cur) units.push(cur);
  const out = [];
  for (const u of units) {
    const s = span(t, u.start, u.end);
    if (s.end <= s.start) continue;
    if (s.end - s.start > MAX_UNIT_CHARS) out.push(...packSentences(t, s.start, s.end));
    else out.push(s);
  }
  return out;
}

// Tables (owner's live test, 2026-09-26, Run 3): the FHA manual-underwriting ratio matrix
// in 4000.1 II.D arrives from the PDF as one cell per line, split by blank lines into
// several paragraph units, so find_in_section returned the 31/43 rows and stopped before
// 37/47, 40/40 and 40/50 -- a model stopping there misses the higher tiers. A table is
// recognized by its column-header run: at least TABLE_HEADER_LINES consecutive short lines
// (<= TABLE_CELL_CHARS, no closing punctuation, no list marker). It runs from that header
// to the next outline-marker line ("ix. Documenting ...", "(A) ...") -- bullets inside
// cells do not end it -- or the end of the text. A region longer than MAX_TABLE_CHARS is
// not treated as a table (no terminator found: better a row than half the section).
// Text stored as one unbroken line (some guides) has no line structure to read, so its
// tables are not detected.
export const TABLE_HEADER_LINES = 4;
export const TABLE_CELL_CHARS = 40;
export const MAX_TABLE_CHARS = 5000;

const OUTLINE =
  /^\s*(?:\((?:[ivxlcdm]{1,6}|[IVXLCDM]{1,6}|[A-Za-z]|\d{1,3})\)|(?:[ivxlcdm]{1,6}|[IVXLCDM]{1,6}|[A-Za-z]|\d{1,3})\.(?=\s|$))/;

function isCellLine(s) {
  return s.length > 0 && s.length <= TABLE_CELL_CHARS && !/[.;:,]$/.test(s) &&
    !MARKER.test(s) && !OUTLINE.test(s);
}

export function findTables(text) {
  const t = String(text ?? "");
  const lines = [];
  const lineRe = /[^\n]*(?:\n|$)/g;
  let m;
  while ((m = lineRe.exec(t)) !== null && m[0] !== "") {
    lines.push({ start: m.index, end: m.index + m[0].length, s: m[0].trim() });
  }
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (j < lines.length && isCellLine(lines[j].s)) j++;
    if (j - i < TABLE_HEADER_LINES || j >= lines.length) { i = Math.max(j, i + 1); continue; }
    let k = j;
    while (k < lines.length && !OUTLINE.test(lines[k].s)) k++;
    const region = span(t, lines[i].start, lines[k - 1].end);
    if (region.end - region.start <= MAX_TABLE_CHARS) tables.push(region);
    i = k;
  }
  return tables;
}

// FLATTENED TABLES (Round 4, stress2 P1-3: `table: true` was never set on Fannie / Freddie
// text). Those guides are stored as one unbroken line, so the column-header test above has no
// lines to read. Two shapes are recognized instead:
//   numeric grid   a run where at least FLAT_NUMERIC_SHARE of each FLAT_WINDOW-token window is
//                  a figure ("6%", "80.01", "12%*", "$10,000", "≤"), holding FLAT_MIN_FIGURES
//                  or more figures -- the B7-1-02 mortgage insurance coverage grid. It starts at
//                  the sentence before the first figure (the column headings) and ends after
//                  the last figure.
//   announced      "The following table ..." / "the table below ...": from that sentence
//                  through FLAT_ANNOUNCED_CHARS, extended to the next sentence end -- the
//                  B3-4.3-04 minimum-contribution table, whose rows are prose.
// Both are heuristics over text that lost its layout: the passage is still an exact slice,
// and `table: "flattened"` says the rows and columns can no longer be told apart reliably.
export const FLAT_WINDOW = 20;
export const FLAT_NUMERIC_SHARE = 0.35;
export const FLAT_MIN_FIGURES = 10;
export const FLAT_ANNOUNCED_CHARS = 1200;
const FIGURE = /^[([]?(?:[$≤≥<>~]|\d)[\d.,$%–\-*^+/]*[%*^)\]]*[,;]?$/;
const ANNOUNCED = /\b(?:the following table|the table below)\b/gi;

function sentenceStartBefore(t, at, reach) {
  const lo = Math.max(0, at - reach);
  const hits = [...t.slice(lo, at).matchAll(/[.:;]\s+(?=[A-Z])/g)];
  const m = hits[hits.length - 1];
  return m ? lo + m.index + m[0].length : lo;
}

function sentenceEndAfter(t, at, reach) {
  const m = t.slice(at, at + reach).match(/[.:;](?=\s+[A-Z]|\s*$)/);
  return m ? at + m.index + 1 : Math.min(t.length, at + reach);
}

// `stops` (batch 5, stress2 C4C-04): sorted offsets where a new subsection starts (the
// outline headings). An announced table ends at the first stop -- or the next announced
// table -- after its announcement, when that lies within MAX_TABLE_CHARS; at the end of the
// text when that does. Otherwise it keeps the FLAT_ANNOUNCED_CHARS estimate and is marked
// `complete: false`: the B3-3.2-01 borrower-documentation table was cut after 1,200 chars,
// dropping three of its five requirements, while the tool said it came back whole.
export function findFlatTables(text, stops = []) {
  const t = String(text ?? "");
  const toks = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    toks.push({ start: m.index, end: m.index + m[0].length, fig: FIGURE.test(m[0]) });
  }
  const runs = [];
  let run = null;
  let figs = 0;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].fig) figs++;
    if (i >= FLAT_WINDOW && toks[i - FLAT_WINDOW].fig) figs--;
    if (i < FLAT_WINDOW - 1) continue;
    const from = i - FLAT_WINDOW + 1;
    if (figs / FLAT_WINDOW >= FLAT_NUMERIC_SHARE) {
      if (run && from <= run.to + 1) run.to = i;
      else { if (run) runs.push(run); run = { from, to: i }; }
    }
  }
  if (run) runs.push(run);
  const out = [];
  for (const r of runs) {
    let a = r.from;
    let b = r.to;
    while (a <= b && !toks[a].fig) a++;
    while (b >= a && !toks[b].fig) b--;
    if (toks.slice(a, b + 1).filter((x) => x.fig).length < FLAT_MIN_FIGURES) continue;
    const reg = span(t, sentenceStartBefore(t, toks[a].start, 400), toks[b].end);
    if (reg.end - reg.start <= MAX_TABLE_CHARS) out.push(reg);
  }
  const announced = [...t.matchAll(ANNOUNCED)].map((a) => a.index);
  for (const at of announced) {
    const start = sentenceStartBefore(t, at, 200);
    const next = [...stops, ...announced.map((o) => sentenceStartBefore(t, o, 200))]
      .filter((o) => o > at + 40).sort((x, y) => x - y)[0];
    let end;
    let complete = true;
    if (next !== undefined && next - start <= MAX_TABLE_CHARS) end = next;
    else if (next === undefined && t.length - start <= MAX_TABLE_CHARS) end = t.length;
    else {
      end = sentenceEndAfter(t, Math.min(t.length, start + FLAT_ANNOUNCED_CHARS), 400);
      complete = end >= t.length;
    }
    const reg = { ...span(t, start, end), ...(complete ? {} : { complete: false }) };
    const overlap = out.find((o) => reg.start < o.end && reg.end > o.start &&
      Math.max(o.end, reg.end) - Math.min(o.start, reg.start) <= MAX_TABLE_CHARS);
    if (overlap) {
      overlap.start = Math.min(overlap.start, reg.start);
      overlap.end = Math.max(overlap.end, reg.end);
      if (reg.complete === false) overlap.complete = false;
    } else out.push(reg);
  }
  // Pieces of one table split by a repeated header ("Mortgage Insurance Coverage Requirements"
  // reprinted at a page break) join when little text lies between them.
  const joined = [];
  for (const r of out.sort((x, y) => x.start - y.start)) {
    const last = joined[joined.length - 1];
    if (last && r.start - last.end <= FLAT_JOIN_GAP && r.end - last.start <= MAX_TABLE_CHARS) {
      if (r.end >= last.end && r.complete === false) last.complete = false;
      last.end = Math.max(last.end, r.end);
    } else joined.push({ ...r });
  }
  return joined;
}
const FLAT_JOIN_GAP = 200;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word-ish: a token also matches its common inflections ("refinance" ->
// refinances/refinanced/refinancing; "policy" -> policies), and a plural term matches its
// singular. Only the LAST token of a phrase inflects ("credit score" -> "credit scores").
// Round 4 (stress2 P1-5): "expire" also finds "expiration" and "unexpired" (a negating
// prefix is allowed on a one-word term: the passage about the unexpired term is the one
// about expiry).
function inflect(tok) {
  let base = tok;
  if (base.length > 3 && /[^s]s$/.test(base)) base = base.slice(0, -1);
  if (!/[a-z]$/i.test(base)) return escapeRegExp(base);
  if (/e$/i.test(base)) return `${escapeRegExp(base.slice(0, -1))}(?:e|es|ed|ing|ings|ation|ations)`;
  if (/[^aeiou]y$/i.test(base)) return `${escapeRegExp(base.slice(0, -1))}(?:y|ies|ied)`;
  return `${escapeRegExp(base)}(?:s|es|ed|ing|ings)?`;
}

// Numbers (Round 4, stress2 Q2): "five years" missed "five (5) years". A number, as a word or
// digits, matches either form and the regulator's "five (5)" doubling.
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen", "twenty"];
const TENS = { thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90 };
const ALL_TENS = { 20: "twenty", 30: "thirty", 40: "forty", 50: "fifty", 60: "sixty", 70: "seventy",
  80: "eighty", 90: "ninety" };

function numberPattern(tok) {
  const low = String(tok).toLowerCase();
  // Batch 8 (stress6 C12): a zero-padded number is part of a citation or date ("B3-5.3-09",
  // "Sept. 01, 2025") and matches only as written -- "09" is not "nine".
  if (/^0\d/.test(low)) return escapeRegExp(low);
  let n = NUMBER_WORDS.indexOf(low);
  if (n === -1 && Object.hasOwn(TENS, low)) n = TENS[low];
  // Batch 18 (find figures): "1,025" / "1025" / "$50,000" -- a figure of 4+ digits matches with
  // or without its thousands commas ("1_025" is ftsTokens' spelling of "1,025").
  if (n === -1 && (/^\d{1,3}(?:_\d{3})+$/.test(low) || /^[1-9]\d{3,}$/.test(low))) {
    const d = low.replace(/_/g, "");
    const groups = [];
    for (let i = d.length; i > 0; i -= 3) groups.unshift(d.slice(Math.max(0, i - 3), i));
    return groups.join(",?");
  }
  if (n === -1 && /^\d{1,3}$/.test(low)) n = Number(low);
  if (n === -1) return null;
  // Batch 18: 21-99 also as words ("forty-five (45) days").
  const tens = (m) => ALL_TENS[m] ?? null;
  const word = NUMBER_WORDS[n] ?? tens(n) ??
    (n > 20 && n < 100 && tens(n - (n % 10)) ? `${tens(n - (n % 10))}[\\s-]?${NUMBER_WORDS[n % 10]}` : null);
  const forms = word ? `(?:${word}|${n})` : `${n}`;
  return String.raw`${forms}(?:\s*\(\s*${n}\s*\))?`;
}

// Any 0-3 non-alphanumerics between words: "loan to value" matches "loan-to-value",
// "203 k" matches "203(k)", "w 2" matches "W-2".
const SEP = "[^\\p{L}\\p{N}]{0,3}";

export function phraseRegExp(phrase) {
  // "five (5) years" as a term: the doubled numeral is optional in the text too.
  // Batch 18: "10%" is "10 percent", and a number then "percent" matches either spelling.
  const toks = ftsTokens(String(phrase ?? "").replace(/\(\s*\d{1,3}\s*\)/g, " ")
    .replace(/(\d)\s*%/g, "$1 percent ")
    .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-]+(one|two|three|four|five|six|seven|eight|nine)\b/gi,
      (_, t, u) => String(Number(Object.keys(ALL_TENS).find((k) => ALL_TENS[k] === t.toLowerCase())) +
        NUMBER_WORDS.indexOf(u.toLowerCase())))
    .replace(/\bper\s+cent\b/gi, "percent"));
  if (!toks.length) return null;
  const parts = toks.map((t, i) => numberPattern(t) ??
    (i === toks.length - 1 ? inflect(t) : escapeRegExp(t)));
  const prefix = toks.length === 1 && /^[a-z]{4,}$/i.test(toks[0]) ? "(?:un|non-?)?" : "";
  const pct = (i) => i > 0 && /^percent$/i.test(toks[i]) && numberPattern(toks[i - 1]);
  let body = parts[0];
  for (let i = 1; i < parts.length; i++) body += pct(i) ? `(?:\\s?%|${SEP}per\\s?cent(?:age)?)` : SEP + parts[i];
  const tail = pct(toks.length - 1) ? "" : "(?![\\p{L}\\p{N}])";
  return new RegExp(`(?<![\\p{L}\\p{N}])${prefix}${body}${tail}`, "iu");
}

// A term plus the regulator phrases src/vocab.js maps it to ("LTV" -> "loan to value",
// "DTI" -> "debt to income"), looked up the way search_regs looks it up.
export function expandTerm(term) {
  const key = contentTokens(term).join(" ");
  const alts = key && Object.hasOwn(VOCAB, key) ? VOCAB[key] : [];
  const phrases = [term, ...alts];
  const res = phrases.map(phraseRegExp).filter(Boolean);
  return { term, expanded_to: alts, res };
}

// Batch 8 (stress6 C12 R8): the terms a passage matched only through their expanded_to phrases
// ("rollover" -> "rate adjustment") -- the passage never says the word as written.
function expansionOnly(expanded, matched, text) {
  const only = matched.filter((t) => {
    const e = expanded.find((x) => x.term === t);
    return e && e.res.length > 1 && !e.res[0].test(text) && e.res.slice(1).some((re) => re.test(text));
  });
  return only.length ? { matched_by_expansion_only: only } : {};
}

// The tool body over one obligation row (from OBLIGATION_SQL), separated for tests.
// Batch 13: label rows of a flattened two-column table ("Criteria Requirements Documentation The
// lender must ... Income History A minimum two-year ..."). A row starts after a sentence end
// with a short Title Case label (1-6 words, no verb) that is followed by a capitalized word; the
// repeated column header ("Criteria Requirements") starts a row of its own. At least 3 rows,
// or the table is left whole.
export const TABLE_SPLIT_CHARS = 1500;
const ROW_LABEL =
  /(?<=[.:;)”"]\s+)((?:[A-Z][\w'’/-]*)(?:\s+(?:(?:of|and|for|the|to|in|on|or|with|by|a|an|from|as|at|per|vs)\s+){0,2}[A-Z][\w'’/()-]*){0,5})(?=\s+(?:[A-Z(•]|\d))/g;
const NOT_LABEL = /^(?:The|A|An|If|For|When|In|This|These|That|Each|Any|All|Such|Where|Unless|Note|See|DU|LPA|Fannie|Freddie|Lenders?|Borrowers?)\b/;
export function labelRows(text, start, end) {
  const t = text.slice(start, end);
  const starts = [];
  let m;
  ROW_LABEL.lastIndex = 0;
  while ((m = ROW_LABEL.exec(t)) !== null) {
    const label = m[1];
    if (NOT_LABEL.test(label) || label.length > 60) continue;
    starts.push(start + m.index);
  }
  if (starts.length < 2) return null;
  const cuts = [start, ...starts.filter((s) => s > start), end];
  const rows = [];
  for (let i = 0; i + 1 < cuts.length; i++) if (cuts[i + 1] > cuts[i]) rows.push({ start: cuts[i], end: cuts[i + 1] });
  return rows.length >= 3 ? rows : null;
}

function cutAtHeadings(units, headings) {
  const offs = headings.map((h) => h.offset).sort((x, y) => x - y);
  const out = [];
  for (const u of units) {
    let start = u.start;
    for (const off of offs) {
      if (off > start && off < u.end) { out.push({ ...u, start, end: off }); start = off; }
    }
    out.push({ ...u, start, end: u.end });
  }
  return out;
}

export function findPassages(row, terms, maxPassages = DEFAULT_PASSAGES, versions) {
  const text = row.verbatim ?? "";
  const expanded = terms.map(expandTerm).filter((e) => e.res.length);
  const base = provenance(row, versions);
  if (!expanded.length) {
    return { ...base, error: "empty_terms",
      hint: "Each term needs at least one letter or digit, e.g. \"credit score\"." };
  }
  const unbroken = (text.match(/\n/g) ?? []).length * 400 < text.length;
  const headings = outlineHeadings(text);
  // Batch 13 (eval B28): in unbroken text a packed unit could straddle a subheading, so the
  // passage for "Credit for Appraisals" opened on the previous subsection's last sentences. A
  // unit is cut at every outline heading inside it: a passage starts where its subsection does.
  const units = unbroken ? cutAtHeadings(splitParagraphs(text), headings) : splitParagraphs(text);
  const counts = expanded.map(() => 0);
  const hits = [];
  // A term found in a heading ("(1) Cash-Out") is credited to the paragraph under it:
  // a bare heading is no answer, and it comes back as that paragraph's `heading` anyway.
  let carried = new Set();
  units.forEach((u, idx) => {
    const body = text.slice(u.start, u.end);
    const found = new Set(expanded.filter((e) => e.res.some((re) => re.test(body))).map((e) => e.term));
    if (isHeadingLine(text, u)) {
      carried = new Set([...carried, ...found]);
      return;
    }
    const matched = expanded.map((e) => e.term).filter((t) => found.has(t) || carried.has(t));
    carried = new Set();
    if (!matched.length) return;
    expanded.forEach((e, i) => { if (matched.includes(e.term)) counts[i]++; });
    hits.push({ idx, u, matched });
  });

  // A hit inside a table becomes the WHOLE table (header and every row), once per table,
  // with the matched terms of all its hits. `counts` stay per paragraph.
  // Unbroken text (the Fannie / Freddie guides) also gets the flattened-table detector.
  const tables = [
    ...findTables(text),
    ...(unbroken
      ? findFlatTables(text, headings.map((x) => x.offset)).map((tb) => ({ ...tb, flat: true }))
      : []),
  ];
  const merged = [];
  const byTable = new Map();
  let inTables = 0;
  let inLists = 0;
  for (const h of hits) {
    const ti = tables.findIndex((tb) => h.u.start < tb.end && h.u.end > tb.start);
    if (ti === -1) { merged.push(h); continue; }
    const prev = byTable.get(ti);
    if (prev) {
      for (const term of h.matched) if (!prev.matched.includes(term)) prev.matched.push(term);
      inTables++;
      continue;
    }
    const tb = tables[ti];
    // Batch 13 (eval B2): a long flattened Criteria/Requirements table (Fannie B3-3.3-02, the
    // whole 2.5K section) came back whole, opening on its first row, for a question its
    // "Income History" row answers. Such a table is cut into its labelled rows; each row that
    // holds a term is its own passage (table_row, with the table's offset and length).
    const rows = tb.flat && tb.end - tb.start > TABLE_SPLIT_CHARS && !reconstructGrid(text.slice(tb.start, tb.end))
      ? labelRows(text, tb.start, tb.end) : null;
    if (rows) {
      byTable.set(ti, { rowsDone: true, matched: [] });
      for (const row of rows) {
        const body = text.slice(row.start, row.end);
        const matched = expanded.map((e) => e.term).filter((term) =>
          expanded.find((e) => e.term === term).res.some((re) => re.test(body)));
        if (!matched.length) continue;
        const idx = units.findIndex((u) => u.end > row.start);
        merged.push({ idx: idx === -1 ? h.idx : idx, u: row, matched, table: true, flat: true, row: true,
          tableSpan: { start: tb.start, end: tb.end } });
      }
      continue;
    }
    const first = units.findIndex((u) => u.end > tb.start);
    // A hit paragraph reaching past a flattened table keeps its whole text too.
    const u = tb.flat
      ? { start: Math.min(tb.start, h.u.start), end: Math.max(tb.end, h.u.end) }
      : { start: tb.start, end: tb.end };
    const t = { idx: first === -1 ? h.idx : first, u, matched: [...h.matched], table: true,
      ...(tb.flat ? { flat: true } : {}), ...(tb.complete === false ? { partial: true } : {}) };
    byTable.set(ti, t);
    merged.push(t);
  }

  // A paragraph ending in a colon introduces a list ("... must also be included:", "... the
  // lesser of:"): the list comes with it (Round 4, stress2 P1-5 / stress3 TRUNC-01). Units
  // after it are added while they are list items (a list marker, or the previous item ends
  // with ";" / "and" / "or"), at least one, up to LIST_MAX_CHARS.
  for (const h of merged) {
    if (h.table) continue;
    if (!/:\s*$/.test(text.slice(h.u.start, h.u.end))) continue;
    let end = h.u.end;
    for (let j = h.idx + 1; j < units.length; j++) {
      const u = units[j];
      if (u.end - h.u.start > LIST_MAX_CHARS) break;
      const body = text.slice(u.start, u.end);
      const prev = text.slice(h.u.start, end).trim();
      const item = MARKER.test(body) || /[;,]$|\b(?:and|or)$/.test(prev) || j === h.idx + 1;
      // A short marker line is a heading -- unless its marker is a bullet (a list item).
      const bullet = /^\s*[•▪■●◦‣⁃·*-]\s/u.test(body);
      if (!item || (isHeadingLine(text, u) && !bullet)) break;
      end = u.end;
      if (!MARKER.test(body) && /[.]$/.test(body.trim()) && j > h.idx + 1) break;
    }
    if (end > h.u.end) { h.u = { start: h.u.start, end }; h.list = true; }
  }
  // An extended passage absorbs the hits it now contains.
  for (let a = 0; a < merged.length; a++) {
    const x = merged[a];
    if (!x.list) continue;
    for (let b = merged.length - 1; b >= 0; b--) {
      const y = merged[b];
      if (y === x || y.u.start < x.u.start || y.u.end > x.u.end) continue;
      for (const term of y.matched) if (!x.matched.includes(term)) x.matched.push(term);
      merged.splice(b, 1);
      inLists++;
      if (b < a) a--;
    }
  }
  // Keep `matched` in the caller's term order.
  const order = expanded.map((e) => e.term);
  for (const t of byTable.values()) t.matched.sort((a, b) => order.indexOf(a) - order.indexOf(b));

  // TABLE OF CONTENTS (batch 5, stress2 C4C-05): a Fannie topic's opening "This topic contains
  // information on ..., including: <its subheadings>" names every subsection, so an exact
  // heading search matched it -- and it alone came back for "Requirements for One- to
  // Four-Unit Properties". The TOC passage is dropped when every term it matched is matched
  // by another passage (`toc_omitted`), and otherwise ranks last for the cut.
  const intro = text.match(INTRO);
  let tocOmitted = 0;
  if (intro) {
    const listAt = intro.index + intro[0].length;
    for (let i = merged.length - 1; i >= 0; i--) {
      const h = merged[i];
      if (h.table || !(h.u.start <= listAt && h.u.end > listAt)) continue;
      h.toc = true;
      const elsewhere = new Set(merged.filter((x) => x !== h).flatMap((x) => x.matched));
      if (h.matched.every((t) => elsewhere.has(t))) { merged.splice(i, 1); tocOmitted++; }
    }
  }
  // A passage that OPENS a subsection whose heading matches a term ranks above one that only
  // mentions the words, at equal term count.
  for (const h of merged) {
    h.headed = headings.some((x) => x.offset >= h.u.start && x.offset < h.u.end &&
      expanded.some((e) => e.res.some((re) => re.test(x.stack[x.stack.length - 1].text))));
  }
  // Best first for the cut (most distinct terms, then a heading match, then not the TOC, then
  // document order), returned in document order so the passages read as the regulator wrote.
  const ranked = [...merged].sort((a, b) => b.matched.length - a.matched.length ||
    Number(b.headed) - Number(a.headed) || Number(Boolean(a.toc)) - Number(Boolean(b.toc)) ||
    a.idx - b.idx);
  const chosen = [];
  let used = 0;
  for (const h of ranked) {
    if (chosen.length >= maxPassages) break;
    const len = h.u.end - h.u.start;
    if (used + len > PASSAGE_BUDGET && chosen.length) continue;
    chosen.push(h);
    used += len;
  }
  chosen.sort((a, b) => a.idx - b.idx || a.u.start - b.u.start);

  const passages = chosen.map((h) => {
    // Unbroken text packs several sentences per unit: the heading in force is read at the
    // first match inside the passage, not at its start (Round 4).
    const body = text.slice(h.u.start, h.u.end);
    const hitAt = unbroken && !h.table
      ? Math.min(...expanded.flatMap((e) => e.res.map((re) => body.search(re))).filter((x) => x >= 0))
      : 0;
    const stack = headingStackAt(headings, h.u.start + (Number.isFinite(hitAt) ? hitAt : 0));
    return {
      offset: h.u.start,
      chars: h.u.end - h.u.start,
      // The deepest outline heading over the passage (full, never cut); without an outline,
      // the nearest short heading-like line. A table that starts inside a paragraph unit
      // takes that unit's own heading too.
      heading: stack.length ? stack[stack.length - 1].text : headingBefore(text, units,
        h.table && units[h.idx] && units[h.idx].start < h.u.start ? h.idx + 1 : h.idx),
      // Every heading above the passage, outermost first (C4C-05).
      heading_path: stack.length ? stack.map((x) => x.text).join(" > ") : null,
      canonical_citation: passageCitation(base.canonical_citation, stack.map((x) => x.marker),
        row.register_id),
      matched_terms: h.matched,
      // Terms this passage matched only through their expanded_to phrases, not as written.
      ...expansionOnly(expanded, h.matched, text.slice(h.u.start, h.u.end)),
      ...(h.table ? { table: true } : {}),
      // Round 4: a table recovered from text that lost its layout (findFlatTables): rows and
      // columns cannot be told apart reliably -- read cells with care.
      ...(h.flat ? { table_layout: "flattened" } : {}),
      // Batch 13: one labelled row of a long flattened table; the whole table is
      // table_offset..table_offset+table_chars (get_obligation).
      ...(h.row ? { table_row: true, table_offset: h.tableSpan.start,
        table_chars: h.tableSpan.end - h.tableSpan.start } : {}),
      // Batch 5: the table's end was not found (no heading within reach): more rows may
      // follow at `continues_at` -- read on with get_obligation from there.
      ...(h.partial ? { table_complete: false, continues_at: h.u.end } : {}),
      // Batch 5: a flattened numeric grid's rows rebuilt from the text (src/tables.js) --
      // best-effort, with table_confidence; the verbatim string stays authoritative.
      ...(h.flat && !h.row ? reconstructGrid(text.slice(h.u.start, h.u.end)) ?? {} : {}),
      // Round 4: the passage ended in a colon; the list it introduces was appended.
      ...(h.list ? { list_included: true } : {}),
      verbatim: text.slice(h.u.start, h.u.end),
    };
  });
  const out = {
    ...base,
    // The text the passage offsets index into (see envelope.js buildEnvelope).
    chars_total: text.length,
    terms: expanded.map((e, i) => ({ term: e.term, expanded_to: e.expanded_to, paragraphs: counts[i] })),
    total_matches: hits.length,
    // C4C-17: total_matches counts matching PARAGRAPHS; paragraphs inside one table come
    // back as that one whole-table passage. passages_available is what can be returned;
    // truncated is true exactly when fewer passages than that came back.
    passages_available: merged.length,
    ...(tocOmitted ? { toc_omitted: true } : {}),
    passages_returned: passages.length,
    truncated: passages.length < merged.length,
    // Batch 5: the note names each reason paragraphs share a passage (a table, a list its
    // lead-in introduced, the omitted TOC), so the arithmetic is checkable.
    ...(hits.length > merged.length ? {
      ...(inTables ? { merged_into_tables: inTables } : {}),
      ...(inLists ? { merged_into_lists: inLists } : {}),
      matches_note: `${hits.length} matching paragraphs make ${merged.length} passages: ` +
        [inTables ? `${inTables} lie inside tables returned as one passage each (table: true)` : "",
          inLists ? `${inLists} lie inside a list returned with its lead-in (list_included: true)` : "",
          tocOmitted ? "the topic's table-of-contents line was omitted (its terms match other passages)" : ""]
          .filter(Boolean).join("; ") + ". " + (merged.some((h) => h.partial)
        ? "A table marked table_complete: false may continue past its passage: read on from " +
          "its continues_at offset with get_obligation."
        : "Nothing was left out on that account."),
    } : {}),
    passages,
  };
  if (!hits.length) {
    // Batch 18: said outright -- no passage holds a term, so nothing (never the section
    // opening) comes back. Figures were compared ignoring $ and thousands commas, with
    // % = percent and number words = digits.
    out.no_match = true;
    out.hint = "No match: none of the terms occur in this section (figures are compared " +
      "ignoring $ and thousands commas; % = percent; number words = digits). Try";
    out.hint += " the regulator's own word" +
      " (\"debt-to-income\", \"Cash-Out\"), a different section (get_reg lists them), or " +
      "read it whole with get_obligation. Do not infer the rule is silent from this alone.";
  } else if (out.truncated) {
    out.hint = "More paragraphs match than were returned: narrow the terms, raise " +
      "max_passages, or read the section with get_obligation from a passage's offset.";
  }
  return out;
}

// ---- Heading paths (C4C-05, owner's live test 2026-09-26) ----
// `heading` alone was the nearest short line: the first "payment history" passage in FHA
// II.A.8.d was the CASH-OUT 12-month rule labelled only "(a) Standard", the same text came
// back three times as "(i) Standard" under three programs, a wrapped heading was cut
// mid-phrase ("... or with a"), and the in-force (iii) table was labelled "(ii)". Every
// outline heading of the section is now read in order into a stack keyed by marker STYLE
// ("v." / "(A)" / "(1)" / "(a)" / "(i)"): a heading whose style is already on the stack
// closes everything below it, so the stack advances at EVERY heading. A passage's
// `heading_path` is the stack at its offset, full headings joined with " > ".
//
// Heading line: an outline marker, then a title that starts with a capital, has no closing
// punctuation and no "must/may/will/shall" (a wrapped requirement sentence is not a
// heading). A wrapped heading's continuation line (short, title case, no punctuation) is
// joined, so headings are never cut. A marker alone on its line takes the next line as its
// title. Text stored as one unbroken line (VA M26-7) has no lines to read: there the
// lettered subsections "a. General ... b. Estimated Monthly ..." are found inline, in
// alphabetical sequence (so "U.S." or "e.g." never count), titled by their leading words.
const HEAD_LINE =
  /^\s*(\((?:[ivxlcdm]{1,6}|[IVXLCDM]{1,6}|[A-Za-z]|\d{1,3})\)|(?:[ivxlcdm]{1,6}|[A-Za-z]|\d{1,3})\.)(?:\s+(\S.*?))?\s*$/;
const MODAL = /\b(?:must|may|will|shall|should|cannot|is|are)\b/;
// A title never opens like a sentence (guards the parenthetical-group rule in inlineTitle).
const SENTENCE_START = /^(?:The|A|An|If|For|When|In|This|These|That|Each|Any|All|Such|Where|Unless)$/;
const CONNECTOR = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on",
  "or", "the", "to", "with", "without", "than", "vs", "per"]);

function titleCaseShare(s) {
  const words = s.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w) && w.length >= 4);
  if (!words.length) return 1;
  return words.filter((w) => /^[A-Z]/.test(w)).length / words.length;
}

function isTitle(s) {
  return s.length > 0 && s.length <= 150 && /^[A-Z0-9“"(]/.test(s) && !/[.;:,]$/.test(s) &&
    !MODAL.test(s) && titleCaseShare(s) >= 0.5;
}

function isContinuation(s) {
  return s.length > 0 && s.length <= 80 && !/[.;:,]$/.test(s) && !HEAD_LINE.test(s) &&
    !MODAL.test(s) && (/^[A-Z]/.test(s) || CONNECTOR.has(s.split(/\s+/)[0])) &&
    titleCaseShare(s) >= 0.6;
}

const ROMAN = /^(?:[ivx]{2,6}|[IVX]{2,6})$/;
const PRED = { i: "h", v: "u", x: "w", I: "H", V: "U", X: "W" };

// { marker: "(b)", core: "b", key: "p-lower" } for a marker, resolving i/v/x (roman or the
// letter after h/u/w) against the stack.
function styleOf(marker, stack) {
  const paren = marker.startsWith("(");
  const core = marker.replace(/[().]/g, "");
  const p = paren ? "p" : "d";
  let kind;
  if (/^\d+$/.test(core)) kind = "num";
  else if (ROMAN.test(core)) kind = core === core.toLowerCase() ? "roman" : "ROMAN";
  else if (/^[ivxIVX]$/.test(core)) {
    const letterKey = `${p}-${core === core.toLowerCase() ? "lower" : "upper"}`;
    const lvl = stack.find((h) => h.key === letterKey);
    const isLetter = lvl && lvl.core === PRED[core];
    kind = isLetter ? (core === core.toLowerCase() ? "lower" : "upper")
      : (core === core.toLowerCase() ? "roman" : "ROMAN");
  } else kind = core === core.toLowerCase() ? "lower" : "upper";
  return { marker, core, key: `${p}-${kind}` };
}

// A style already on the stack closes it down to that level. A style not on the stack goes
// to the depth where it FIRST appeared in this text (`depths`, learned in order): a
// section's outline order ("d." > "i." > "(A)" > "(1)" > "(a)" > "(i)" in 4000.1; "(a)" >
// "(1)" > "(i)" in the CFR) is fixed by its first descent, so a later "vi." after a deep
// "(i)" returns to its own level instead of nesting under it.
function pushHeading(stack, h, depths) {
  const at = stack.findIndex((x) => x.key === h.key);
  let next;
  if (at !== -1) next = stack.slice(0, at);
  else if (depths.has(h.key)) next = stack.slice(0, Math.min(depths.get(h.key), stack.length));
  else next = [...stack];
  if (!depths.has(h.key)) depths.set(h.key, next.length);
  next.push(h);
  return next;
}

// Every heading of a line-structured text: [{ offset, stack }], in order; stack is the full
// path AFTER that heading ([{ marker, text }]).
function lineHeadings(text) {
  const lines = [];
  const lineRe = /[^\n]*(?:\n|$)/g;
  let m;
  while ((m = lineRe.exec(text)) !== null && m[0] !== "") lines.push({ start: m.index, s: m[0].trim() });
  const out = [];
  const depths = new Map();
  let stack = [];
  for (let i = 0; i < lines.length; i++) {
    const hm = lines[i].s.match(HEAD_LINE);
    if (!hm) continue;
    let title = hm[2] ?? "";
    let j = i;
    if (!title) {
      const nxt = lines[i + 1]?.s ?? "";
      if (!isTitle(nxt)) continue;
      title = nxt;
      j = i + 1;
    } else if (!isTitle(title)) continue;
    // A wrapped heading: join up to two short title-case continuation lines.
    for (let k = 0; k < 2 && title.length >= 45 && isContinuation(lines[j + 1]?.s ?? ""); k++) {
      j++;
      title = `${title} ${lines[j].s}`;
    }
    const st = styleOf(hm[1], stack);
    stack = pushHeading(stack, { ...st, text: `${hm[1]} ${title}` }, depths);
    out.push({ offset: lines[i].start, stack });
    i = j;
  }
  return out;
}

// Inline lettered subsections of an unbroken text (VA M26-7): "a. General", "b. ...", in
// alphabetical order. Title: the words after the marker while they are capitalized,
// connectors or a number (at most 8; a number ends it; trailing connectors dropped).
function inlineHeadings(text) {
  const out = [];
  const re = /(?:^|\s)([a-z])\.\s+(?=[A-Z])/g;
  let expect = "a";
  let current = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    const letter = m[1];
    if (letter !== expect && letter !== current) continue;
    const at = m.index + m[0].indexOf(letter);
    const words = text.slice(m.index + m[0].length, m.index + m[0].length + 200).split(/\s+/);
    const title = [];
    for (const w of words) {
      if (title.length >= 8) break;
      const bare = w.replace(/[,;:.]+$/, "");
      if (/^\d/.test(bare)) { title.push(bare); break; }
      if (!(/^[A-Z]/.test(bare) || CONNECTOR.has(bare))) break;
      title.push(bare);
      if (bare !== w) break;
    }
    while (title.length && CONNECTOR.has(title[title.length - 1])) title.pop();
    if (!title.length) continue;
    if (letter === current) continue; // "c. Debts and Obligations, continued"
    current = letter;
    expect = String.fromCharCode(letter.charCodeAt(0) + 1);
    out.push({ offset: at, stack: [{ marker: `${letter}.`, core: letter, key: "d-lower",
      text: `${letter}. ${title.join(" ")}` }] });
  }
  return out;
}

// Round 4 (stress2 P1-6 / I-15: heading_path was null on every Fannie and Freddie passage).
// Both guides are stored as one unbroken line.
//
// Freddie Mac: inline outline markers "(a) General eligibility requirements Stable monthly
// rental income must ...". The title is the shortest run of 2-8 words after the marker that
// is followed by a capitalized word (the sentence it heads) and holds no verb of obligation;
// a marker with no such run ("(ii) The Seller must obtain ...") is list text, not a heading.
// "\s*": Freddie sometimes drops the space after a marker ("(iii)Additional fixed ...").
const PAREN_MARKER = /(?:^|\s)(\((?:[a-z]|[ivx]{1,5}|[A-Z]|\d{1,2})\))\s*(?=[A-Z])/g;

// The section's opening bullet list ("■ General eligibility requirements ■ Rental income from
// subject 1- to 4-unit Investment Property ...") names its lettered subsections exactly; a
// marker whose text starts with a listed title takes it whole (Freddie capitalizes defined
// terms, so the capital-letter rule alone would cut "... 1- to 4-unit Investment Property").
function bulletTitles(text) {
  const out = [];
  for (const m of text.slice(0, 6000).matchAll(/[■▪•]\s+([^■▪•]+?)(?=\s+[■▪•]|\s+\([a-z]\)\s)/g)) {
    const t = m[1].trim();
    if (t.length >= 3 && t.length <= 150) out.push(t);
  }
  return out.sort((a, b) => b.length - a.length);
}

function inlineTitle(words, known) {
  const head = words.slice(0, 30).join(" ");
  const listed = known.find((t) => head.startsWith(t) && /^\s+[A-Z(]/.test(head.slice(t.length)));
  if (listed) return listed;
  // A listed title with a parenthetical the subsection words differently (5303.1: the list
  // says "Non-fluctuating employment earnings (base, entitlements, ...)", the heading "(c)
  // Non-fluctuating employment earnings (base, military, additional fixed earnings)"):
  // the words before the parenthesis match, and the heading's own parenthetical is kept.
  for (const t of known) {
    const core = t.split(" (")[0];
    if (core === t || core.split(" ").length < 2 || !head.startsWith(`${core} (`)) continue;
    const close = head.indexOf(")", core.length);
    if (close !== -1 && /^\s+[A-Z(]/.test(head.slice(close + 1))) return head.slice(0, close + 1);
  }
  // A title may hold one parenthetical group ("Military earnings (base, entitlements, reserve,
  // National Guard)") and commas between its words ("Bonus, commission, overtime, tips
  // (reported by the employer)"); it still ends before a capitalized word and never on
  // punctuation. The group counts as one word toward the 8-word limit.
  // A title ending on a connector ("Military reserve and | National Guard") is only a
  // fallback: the scan goes on for a longer title and returns the fallback if none qualifies.
  const title = [];
  let grouped = false; // one parenthetical group allowed; it counts as one word
  let count = 0;
  let fallback = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\(/.test(w)) {
      // a marker, a second group, or a group before any title word: not a heading here
      if (/^\((?:[a-z]|[ivx]{1,5}|[A-Z]|\d{1,2})\)$/.test(w) || grouped || !title.length ||
        SENTENCE_START.test(title[0]) || !/^\([A-Za-z][A-Za-z.-]+/.test(w)) return fallback; // not "(t)(5)"
      const end = words.slice(i, i + 16).findIndex((x) => /\)$/.test(x));
      if (end === -1) return fallback;
      title.push(...words.slice(i, i + end + 1));
      i += end;
      grouped = true;
    } else {
      title.push(w);
    }
    if (++count > 8) return fallback;
    if (count < 2) continue;
    const next = words[i + 1] ?? "";
    // a title may run straight into the next marker: "(ii) Military earnings (...) (A) ..."
    if (!/^[A-Z]/.test(next) && !/^\((?:[a-z]|[ivx]{1,5}|\d{1,2})\)$/.test(next) &&
      !(grouped && /^\([A-Z]\)$/.test(next))) continue;
    const outside = title.filter((x, k) => !inGroup(title, k));
    if (outside.some((x) => MODAL.test(x))) return fallback;
    // commas between title words only in a list title that carries a qualifier group
    if (outside.some((x) => (grouped ? /[.;:]$/ : /[.;:,]$/).test(x))) return fallback;
    if (!CONNECTOR.has(title[title.length - 1].toLowerCase())) return title.join(" ");
    fallback ??= title.join(" ");
  }
  return fallback;
}

// Whether title[k] lies inside the parenthetical group.
function inGroup(title, k) {
  const open = title.findIndex((x) => /^\(/.test(x));
  if (open === -1 || k < open) return false;
  const close = title.findIndex((x, j) => j >= open && /\)$/.test(x));
  return k <= close;
}

function parenHeadings(text) {
  const out = [];
  const depths = new Map();
  const known = bulletTitles(text);
  let stack = [];
  let m;
  PAREN_MARKER.lastIndex = 0;
  while ((m = PAREN_MARKER.exec(text)) !== null) {
    const after = m.index + m[0].length;
    const title = inlineTitle(text.slice(after, after + 400).split(/\s+/), known);
    if (!title) continue;
    const st = styleOf(m[1], stack);
    stack = pushHeading(stack, { ...st, text: `${m[1]} ${title}` }, depths);
    out.push({ offset: m.index + m[0].indexOf("("), stack });
  }
  return out;
}

// Fannie Mae: no markers at all. A topic opens "This topic contains information on ...,
// including: Gift Funds Acceptable Donors ..." -- the list of its subheadings. A subheading
// is a title-case run (1-8 words, up to two connectors between words: "Documentation Provided
// by the Borrower") that starts a sentence and appears in that list; the list is the only evidence used, so ordinary sentences never become headings.
// Batch 13 (eval B28): "This topic describes ... including:" / "provides" / "includes" open the
// same subheading list as "contains" (B5-4.2-03 had no headings, so its IPC table swallowed
// the "Loan-level Price Adjustment Credit for Appraisals" subsection).
const INTRO = /\bThis (?:topic|section|subsection|chapter) (?:contains|describes|provides|includes|covers|identifies|explains) [^:]{0,300}?:\s*/;
const TITLE_RUN =
  /(?<=^|[.:;]\s|\)\s)((?:[A-Z][\w'’-]*|\d[\w-]*)(?:\s+(?:(?:of|and|for|the|to|in|on|or|with|by|a|an|from|if|as|at|into|under|not|when|during|after|before|per|than|upon|within|without|through|between|vs|is|are)\s+){0,2}(?:[A-Z][\w'’()-]*|\d[\w-]*)){0,7})(?=\s+[A-Z])/g;

// Batch 5: "Determining if a Property Requires Flood Insurance" (B7-3-06) -- "if" ended the
// list, so the topic had no headings and its first table swallowed the whole section.
const LIST_CONNECTOR = /^(?:of|and|for|the|to|in|on|or|with|by|a|an|from|if|as|at|into|under|not|when|during|after|before|per|than|upon|within|without|through|between|vs|is|are)$/;

function introHeadings(text) {
  const intro = text.match(INTRO);
  if (!intro) return [];
  const listStart = intro.index + intro[0].length;
  // The list runs while words are capitalized (or connectors); the first subheading follows
  // it with no punctuation ("... Transfer of Gift Funds Gift Funds A borrower may ..."): it is
  // the longest tail of the run that repeats the run's first words.
  const words = [];
  const re = /\S+/g;
  re.lastIndex = listStart;
  let w;
  while ((w = re.exec(text)) !== null && words.length < 120) {
    if (!/^[A-Z0-9(]/.test(w[0]) && !LIST_CONNECTOR.test(w[0])) break;
    words.push({ s: w[0], at: w.index });
  }
  let first = null;
  let listEnd = listStart;
  for (let drop = 1; drop <= 3 && !first; drop++) {
    const end = words.length - drop;
    for (let k = Math.min(8, Math.floor(end / 2)); k >= 1 && !first; k--) {
      const tail = words.slice(end - k, end).map((x) => x.s).join(" ");
      if (tail === words.slice(0, k).map((x) => x.s).join(" ") &&
          !LIST_CONNECTOR.test(words[end - 1].s)) {
        first = { text: tail, at: words[end - k].at };
        listEnd = words[end - k].at;
      }
    }
  }
  // Batch 13 (eval B28): a lower-case word inside a listed title ("Special Feature Code for
  // HomePath Properties using the IPC Exception") ended the run before the list did. Fallback:
  // the first subheading is where the list's opening words recur, within reach; its title is
  // the words both places share.
  if (!first && words.length >= 2) {
    const lead = words.slice(0, 3).map((x) => x.s).join(" ");
    const again = text.indexOf(lead, listStart + lead.length);
    if (again > 0 && again - listStart < 1500) {
      const a = text.slice(listStart).split(/\s+/);
      const b = text.slice(again).split(/\s+/);
      let k = 0;
      while (k < 10 && a[k] === b[k]) k++;
      const shared = a.slice(0, k);
      while (shared.length && LIST_CONNECTOR.test(shared[shared.length - 1])) shared.pop();
      if (shared.length >= 2) {
        first = { text: shared.join(" "), at: again };
        listEnd = again;
      }
    }
  }
  if (!first) return [];
  const list = text.slice(listStart, listEnd);
  const out = [{ offset: first.at, stack: [{ marker: "", core: "", key: "fnma-sub", text: first.text }] }];
  let m;
  TITLE_RUN.lastIndex = first.at + first.text.length;
  while ((m = TITLE_RUN.exec(text)) !== null) {
    // Shrink a run that swallowed the next sentence's first word(s) to a listed title.
    let title = m[1];
    while (title && !list.includes(title)) title = title.replace(/\s*\S+$/, "");
    if (!title || title.split(/\s+/).length < 2 && title.length < 6) continue;
    const at = m.index;
    if (out.length && out[out.length - 1].stack[0].text === title) continue;
    out.push({ offset: at, stack: [{ marker: "", core: "", key: "fnma-sub", text: title }] });
  }
  return out;
}

export function outlineHeadings(text) {
  const t = String(text ?? "");
  const newlines = (t.match(/\n/g) ?? []).length;
  if (newlines * 400 >= t.length) return lineHeadings(t);
  const inline = inlineHeadings(t);
  if (inline.length) return inline;
  const paren = parenHeadings(t);
  return paren.length ? paren : introHeadings(t);
}

// The heading stack in force at `offset` (the last heading starting at or before it).
export function headingStackAt(headings, offset) {
  let lo = 0, hi = headings.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (headings[mid].offset <= offset) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best === -1 ? [] : headings[best].stack;
}

// The nearest short line before a passage that reads like a heading ("(B) Types of
// Refinances", "i. Overview"): regulator text, verbatim, to help cite the subsection.
function headingBefore(text, units, idx) {
  for (let j = idx - 1; j >= 0 && j >= idx - 40; j--) {
    const s = text.slice(units[j].start, units[j].end).trim();
    // A marker on its own line, the title on the next ("viii. \nApprovable Ratio
    // Requirements (Manual) \nThe maximum ..."): those two lines, as they stand in the text.
    const lines = s.split("\n");
    if (lines.length >= 2 && OUTLINE.test(lines[0]) && lines[0].replace(OUTLINE, "").trim() === "") {
      const title = lines[1].trim();
      if (title && title.length <= 120 && !/[.;,:]$/.test(title)) {
        return s.slice(0, lines[0].length + 1 + lines[1].length).trim();
      }
    }
    if (s.length > 120 || /[.;,:]$/.test(s)) continue;
    // A bullet item ("• the total Mortgage Payment; and") is list text, not a heading.
    if (/^[•▪■●◦‣⁃·*-]\s/u.test(s)) continue;
    if (!s.includes("\n")) return s;
  }
  return null;
}

const DESCRIPTION =
  "Returns only the verbatim paragraphs of one obligation (section) that contain the given " +
  "terms. Inputs: `obligation_id`; `terms`, 1-6 short words or phrases (\"cash-out\", " +
  "\"credit score\", \"LTV\"; abbreviations are expanded; numbers match as words or digits, " +
  "so \"five years\" finds \"five (5) years\"); optional `max_passages`. Each passage has " +
  "`verbatim` (the regulator's exact text), `offset` (its position in the section's text), " +
  "`canonical_citation` (the pinpoint cite, where derivable) and `heading_path` (every " +
  "heading above it, e.g. \"vi. No Cash-Out Refinances > (A) Rate and Term > (i) " +
  "Standard\"). A match inside a table returns the whole table (`table: true`; " +
  "`table_layout: \"flattened\"` when the source lost its layout and cells may not line " +
  "up). A passage ending in a colon includes the list it introduces (`list_included: " +
  "true`). `truncated` means more passages matched than were returned. No passages means " +
  "no paragraph contains the terms as given; it is not a statement about the rule. " +
  "`currency` is null or a version/status signal (dual-version, pending, revision-pending, " +
  "superseded, expired...). On an FHA section HUD's Update 18 revises, `version` " +
  "(\"in-force\" or \"update-18-optional\") says which text this is and `other_version` " +
  "identifies the other.";

export function registerFindTools(server, env) {
  server.registerTool(
    "find_in_section",
    {
      description: DESCRIPTION,
      inputSchema: {
        obligation_id: z.string().min(1).max(300),
        terms: z.array(z.string().trim().min(1).max(MAX_TERM_CHARS)).min(1).max(MAX_TERMS)
          .describe("1-6 short terms, e.g. [\"cash-out\", \"credit score\"]; not document text."),
        max_passages: z.number().int().min(1).max(MAX_PASSAGES).optional(),
      },
    },
    async ({ obligation_id, terms, max_passages }) => {
      const row = await fetchObligationRow(env, obligation_id);
      const versions = row ? await fetchVersions(env, dualVersionIds([row])) : undefined;
      const body = row
        ? { ...findPassages(row, terms, max_passages ?? DEFAULT_PASSAGES, versions), ...aliasNote(row) }
        : { error: "not_found", obligation_id,
            hint: "Use search_regs or lookup_citation to find a valid obligation_id." };
      return { content: [{ type: "text", text: JSON.stringify(body) }] };
    },
  );
}
