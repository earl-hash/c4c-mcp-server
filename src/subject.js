// Register TITLE matching for search_regs (2026-09-26, owner's live test C4C-04 / C4C-14).
//
// Why: "VA IRRRL requirements" never surfaced 38 U.S.C. 3709, 38 CFR 36.4307 or M26-7
// Chapter 6. The statute and CFR obligations are titled by citation only ("38 U.S.C.
// §3709(c)"), so the FTS title weight (search.js BM25_WEIGHTS) never saw that 3709 IS the
// refinancing statute; its subject lives only in the REGISTER title (registers.authority:
// "38 U.S.C. §3709 — Refinancing of housing loans"). Meanwhile long M26-7 chapters that
// mention IRRRLs in passing won on body-text frequency.
//
// This module decides, for one query, which query groups a title names. A register whose
// title names EVERY group is a SUBJECT register: the query is about exactly what that
// register is about. search.js boosts subject rows and fetches their best obligations even
// when body-text rank would have left them out of the candidate pool.
//
// Matching is on crude stems of whole words ("refinancing" ~ "refinance" ~ "refinances",
// "IRRRLs" ~ "IRRRL"), never substrings, so "arm" never matches "farm" and "mi" never
// "military". A group matches a title when all of the user's own words for it appear, or
// all content words of one of its vocab alternatives (src/vocab.js) do.

import { contentTokens } from "./tools/search.js";
import { familyFilterSql } from "./agency.js";

// Suffix stripping, in order; the stem must keep at least 3 characters. Only has to be
// consistent between a query word and a title word, not linguistically right.
const SUFFIXES = ["ings", "ing", "ies", "ied", "es", "ed", "s", "e"];

export function stem(word) {
  let w = String(word ?? "").toLowerCase().replace(/['’]s$/, "");
  for (const suf of SUFFIXES) {
    if (w.length - suf.length >= 3 && w.endsWith(suf)) {
      w = w.slice(0, -suf.length);
      if (suf === "ies" || suf === "ied") w += "y";
      break;
    }
  }
  return w;
}

// The stems of a title's words (letters/digits runs; "W-2" -> "w", "2").
export function titleStems(title) {
  const words = String(title ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.map(stem));
}

function allIn(words, stems) {
  return words.length > 0 && words.every((w) => stems.has(stem(w)));
}

// Does `title` (its stem set) name this group (src/vocab.js groupTokens shape)?
export function groupInTitle(group, stems) {
  if (allIn(group.tokens, stems)) return true;
  return (group.alts ?? []).some((alt) => allIn(contentTokens(alt), stems));
}

// Indices of the groups a title names.
export function titleCoverage(title, groups) {
  if (!title) return [];
  const stems = titleStems(title);
  const out = [];
  groups.forEach((g, i) => { if (groupInTitle(g, stems)) out.push(i); });
  return out;
}

// SQL prefilter for subject registers: a cheap LIKE per word of each group variant,
// ANDed within a variant, ORed across variants, ANDed across groups. It over-matches
// (substrings); titleCoverage above is authoritative. Returns null when the query would
// need more bound parameters than D1 allows (100) -- then no subject lookup is made.
export const MAX_SUBJECT_PARAMS = 90;

function likeStem(w) {
  return `%${stem(w).replace(/[%_\\]/g, "")}%`;
}

export function subjectPrefilter(groups) {
  const params = [];
  const conds = [];
  for (const g of groups) {
    const variants = [g.tokens, ...(g.alts ?? []).map((a) => contentTokens(a))]
      .filter((v) => v.length);
    const ors = variants.map((v) => {
      const ands = v.map((w) => { params.push(likeStem(w)); return `r.authority LIKE ?${params.length + 1}`; });
      return `(${ands.join(" AND ")})`;
    });
    if (!ors.length) return null;
    conds.push(`(${ors.join(" OR ")})`);
  }
  if (!conds.length || params.length > MAX_SUBJECT_PARAMS) return null;
  // ?1 is the family filter; the LIKE parameters follow from ?2.
  return {
    sql: `SELECT r.register_id, r.authority FROM registers r
          WHERE ${familyFilterSql(1)} AND ${conds.join(" AND ")} LIMIT 200`,
    params,
  };
}

// Special programs (C4C-14): a section that applies only to one program (Freddie's Home
// Possible, Fannie's HomeReady / HomeStyle, FHA 203(k) or HECM ...) outranked the general
// rule for a general question (owner's test 2: 4501.6 Home Possible above 5306.1 for
// "rental income"). Such a row is demoted unless the query names the program. `title`
// matches the section or register title; `query` the raw query text.
export const PROGRAMS = [
  { name: "Home Possible", title: /\bhome\s*possible\b/i, query: /\bhome\s*possible\b/i },
  { name: "HomeReady", title: /\bhome\s*ready\b/i, query: /\bhome\s*ready\b/i },
  { name: "HomeStyle", title: /\bhome\s*style\b/i, query: /\bhome\s*style\b|\brenovation\b/i },
  { name: "HomeOne", title: /\bhome\s*one\b/i, query: /\bhome\s*one\b/i },
  { name: "RefiNow / Refi Possible", title: /\brefi\s*(?:now|possible)\b/i, query: /\brefi\s*(?:now|possible)\b/i },
  { name: "CHOICERenovation / CHOICEHome", title: /\bchoice\s*(?:renovation|home|reno)\b/i, query: /\bchoice\s*(?:renovation|home|reno)\b|\brenovation\b/i },
  { name: "GreenCHOICE", title: /\bgreen\s*choice\b/i, query: /\bgreen\s*choice\b|\benergy\b/i },
  { name: "203(k)", title: /\b203\s*\(?k\)?/i, query: /\b203\s*\(?k\b|\brehabilitation\b|\brenovation\b/i },
  // Round 4 (stress3 RANK-04): 4000.1's reverse-mortgage parts are titled "Title II Insured
  // Housing Programs Reverse Mortgages" (search.js also tags Parts II.B / III.B by citation).
  { name: "HECM", title: /\bHECM\b|\bhome equity conversion\b|\bInsured Housing Programs Reverse Mortgages?\b/i, query: /\bhecm\b|\bhome equity conversion\b|\breverse mortgage/i },
  { name: "HeritageOne", title: /\bheritage\s*one\b/i, query: /\bheritage\s*one\b|\btribal\b|\bnative american\b/i },
  { name: "Energy Efficient Mortgage", title: /\benergy efficient mortgage/i, query: /\benergy\b|\beem\b/i },
  { name: "Section 184", title: /\bsection 184\b/i, query: /\b184\b|\bindian\b|\bnative american\b/i },
  { name: "Good Neighbor Next Door", title: /\bgood neighbor next door\b/i, query: /\bgood neighbor\b/i },
  { name: "Title I", title: /\btitle i\b(?!i)/i, query: /\btitle i\b(?!i)|\bproperty improvement\b/i },
  { name: "Community Land Trust", title: /\bcommunity land trust\b/i, query: /\bland trust\b/i },
  { name: "Construction conversion", title: /\bconstruction conversion\b|\bconstruction-to-permanent\b/i, query: /\bconstruction\b/i },
];

// The special program a row's titles name and the query does not, or null.
export function unnamedProgram(query, ...titles) {
  const t = titles.filter(Boolean).join(" • ");
  if (!t) return null;
  const hit = PROGRAMS.find((p) => p.title.test(t) && !p.query.test(String(query ?? "")));
  return hit ? hit.name : null;
}
