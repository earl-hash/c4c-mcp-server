// Title fit for search_regs ranking (Round 4, 2026-09-26; stress tests #2 and #3).
//
// What went wrong: the title signal was computed over the WHOLE section string, publication
// name included. "Special Servicing requirements" (Freddie 8104.1) lost to deleted stubs
// titled "Special delivery requirements ..." because "Seller/Servicer Guide" -- in every
// Freddie title -- stems to "servic" and so "servicing" matched every Freddie section; five
// VA Chapter 12 topics tied because "Chapter 12 (Minimum Property Requirement)" is in each
// topic's section string; the exact title "Rental income" (5306.1) lost to a longer title
// that also contains both words; "Requirements for Credit Reports" (B3-5.2-01) sat 4th in a
// tie with four other credit-report titles.
//
// Two measures over the section's OWN short title (shortTitle below: the text after the
// first " — ", without date stamps, page footers or the leading outline letter):
//   coverage   which query groups the short title names (drives TITLE_BOOST / SUBJECT_BOOST
//              in search.js, replacing the whole-string FTS title mask);
//   fit        how exactly the short title states the query: matched groups over the union
//              of query groups and title words (a Jaccard index). "Rental income" for
//              "rental income" is 1; a six-word title containing both words is 2/6.
// Words are compared on Porter stems (src/porter.js), the stemmer FTS5 applies to the text.

import { porter } from "./porter.js";

// Function words that never distinguish one title from another, plus question filler and
// title boilerplate ("requirements", "general", "overview": measured, counting "requirements"
// let every "... Appraisal Requirements" title outfit "Comparable Sales"). NOT the search
// STOPWORDS: "other" and "new" name what a section is about ("General Requirements for Other
// Sources of Income").
export const TITLE_IGNORE = new Set(`
  a an the and or but nor of for to in on at by with from as into onto than then so if
  is are was were be been being am do does did done doing what which who whom whose when
  where why how this that these those it its i me my we us our you your he she his her
  they them their can could should would will shall may might must also any all some such
  each etc vs versus per via please tell explain regarding about know need needs needed
  want wants use using someone somebody anyone anybody guideline guidelines guidance rule
  rules continued general overview requirement requirements
`.split(/\s+/).filter(Boolean));

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";

// The section's own title: after the first " — " (em dash; what precedes it is the
// publication and citation, what follows may itself contain a dash: "Chapter 24 — Single
// Family, Level Payment Pools and Loan Packages — Special Requirements"), with the markers our ingest
// appends removed. "" when the string carries no title words (a bare citation such as
// "12 CFR §1026.24(d)" or "M26-4 Chapter 5 — 5.02").
export function shortTitle(section) {
  let t = String(section ?? "")
    .replace(/^\s*\[?SUPERSEDED\]?\s*(?:—\s*)?(?:prior version[^—]*—\s*)?/i, "")
    .replace(/\s+—\s+PENDING VERSION\b.*$/i, "");
  const i = t.indexOf(" — ");
  if (i === -1) return "";
  t = t.slice(i + 3)
    .replace(new RegExp(`\\s*Published\\s+(?:${MONTHS})\\b.*$`), "")
    .replace(/\([^()]*\b\d{1,2}\/\d{1,2}\/\d{2,4}\b[^()]*\)/g, " ")
    .replace(/\((?:part\s+\d+\s+of\s+\d+|prior version|continued)\)/gi, " ")
    .replace(/^\s*(?:[a-z]|[ivxl]+|[A-Z]|\d{1,2})\.\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return /[A-Za-z]{2}/.test(t) ? t : "";
}

// The heading directly above a section in an outline path (FHA 4000.1 register titles:
// "... > 4. Underwriting the Borrower Using the TOTAL Mortgage Scorecard (TOTAL) — c. Income
// Requirements (TOTAL)" -> "Underwriting the Borrower Using the TOTAL Mortgage Scorecard
// (TOTAL)"). It counts toward title COVERAGE, never toward fit: "income requirements TOTAL
// scorecard" is about c. Income Requirements (TOTAL) because its parent names the scorecard.
export function parentHeading(title) {
  const head = String(title ?? "").split(" — ")[0];
  if (!head.includes(" > ")) return "";
  return head.split(" > ").pop()
    .replace(/\([^()]*\b\d{1,2}\/\d{1,2}\/\d{2,4}\b[^()]*\)/g, " ")
    .replace(/^\s*(?:[a-z]|[ivxl]+|[A-Z]|\d{1,2})\.\s+/, "")
    .replace(/\s+/g, " ").trim();
}

// Title words as Porter stems, function words dropped.
export function titleWordStems(title) {
  return titleWords(title).map(porter);
}

function titleWords(title) {
  const words = String(title ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.filter((w) => !TITLE_IGNORE.has(w));
}

// The crude suffix stemmer of src/subject.js (copied: importing it would close an import
// cycle). Porter leaves "refinance" ("refin") and "refinancing" ("refinanc") apart; a word
// meets a title word when EITHER stemmer says they are the same.
const SUFFIXES = ["ings", "ing", "ies", "ied", "es", "ed", "s", "e"];
function crude(word) {
  let w = String(word ?? "").toLowerCase();
  for (const suf of SUFFIXES) {
    if (w.length - suf.length >= 3 && w.endsWith(suf)) {
      w = w.slice(0, -suf.length);
      if (suf === "ies" || suf === "ied") w += "y";
      break;
    }
  }
  return w;
}

// Derivational suffixes neither stemmer folds (batch 10, stress6 C06 R20): "accurate" and
// the paragraph title "Accuracy of annual percentage rate" (12 CFR 1026.22(a)). Only for title
// matching; a stem shorter than four letters is not trusted. null when no suffix applies.
const DERIV = ["ation", "acy", "ate", "ship", "ity", "ment", "ness"];
function deriv(word) {
  const w = String(word ?? "").toLowerCase();
  for (const suf of DERIV) if (w.length - suf.length >= 4 && w.endsWith(suf)) return w.slice(0, -suf.length);
  return null;
}

// One group variant's words (the user's tokens, or a vocab alternative), function words
// dropped; [] when nothing is left.
function variantWords(words) {
  return words.flatMap((w) => String(w).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => !TITLE_IGNORE.has(w));
}

// For each group ({tokens, alts} as src/vocab.js groupTokens builds them): the indices of the
// title words matched by the first variant the title contains in full, or null.
function groupHits(title, groups) {
  const words = titleWords(title);
  const keys = words.map((w) => [porter(w), crude(w), deriv(w)]);
  const find = (v) => keys.findIndex(([p, c, d]) => p === porter(v) || c === crude(v) || (d && d === deriv(v)));
  return groups.map((g) => {
    const variants = [g.tokens, ...(g.alts ?? []).map((a) => a.split(/\s+/))]
      .map(variantWords).filter((v) => v.length);
    for (const v of variants) {
      const at = v.map(find);
      if (at.every((i) => i >= 0)) return at;
    }
    return null;
  });
}

// Indices of the groups the title names.
export function titleCoverage2(title, groups) {
  if (!title) return [];
  return groupHits(title, groups).flatMap((h, i) => (h ? [i] : []));
}

// Jaccard fit of a title to the query groups, 0..1: matched groups / (query groups + title
// words not accounted for by a matched group). Repeated title words count once.
// A "Category: Topic" title (Fannie's "Special Property Eligibility and Underwriting
// Considerations: Leasehold Estates") also fits by its topic alone -- the words before the colon
// name the subchapter the topic sits in, not what it says (batch 8, stress6 C05 R1: B2-3-03 lost
// "fnma leasehold requirements" to "Leasehold Interests Appraisal Requirements").
export function titleFit(title, groups) {
  const t = String(title ?? "");
  const colon = t.lastIndexOf(": ");
  const whole = jaccardFit(t, groups);
  return colon > 0 ? Math.max(whole, jaccardFit(t.slice(colon + 2), groups)) : whole;
}

function jaccardFit(title, groups) {
  if (!title || !groups.length) return 0;
  const words = titleWords(title);
  if (!words.length) return 0;
  const hits = groupHits(title, groups);
  const used = new Set(hits.filter(Boolean).flat().map((i) => porter(words[i])));
  let matched = hits.filter(Boolean).length;
  // Batch 10 (stress6 R3): an ACRONYM the title does not spell out still fits in part when the
  // title names words of its expansion. "fannie mae ira distribution income": B3-3.4-03
  // "Annuity, Pension, or Retirement Income" is about IRA distributions ("retirement" is a word
  // of "individual retirement account"); B3-3.4-06 "Employment Related Assets as Qualifying
  // Income" only mentions IRAs. The group counts as the share of its expansion's words the title
  // holds (one of three for IRA) and those words are not "extra". Fit only: matching and title
  // coverage are unchanged, so no row is found or counted all-terms through this. Expansions of
  // three or more words only -- a two-word one ("mortgage insurance") is half generic head.
  hits.forEach((h, gi) => {
    const g = groups[gi];
    if (h || !isAcronymGroup(g)) return;
    let best = 0;
    let bestWords = [];
    for (const alt of g.alts) {
      const v = variantWords(alt.split(/\s+/));
      if (v.length < 3) continue;
      const found = v.map((x) => words.findIndex((w) => porter(w) === porter(x) || crude(w) === crude(x)))
        .filter((i) => i >= 0 && !used.has(porter(words[i])));
      if (found.length / v.length > best) { best = found.length / v.length; bestWords = found; }
    }
    if (best > 0 && best < 1) {
      matched += best;
      for (const i of bestWords) used.add(porter(words[i]));
    }
  });
  const extra = new Set(words.map(porter).filter((w) => !used.has(w))).size;
  return matched / (groups.length + extra);
}

// A one-token group of 2-5 letters that the vocabulary expands to longer phrases (IRA, ARM).
function isAcronymGroup(g) {
  return g?.tokens?.length === 1 && /^[a-z]{2,5}$/.test(g.tokens[0]) && (g.alts ?? []).length > 0 &&
    !g.phrase;
}
