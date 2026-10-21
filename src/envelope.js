// Response envelope, spec section 5.2.
//
// Two rules the rest of the server depends on:
//   1. verbatim and editorial are SEPARATE FIELDS. A model given one blob will
//      blend our words with the regulator's and the user will attribute ours to HUD.
//   2. truncated is mandatory. A silent excerpt produces confident "the rule does
//      not require X" answers with nothing visibly wrong.

import { currencyOf } from "./currency.js";
import { pageUrl } from "./sourceurl.js";
import { versionFields } from "./versions.js";
import { canonicalCitation } from "./canonical.js";

export const MAX_CHARS = 24000;

// `offset` (below) is the start of the MATCHED EXPRESSION, including any literal
// prefix the pattern requires (e.g. currency's "$") -- it is NOT the start of
// `value`. `value` is normalized (commas and "$" stripped), so the two are not
// interchangeable: do not assume offset points at the first digit of value.
//
// Every capture group below is anchored with a leading `\b` so a number cannot
// be pulled out of the middle of a larger token (a section id, a form number,
// digits glued to a preceding letter). The one deliberate exception is
// currency: `\b` immediately before a literal `$` fails to match after a space
// (space and `$` are both non-word characters, so there is no word/non-word
// transition for `\b` to anchor on), which is the ordinary case ("a fee of
// $100"). The `$` prefix itself already delimits the number, so no `\b` guard
// is added there.
const PATTERNS = [
  [/\b(\d+(?:\.\d+)?)\s*(?:percent|per centum)\b/gi, "percent", 1],
  [/\b(\d+(?:\.\d+)?)\s*%/g, "percent", 1],
  [/\$\s*(\d[\d,]*(?:\.\d+)?)(?:\s*(thousand|million|billion|trillion)\b)?/gi, "currency", 1],
  [/\b(\d+(?:\.\d+)?)\s*(?:calendar\s+|business\s+)?(?:days?|months?|years?)\b/gi, "duration", 1],
  [/\b(\d+(?:\.\d+)?)\s*(?::|\bto\b)\s*\d+(?:\.\d+)?\s*ratio\b/gi, "ratio", 1],
];

// Qualifying-ratio pairs ("31/43", "40/50", "33/45"): owner's live test 2026-09-26, Run 3 --
// `figures` listed none of the FHA manual-underwriting ratios. A pair is two 2-3 digit
// numbers joined by "/", each at most 100, and NOT part of a longer slash run, so a date
// ("08/19/2024") or a form number is never read as a ratio. Reported as ONE figure whose
// `value` is the pair as written and whose `values` are the two numbers.
const RATIO_PAIR = /(?<![\d./-])(\d{2,3}(?:\.\d+)?)\s?\/\s?(\d{2,3}(?:\.\d+)?)(?![\d/]|\.\d)/g;

// Round 4 (stress2 I-24, stress3 FIG-01): figures[] missed spelled-out numbers ("two
// business days", "three years", "thirty (30) days", "seven Business Days") and called an
// age a duration ("62 years of age"); the get_obligation description says an empty figures[]
// means the section states no figure, so a miss invited a wrong "no numeric requirement".
//   spelled-out   a number word (optionally doubled "(30)") before days/months/years:
//                 duration, value in digits
//   age           "N years of age" / "N years old" / "age N": unit "age", never duration
//   day ordinal   "15th calendar day": unit "day_of_period"
//   temperature   "50 degrees Fahrenheit": unit "temperature"
const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};
const WORD_RE = Object.keys(WORD_NUMBERS).sort((a, b) => b.length - a.length).join("|");
const SPELLED = new RegExp(
  String.raw`\b((?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-(?:one|two|three|four|five|six|seven|eight|nine)|${WORD_RE})` +
  String.raw`(?:\s*\(\s*\d+\s*\))?\s+(?:consecutive\s+)?(?:calendar\s+|business\s+)?(?:days?|months?|years?)\b`,
  "gi",
);
const AGE_AFTER = /^\s*(?:of\s+age|old|or\s+older)\b/i;
const AGE_BEFORE = /\b(?:age|aged)\s+(?:of\s+)?(\d{2,3})\b/gi;
const ORDINAL_DAY = /\b(\d{1,3})(?:st|nd|rd|th)\s+(?:calendar\s+|business\s+)?day\b/gi;
const DEGREES = /\b(\d{1,3})\s*(?:degrees?|°)\s*(?:Fahrenheit|F\b)/gi;

function spelledValue(w) {
  const low = w.toLowerCase();
  if (low.includes("-")) {
    const [t, u] = low.split("-");
    return (WORD_NUMBERS[t] ?? 0) + (WORD_NUMBERS[u] ?? 0);
  }
  return WORD_NUMBERS[low];
}

// stress5: "$150 million" was served as value 150 and "$1 billion" as 1 -- a figure off by a
// factor of a million that a model would repeat. The scale word multiplies; `as_written`
// keeps the text.
const SCALE = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };

function scaled(num, word) {
  const [whole, frac = ""] = num.split(".");
  const zeros = Math.log10(SCALE[word.toLowerCase()]);
  if (frac.length > zeros) return String(Number(num) * SCALE[word.toLowerCase()]);
  // exact decimal shift, no floating point: "1.25" billion -> "1250000000"
  return (whole + frac.padEnd(zeros, "0")).replace(/^0+(?=\d)/, "");
}

// stress6 C04: figures missed fractions ("1/8 of 1 percentage point"), bare decimals ("CU risk
// score of 2.5"), hyphenated durations ("two-year", "12-month"), number words outside a
// duration ("three full monthly Mortgage Payments"), "2 percentage points", clock times
// ("5 p.m."), and "at least 60, but no more than 120, days" ranges; and a footnote marker
// fused onto a currency amount ("$144,00011") was read as 14400011. These passes run after
// the patterns above and skip any span an earlier pass already reported.
const NUMWORD = String.raw`(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-(?:one|two|three|four|five|six|seven|eight|nine)|${WORD_RE})`;
const FRACTION = /(?<![\d./-])(\d{1,2})\s?\/\s?(\d{1,3})(?![\d/])(?=\s+(?:of\s+(?:1|one|a)\s+)?(?:percent|percentage\s+points?)\b|\s+of\b)/g;
const FRACTION_PP = /^\s+of\s+(?:1|one|a)\s+(percentage\s+points?|percent)\b/i;
const PCT_POINT = new RegExp(String.raw`\b(\d+(?:\.\d+)?|${NUMWORD})(?:\s+or\s+(?:more|less|fewer))?\s+percentage\s+points?\b`, "gi");
const HYPHEN_DURATION = new RegExp(String.raw`\b(\d{1,3}|${NUMWORD})-(?:calendar-|business-)?(day|month|year|week)\b`, "gi");
const RANGE_DURATION = /\b(\d+),\s+but\s+(?:no|not)\s+(?:more|less|later|earlier)\s+than\s+(\d+),\s*(?:calendar\s+|business\s+)?(?:days?|months?|years?)\b/gi;
const CLOCK = /\b(\d{1,2})(?:\s?:\s?(\d{2}))?\s*(a\.\s?m\.|p\.\s?m\.)/gi;
const DECIMAL = /(?<![\w.§/-])(\d{1,3}\.\d{1,3})(?![\w.]*\d|[-/]\w)/g;
const DECIMAL_NOT_AFTER = /(?:section|chapter|part|topic|paragraph|item|appendix|exhibit|form|version|update|§)\s*$/i;
const COUNT_WORD = new RegExp(String.raw`\b(${NUMWORD})\b`, "gi");
const FOOTNOTE_TAIL = /^(\d{1,3}(?:,\d{3})*,\d{3})\d{1,2}$/;

function numberOf(tok) {
  return /^\d/.test(tok) ? tok : String(spelledValue(tok));
}

export function extractFigures(text) {
  const out = [];
  for (const [re, unit, group] of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      // "62 years of age" is an age, not a duration.
      const isAge = unit === "duration" && /years?\s*$/i.test(m[0]) &&
        AGE_AFTER.test(text.slice(m.index + m[0].length));
      const num = m[group].replace(/,/g, "");
      const scale = unit === "currency" ? m[2] : undefined;
      out.push({
        value: scale ? scaled(num, scale) : num,
        unit: isAge ? "age" : unit,
        offset: m.index,
        ...(scale ? { as_written: m[0] } : {}),
      });
    }
  }
  let w;
  SPELLED.lastIndex = 0;
  while ((w = SPELLED.exec(text)) !== null) {
    const isAge = /years?\s*$/i.test(w[0]) && AGE_AFTER.test(text.slice(w.index + w[0].length));
    out.push({ value: String(spelledValue(w[1])), unit: isAge ? "age" : "duration", offset: w.index,
      as_written: w[0] });
  }
  for (const [re, unit] of [[AGE_BEFORE, "age"], [ORDINAL_DAY, "day_of_period"], [DEGREES, "temperature"]]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (out.some((f) => f.offset === m.index + m[0].indexOf(m[1]))) continue;
      out.push({ value: m[1], unit, offset: m.index });
    }
  }
  RATIO_PAIR.lastIndex = 0;
  let m;
  while ((m = RATIO_PAIR.exec(text)) !== null) {
    if (Number(m[1]) > 100 || Number(m[2]) > 100) continue;
    out.push({ value: `${m[1]}/${m[2]}`, unit: "ratio", offset: m.index, values: [m[1], m[2]] });
  }
  // Currency with a fused footnote marker: "$144,00011" -> 144000 (the digits after the
  // last full thousands group are the marker).
  for (const f of out) {
    if (f.unit !== "currency" || f.as_written) continue;
    const raw = text.slice(f.offset).match(/^\$\s*(\d[\d,]*)/);
    const t = raw && raw[1].match(FOOTNOTE_TAIL);
    if (t) f.value = t[1].replace(/,/g, "");
  }
  const spans = out.map((f) => [f.offset, f.offset + String(f.as_written ?? f.value).length]);
  const taken = (a, b) => spans.some(([s, e]) => a < e && b > s);
  const add = (fig, len) => {
    if (taken(fig.offset, fig.offset + len)) return;
    out.push(fig);
    spans.push([fig.offset, fig.offset + len]);
  };
  const each = (re, fn) => {
    re.lastIndex = 0;
    let x;
    while ((x = re.exec(text)) !== null) fn(x);
  };
  each(RANGE_DURATION, (x) => {
    const second = x.index + x[0].indexOf(x[2], x[1].length);
    add({ value: x[1], unit: "duration", offset: x.index, as_written: x[0] }, x[1].length);
    add({ value: x[2], unit: "duration", offset: second, as_written: x[0] }, x[2].length);
  });
  each(FRACTION, (x) => {
    const after = text.slice(x.index + x[0].length);
    const pp = FRACTION_PP.exec(after);
    const dec = Number(x[1]) / Number(x[2]);
    if (!(Number(x[2]) > 0) || Number(x[1]) >= Number(x[2])) return;
    const unit = !pp ? "fraction" : /point/i.test(pp[1]) ? "percentage_point" : "percent";
    if (pp) {
      // "1/2 of 1 percent": the "1 percent" read by the percent pattern is the base, not the figure.
      const s0 = x.index, e0 = x.index + x[0].length + pp[0].length;
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].offset >= s0 && out[i].offset < e0) { out.splice(i, 1); spans.splice(i, 1); }
      }
    }
    add({ value: String(Number(dec.toFixed(6))), unit,
      offset: x.index, as_written: pp ? x[0] + pp[0] : x[0] }, x[0].length + (pp ? pp[0].length : 0));
  });
  each(PCT_POINT, (x) => add({ value: numberOf(x[1]), unit: "percentage_point", offset: x.index,
    as_written: x[0] }, x[0].length));
  each(HYPHEN_DURATION, (x) => add({ value: numberOf(x[1]), unit: "duration", offset: x.index,
    as_written: x[0] }, x[0].length));
  each(CLOCK, (x) => {
    const h = Number(x[1]);
    if (h < 1 || h > 12) return;
    const pm = /p/i.test(x[3]);
    const hh = (h % 12) + (pm ? 12 : 0);
    add({ value: `${String(hh).padStart(2, "0")}:${x[2] ?? "00"}`, unit: "time", offset: x.index,
      as_written: x[0] }, x[0].length);
  });
  each(DECIMAL, (x) => {
    const before = text.slice(Math.max(0, x.index - 20), x.index);
    // A numbered heading at the start of a line ("21.07 CREDIT AND VA REPO") is not a figure.
    if (DECIMAL_NOT_AFTER.test(before) || /(?:^|\n)[ \t]*$/.test(before)) return;
    add({ value: x[1], unit: "number", offset: x.index }, x[1].length);
  });
  each(COUNT_WORD, (x) => {
    if (/^one$/i.test(x[1])) return;
    add({ value: numberOf(x[1]), unit: "count", offset: x.index, as_written: x[0] }, x[0].length);
  });
  return out.sort((a, b) => a.offset - b.offset);
}

// `offset` pages through a long obligation (the largest run to ~103,000 chars, e.g. FHA
// "underwriting the borrower"): a caller reads [offset, offset + maxChars) and follows
// `next_offset` until it is null. Without it, the QC playbooks saw only the first 24,000.
// Provenance + currency shared by get_obligation and find_in_section, so the two can never
// disagree about where a passage came from or whether it is current. `versions`
// (src/versions.js fetchVersions) adds `version` / `other_version` to a dual-version
// section's obligation, and its effective_date is that version's own.
//
// Batch 11 (stress6 C16): a Freddie Mac PENDING version (9203.4 "-full-2" takes effect
// 2026-11-16, "-full-3" 2027-09-27; 9401.2; 5606.1) showed the REGISTER's effective_date
// (2025-12-17) beside its own "not in force until 2026-11-16" currency block. An obligation
// whose own obligation_currency row (src/currency.js withObligationCurrency, marked by
// register_currency_kind) is one of OWN_DATE_KINDS takes that row's effective_date, and a
// pending one reads status "pending" -- the register's "current" describes the in-force text.
const OWN_DATE_KINDS = new Set(["pending", "optional-now", "revised", "time-limited"]);

export function ownVersionDate(row) {
  if (!row || !("register_currency_kind" in row) || !OWN_DATE_KINDS.has(row.currency_kind)) return null;
  return row.currency_effective_date ?? row.currency_mandatory_date ?? null;
}

export function provenance(row, versions) {
  const vf = versionFields(row.obligation_id, versions);
  const own = ownVersionDate(row);
  const pending = own && row.currency_kind === "pending";
  return {
    register_id: row.register_id,
    obligation_id: row.obligation_id,
    authority: row.authority ?? "",
    section: row.section ?? "",
    // The section's citation in the regulator's style (src/canonical.js), or null.
    canonical_citation: canonicalCitation(row),
    source_url: row.source_url ?? "",
    page_url: pageUrl(row.register_id, row.obligation_id),
    snapshot_id: row.snapshot_id ?? "",
    fetched_at: row.fetched_at ?? "",
    content_hash: row.content_hash ?? "",
    effective_date: vf.version?.effective_date ?? own ?? row.effective_date ?? null,
    status: pending ? "pending" : (row.status ?? "unknown"),
    ...(own && own !== row.effective_date && row.effective_date
      ? { register_effective_date: row.effective_date } : {}),
    superseded_by: row.superseded_by ?? null,
    coverage_tier: row.coverage_tier ?? "unknown",
    currency: currencyOf(row),
    // Set only for a same-text copy: the register the corpus treats as this text's home.
    ...(row.canonical_id ? { canonical_id: row.canonical_id } : {}),
    ...vf,
  };
}

// The paging contract, spelled out in the response so a model never has to infer it from
// the counters. `page`/`pages` count page-sized reads from offset 0 to here and from here
// to the end, so an unaligned offset (a find_in_section passage) still numbers sensibly.
// `limit` (get_obligation's optional page size) is repeated in `how` so the next call keeps it.
export function pagingOf({ start, end, total, pageSize, requested, limit }) {
  const keep = limit ? ` and limit=${limit}` : "";
  const next = end < total ? end : null;
  if (total > 0 && requested >= total) {
    return {
      page: null, pages: Math.ceil(total / pageSize), next_offset: null,
      how: `offset=${requested} is past the end of the section (${total} chars): nothing ` +
        "returned. Read from offset=0.",
    };
  }
  const page = Math.ceil(start / pageSize) + 1;
  const pages = page + Math.ceil((total - end) / pageSize);
  let how;
  if (next !== null) {
    how = `Page ${page} of ${pages}. More text follows: call get_obligation again with the ` +
      `same obligation_id and offset=${next}${keep}.`;
  } else if (start === 0) {
    how = "Complete: this is the whole section.";
  } else {
    how = `Last page (${page} of ${pages}): the section ends here. Text before offset ` +
      `${start} is not in this response; read from offset=0 for it.`;
  }
  return { page, pages, next_offset: next, how };
}

// Every count below is derived from the SERVED text (fix 2026-09-26). chars_total used to
// come from the build-time row.chars_total while the page was cut from row.verbatim; the
// loader had written 576 obligations with CRLF line endings, so the two disagreed (FHA
// II.A.8.d: 36,755 vs 37,578), the last page's offset + returned overshot chars_total and
// Claude abandoned the MCP for the web page. Invariants: chars_offset + chars_returned <=
// chars_total; next_offset is chars_offset + chars_returned or null; truncated is true
// exactly when text follows this response, started_mid_section when text precedes it
// (Round 4; before, truncated covered both, and a last page read "truncated").
//
// `limit` (owner's live test 2026-09-26: reading from an offset returned 17,272 chars to
// deliver ~500): at most this many chars per call, clamped to [MIN_LIMIT, maxChars]. Absent,
// the page is maxChars exactly as before.
export const MIN_LIMIT = 200;

export function clampLimit(limit, maxChars = MAX_CHARS) {
  if (limit === undefined || limit === null) return undefined;
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n)) return undefined;
  return Math.min(maxChars, Math.max(MIN_LIMIT, n));
}

export function buildEnvelope(row, { maxChars = MAX_CHARS, offset = 0, versions, limit } = {}) {
  const lim = clampLimit(limit, maxChars);
  const pageSize = lim ?? maxChars;
  const full = row.verbatim ?? "";
  const total = full.length;
  const requested = Math.max(0, offset | 0);
  const start = Math.min(requested, total);
  const shown = full.slice(start, start + pageSize);
  const end = start + shown.length;
  const paging = pagingOf({ start, end, total, pageSize, requested, limit: lim });
  return {
    ...provenance(row, versions),
    chars_offset: start,
    chars_returned: shown.length,
    chars_total: total,
    // Round 4 (stress2 I-25): `truncated` is true when text FOLLOWS this response (a last
    // page read from an offset is not truncated -- the section ends here). Text BEFORE the
    // offset is flagged separately by started_mid_section.
    truncated: end < total,
    started_mid_section: start > 0,
    next_offset: paging.next_offset,
    paging,
    verbatim: `<<<BEGIN VERBATIM>>>\n${shown}\n<<<END VERBATIM>>>`,
    figures: extractFigures(shown),
    editorial: { summary: null },
  };
}
