// Citation string -> canonical identifier.
//
// Ported from scripts/score-target-register.py. THREE ORDERING RULES ARE LOAD-BEARING:
//   1. FHA is tested BEFORE Freddie. The Freddie pattern \d{4}\.\d+ matches "4000.1",
//      which is the FHA handbook NAME, not a Freddie section. Reversing these
//      reports HUD citations as Freddie and produces a fake 100% accuracy.
//   2. U+2011 (non-breaking hyphen) normalizes to "-" before any matching. A single
//      U+2011 in a citation silently produced a MISS in the Python scorer.
//   3. CFR (rule 3a) is tested BEFORE the generic Freddie catch-all (rule 3b), same
//      ordering lesson as (1): \d{4}\.\d+ also matches bare CFR section numbers like
//      "1026.19" (Reg Z) and would mislabel them "fhlmc" -- a false regulator
//      attribution -- if the more specific CFR rule didn't get a turn first. Added in
//      Task 6 fix round 1 (Defect B): 22% of the corpus's obligations (1,814/8,263
//      across 335 registers) carry CFR authorities (Reg Z/X/B, HMDA); there was no
//      "cfr" kind at all before this rule existed.
//
// NOTE (Task 1 discovery): normalizeForMatch()'s NFKC fold table deliberately excludes
// U+2010 -- so this file's own DASHES regex (which covers both U+2010 and U+2011) is
// the only thing making citation matching hyphen-insensitive. Do not rely on
// normalizeForMatch to have done this already.
//
// NOTE (Task 6 fix round 2): CFR_PARTS below is GENERATED, not hand-curated. A
// hand-written ~16-part allowlist (fix round 1) missed 13 of the corpus's 23 real
// CFR parts, including the two biggest by volume (3555 USDA Rural Development, 1022
// Regulation V/FCRA) -- the corpus spans CFPB, USDA, SBA, FTC and FDIC rules, and no
// hand list stays correct as regulators are added. See scripts/build-mcp-index.py's
// collect_cfr_parts/write_cfr_parts_module for how this file is produced; never
// hand-edit cfr-parts.generated.js, regenerate it by re-running the build script.
//
// NOTE (Task 6 fix round 3): admitting short (1-3 digit) CFR parts in round 2 made
// ordinary mortgage-compliance prose parse as a confident CFR citation -- "a 34.2
// percent LTV ratio" has exactly the \d{1,4}\.\d+ shape as a real CFR cite, and "34"
// is a genuine part (OCC AVM rules). A bare 4-digit part.section (e.g. "1026.19")
// stays accepted without a marker: it's the shape the live corpus's citations
// overwhelmingly use bare, and 4 digits is specific enough that this collision
// class doesn't occur in practice. A short 1-3 digit part is now accepted ONLY
// when the string also carries an explicit CFR marker ("CFR", "Regulation V",
// "Reg Z", etc.) -- see CFR_MARKER_RE below.

import { CFR_PARTS } from "./cfr-parts.generated.js";
import { collapseCandidates } from "./aliases.js";

// Matches the literal "CFR" marker or a named regulation reference. Deliberately
// checked against the whole input string, not scoped near the matched number --
// unlike scripts/build-mcp-index.py's extract_cfr_part (which starts its number
// search from the marker, because it's disambiguating which of several numbers in
// a long authority string is the CFR one), here there is exactly one number
// candidate per short-citation input, so "does a marker exist anywhere" is the
// right question, not "is a marker immediately adjacent."
// mf-3 (2026-10-14): "C.F.R." and a section sign directly before the number ("§ 221.751",
// "Sec. 207.258") are markers too -- the regulation's own cross-references are written
// "§ 200.71", and with 3-digit parts (24 CFR 200, 207, 221) that form never parsed. A bare
// "section" is not: prose says "section 22.5 of the agreement".
const CFR_MARKER_RE = /\bC\.?\s?F\.?\s?R\b|\bRegulation\s+[A-Z]\b|\bReg\.?\s+[A-Z]\b|(?:§§?|\bSec\.)\s*\d{1,4}\.\d/i;

const DASHES = /[‐‑‒–—―−－﹣­]/g;

// ---- Handbook, notice and SOP cites (C4C-09, owner's live test 2026-09-26) ----
// "M26-7 Chapter 4 Topic 9" came back `unparsed` although the tool's own `ambiguous`
// response offers exactly that format; so did "5000-872764" and "SBA Policy Notice
// 5000-872764". These documents' registers are named by their structure, so a parsed
// cite maps straight to register ids (`register_ids`, tried in order: a topic, then the
// chapter register that may hold it). Parsed but absent is `not_found`, never `unparsed`.
const VA_HB = /\b(?:VA\s+)?(?:M\s?26-?|(?:VA\s+)?Pamphlet\s+26-)([47])\b[\s,]*(?:Chapter|Ch\.?|Chap\.?)\s*(\d{1,2})\b(?:[\s,]*(?:Topic|T\.?)\s*(\d{1,2})\b)?(?:[\s,]*(?:Subsection\s+([a-z])\b|\(([a-z])\)))?/i;
const VA_HB_APP = /\bM\s?26-?4\b[\s,]*(?:Appendix|App\.?)\s*([A-Z])\b/i;
const SBA_NOTICE = /\b(5000-\d{5,7})\b/;
const SBA_SOP = /\bSOP\s*50\s*10(?:\s*(\d(?:\.\d)?))?[\s,]+(?:(?:Subpart|Part)\s+)?([A-C])[\s.,]*Ch(?:apter)?\.?\s*(\d{1,2})(?:[\s.,]+([A-Z])(?![a-z]))?(?:[\s.,]+(\d{1,2}))?/i;
const SBA_SOP_APP = /\bSOP\s*50\s*10(?:\s*(\d(?:\.\d)?))?[\s,]+App(?:endix|\.)?\s*(\d{1,2})\b(?:[\s.,]+([A-Z])(?![a-z]))?(?:[\s.,]+(\d{1,2}))?/i;
const USDA_HB = /\bHB-?\s?1-?\s?3555\b[^0-9]{0,30}?(\d{1,2})(?:\.(\d{1,2}))?\b/i;
// Round 4 (stress2 Q12): "chapter 18 of gnma guide" / "Ginnie Mae MBS Guide Ch. 18". The
// Ginnie Mae MBS Guide's chapter registers are gnma-mbs-chNN.
const GNMA_WORD = String.raw`(?:gnma|ginnie(?:\s+mae)?|mbs\s+guide|5500\.3)`;
const GNMA_CH = new RegExp(
  String.raw`\b${GNMA_WORD}\b[^0-9]{0,40}?\b(?:chapter|chap\.?|ch\.?)\s*(\d{1,2})\b|` +
  String.raw`\b(?:chapter|chap\.?|ch\.?)\s*(\d{1,2})\b[^0-9]{0,40}?\b${GNMA_WORD}\b`,
  "i",
);

const pad2 = (n) => String(Number(n)).padStart(2, "0");

// mf-2a (2026-10-14): HUD's MAP Guide (Multifamily Accelerated Processing Guide, Handbook 4430.G
// REV-3, the "2020 MAP Guide"). HUD cites it "Section 9.6.19.B of the 2020 MAP Guide", "MAP Guide
// Section 9.6.8", "MAP Guide Chapter 9"; the canonical form here is "MAP Guide 3.2.1" /
// "MAP Guide Chapter 3" / "MAP Guide Appendix 5" / "MAP Guide A.5.1". One register per chapter
// (hud-4430g-ch03), one obligation per level-2/3 section (hud-4430g-3-2-1); appendices (batch
// mf-2b) are hud-4430g-app05 / hud-4430g-a-5-1, the back matter hud-4430g-glossary /
// hud-4430g-acronyms. A deeper pinpoint ("9.6.8.K", "3.6.3.1") resolves to the section that holds
// it; mf-2b cut the two longest level-3 sections (19.4.7, A.2.1.1) at level 4 (19.4.7.1), so ids
// are tried from depth 4 down. Tested before every other rule: "4430.G 3.2.1" must never read as
// a CFR or Freddie number.
const MAPG_NAME = String.raw`(?:(?:the\s+)?(?:20(?:20|16)\s+)?MAP\s+Guide(?:\s*\((?:HUD\s+)?(?:Handbook\s+)?4430\.G[^)]{0,12}\))?|(?:HUD\s+)?(?:Handbook\s+)?4430\.G(?:\s*,?\s*REV-?\s*3)?(?:\s*\((?:20(?:20|16)\s+)?MAP\s+Guide\))?)`;
const MAPG_SEC = String.raw`(\d{1,2}(?:\.\d{1,2}){1,4})(?:\.([A-Z]))?(?![\d.]*\d)`;
const MAPG_APPSEC = String.raw`A\.(\d{1,2})((?:\.\d{1,2}){1,3})(?:\.([A-Z]))?`;
const MAPG_SEC_AFTER = new RegExp(String.raw`\b${MAPG_NAME}[\s,]*(?:(?:Section|Sec\.?|§+|¶)\s*)?${MAPG_SEC}`, "i");
const MAPG_SEC_BEFORE = new RegExp(String.raw`(?:Section|Sec\.?|§+)\s*${MAPG_SEC}\s+(?:of|in)\s+${MAPG_NAME}`, "i");
const MAPG_CH = new RegExp(String.raw`\b${MAPG_NAME}[\s,]*(?:Chapter|Ch\.?|Chap\.?)\s*(\d{1,2})\b|(?:Chapter|Ch\.?|Chap\.?)\s*(\d{1,2})\s+(?:of|in)\s+${MAPG_NAME}`, "i");
const MAPG_APP = new RegExp(String.raw`\b${MAPG_NAME}[\s,]*(?:Appendix|App\.?)\s*(\d{1,2})\b|(?:Appendix|App\.?)\s*(\d{1,2})\s+(?:of|in|to)\s+${MAPG_NAME}`, "i");
const MAPG_BACK = new RegExp(String.raw`\b${MAPG_NAME}[\s,'’s]*(Glossary|Acronyms?(?:\s+and\s+Abbreviations?)?(?:\s+List)?)\b|\b(Glossary|Acronyms?(?:\s+and\s+Abbreviations?)?(?:\s+List)?)\s+(?:of|in|to)\s+${MAPG_NAME}`, "i");
const MAPG_APP_SEC = new RegExp(String.raw`\b${MAPG_NAME}[\s,]*(?:(?:Appendix|App\.?|Section|Sec\.?|§+)\s*)?${MAPG_APPSEC}|(?:Section|Sec\.?|§+)?\s*${MAPG_APPSEC}\s+(?:of|in)\s+${MAPG_NAME}`, "i");
export const MAPG_PREFIX = "hud-4430g-";

function mapGuideSection(num, letter) {
  const parts = num.split(".").map(Number);
  const rid = `${MAPG_PREFIX}ch${pad2(parts[0])}`;
  const shown = `${parts.join(".")}${letter ? `.${letter.toUpperCase()}` : ""}`;
  // obligations exist at depths 2-4 (4 only where a long level-3 section is split): the cited
  // depth (at most 4), then each parent
  const ids = [];
  for (let d = Math.min(parts.length, 4); d >= 2; d--) ids.push(`${rid}::${MAPG_PREFIX}${parts.slice(0, d).join("-")}`);
  return { kind: "map-guide", canonical: `MAP Guide ${shown}`, register_ids: [rid], obligation_ids: ids,
    // a level-2 (or split level-3) cite: its sections are listed (its own text may be only a heading)
    ...(parts.length <= 3 && !letter ? { obligation_prefix: `${rid}::${MAPG_PREFIX}${parts.join("-")}-` } : {}) };
}

function mapGuideAppendixSection(app, rest, letter) {
  const parts = [Number(app), ...rest.split(".").filter(Boolean).map(Number)];
  const rid = `${MAPG_PREFIX}app${pad2(app)}`;
  const ids = [];
  for (let d = Math.min(parts.length, 4); d >= 2; d--) ids.push(`${rid}::${MAPG_PREFIX}a-${parts.slice(0, d).join("-")}`);
  return { kind: "map-guide", canonical: `MAP Guide A.${parts.join(".")}${letter ? `.${letter.toUpperCase()}` : ""}`,
    register_ids: [rid], obligation_ids: ids,
    ...(parts.length <= 3 && !letter ? { obligation_prefix: `${rid}::${MAPG_PREFIX}a-${parts.join("-")}-` } : {}) };
}

export function parseMapGuide(s) {
  let m;
  if ((m = s.match(MAPG_BACK))) {
    const glossary = /^glossary$/i.test(m[1] ?? m[2]);
    return glossary
      ? { kind: "map-guide", canonical: "MAP Guide Glossary", register_ids: [`${MAPG_PREFIX}glossary`] }
      : { kind: "map-guide", canonical: "MAP Guide Acronym and Abbreviation List", register_ids: [`${MAPG_PREFIX}acronyms`] };
  }
  if ((m = s.match(MAPG_APP_SEC))) return mapGuideAppendixSection(m[1] ?? m[4], m[2] ?? m[5], m[3] ?? m[6]);
  if ((m = s.match(MAPG_SEC_AFTER)) || (m = s.match(MAPG_SEC_BEFORE))) return mapGuideSection(m[1], m[2]);
  if ((m = s.match(MAPG_CH))) {
    const ch = Number(m[1] ?? m[2]);
    return { kind: "map-guide", canonical: `MAP Guide Chapter ${ch}`, register_ids: [`${MAPG_PREFIX}ch${pad2(ch)}`] };
  }
  if ((m = s.match(MAPG_APP))) {
    const app = Number(m[1] ?? m[2]);
    return { kind: "map-guide", canonical: `MAP Guide Appendix ${app}`, register_ids: [`${MAPG_PREFIX}app${pad2(app)}`],
      register_prefix: `${MAPG_PREFIX}app${pad2(app)}` };
  }
  return null;
}

// Batch 8 (stress6 C06 N7 / C10): VA's handbooks by name. "VA Servicer Handbook" is M26-4; "VA
// Lenders Handbook" -- and a bare "VA handbook", the name VA's Lenders Handbook (Pamphlet 26-7)
// goes by -- is M26-7. "va handbook chapter 4" returned nineteen M26-4 sections first.
export function vaHandbookName(s) {
  return String(s ?? "")
    .replace(/\bVA\s+servic(?:er|ing)\s+handbook\b/gi, "M26-4")
    .replace(/\b(?:VA\s+)?lenders?['’]?s?\s+handbook\b/gi, "M26-7")
    .replace(/\bVA\s+handbook\b/gi, "M26-7");
}

// Round 4 (stress3 Q11): numbered issuances name their register by id too. "Mortgagee Letter
// 2026-08 loss mitigation" ranked the letter third behind handbook sections that mention
// loss mitigation more often.
const ISSUANCES = [
  [/\b(?:ML|Mortgagee\s+Letter)\s*(?:No\.?\s*)?(\d{4})-(\d{1,2})\b/i,
    (y, n) => ({ kind: "hud-ml", canonical: `Mortgagee Letter ${y}-${pad2(n)}`, register_ids: [`hud-ml-${y}-${pad2(n)}`] })],
  [/\b(?:Lender\s+Letter\s+)?LL-?\s?(\d{4})-(\d{1,2})\b/i,
    (y, n) => ({ kind: "fnma-ll", canonical: `Fannie Mae Lender Letter LL-${y}-${pad2(n)}`, register_ids: [`fnma-ll-${y}-${pad2(n)}`] })],
  [/\b(SEL|SVC)-(\d{4})-(\d{1,2})\b/i,
    (k, y, n) => ({ kind: "fnma-announcement", canonical: `Fannie Mae Announcement ${k.toUpperCase()}-${y}-${pad2(n)}`,
      register_ids: [`fnma-${k.toLowerCase()}-${y}-${pad2(n)}`] })],
  [/\bBulletin\s+(?:No\.?\s*)?(\d{4})-(\d{1,2})\b/i,
    (y, n) => ({ kind: "fhlmc-bulletin", canonical: `Freddie Mac Bulletin ${y}-${Number(n)}`,
      register_ids: [`fhlmc-bulletin-${y}-${Number(n)}`] })],
  // Freddie's lettered bulletins (2026-C, 2026-H...) are a series apart from the numbered ones.
  [/\bBulletin\s+(?:No\.?\s*)?(\d{4})-([A-Z])(?![A-Za-z0-9])/i,
    (y, l) => ({ kind: "fhlmc-bulletin", canonical: `Freddie Mac Bulletin ${y}-${l.toUpperCase()}`,
      register_ids: [`fhlmc-bulletin-${y}-${l.toLowerCase()}`] })],
  [/\bAPM\s*(\d{2})-(\d{1,2})\b/i,
    (y, n) => ({ kind: "gnma-apm", canonical: `Ginnie Mae APM ${y}-${pad2(n)}`, register_ids: [`gnma-apm-${y}-${pad2(n)}`] })],
  [/\bCircular\s+(\d{2})-(\d{2})-(\d{1,2})\b/i,
    (a, b, n) => ({ kind: "va-circular", canonical: `VA Circular ${a}-${b}-${Number(n)}`,
      register_ids: [`va-circular-${a}-${b}-${pad2(n)}`] })],
];

// Batch 8 (stress6 C10): chapter-level cites search_regs itself emits as canonical_citation --
// Fannie "B8-8" / "A4-1" / "B-6" (the chapter registers fnma-sel-b8-8, fnma-svc-a4-1 ...) and
// "Freddie Mac Guide Chapter 9501" -- matched only as the WHOLE string, so a topic cite or prose
// never reads as a chapter. A Guide qualifier picks the Guide; otherwise both are tried in order.
const FNMA_CHAPTER = /^(?:Fannie\s+Mae\s+)?(?:(Selling|Servicing)\s+Guide\s+)?(?:Chapter\s+)?([A-F]\d?-\d{1,2})$/i;
const FHLMC_CHAPTER = /^(?:Freddie\s+Mac\s+)?(?:(?:Single-Family\s+)?(?:Seller\/Servicer\s+)?Guide\s+)?Chapter\s+(\d{4})$/i;

// gl-1 (2026-10-15): the agency glossaries. Fannie's is Selling Guide Chapter E-3, "Acronyms and
// Glossary of Defined Terms" (register fnma-sel-e-3, one register per letter topic,
// fnma-sel-e-3-01 A ... -25 Y; J, K, Q, X, Z have no terms); Freddie's is published beside the
// Guide's chapters (register fhlmc-glossary, one obligation per letter block). Matched only as
// the whole string ("Fannie Mae Glossary", "Selling Guide Glossary", "Glossary of the Freddie
// Mac Guide", "Freddie Mac Seller/Servicer Guide Glossary"), so prose that mentions a glossary
// never reads as a cite. Freddie is tested first: "Seller/Servicer Guide" is Freddie's name.
const GLOSSARY_WORD = String.raw`(?:Acronyms\s+and\s+)?Glossary(?:\s+of\s+Defined\s+Terms)?`;
const FHLMC_NAME = String.raw`(?:Freddie\s+Mac|FHLMC)(?:\s+Single-Family)?(?:\s+Seller\/Servicer)?(?:\s+Guide)?|(?:Freddie\s+Mac\s+)?(?:Single-Family\s+)?Seller\/Servicer\s+Guide`;
const FNMA_NAME = String.raw`(?:Fannie\s+Mae|FNMA)(?:\s+Selling\s+Guide)?|(?:Fannie\s+Mae\s+)?Selling\s+Guide`;
const glossaryRe = (name) => new RegExp(String.raw`^(?:the\s+)?(?:(?:${name})(?:['’]s)?[\s,]+${GLOSSARY_WORD}|${GLOSSARY_WORD}\s+(?:of|in|to)\s+(?:the\s+)?(?:${name}))$`, "i");
const FHLMC_GLOSSARY = glossaryRe(FHLMC_NAME);
const FNMA_GLOSSARY = glossaryRe(FNMA_NAME);
const FNMA_GLOSSARY_CHAPTER = { kind: "fnma-chapter", canonical: "E-3", register_ids: ["fnma-sel-e-3"],
  topic_prefix: "fnma-sel-e-3-", glossary: "Fannie Mae Selling Guide Chapter E-3, Acronyms and Glossary of Defined Terms" };

// cg-1 (2026-10-18): named documents the corpus holds under no section number, matched only as
// the WHOLE string (prose that mentions them is not a cite); register_ids are tried in order.
// FHFA conforming loan limits (scripts/ingest-cg1.py --part fhfa): one register set per year,
// fhfa-cll-YYYY (the announcement), -methodology, -faqs. A cite with a year names that year; a
// bare "conforming loan limits" names the latest year held (next year first, so the 2027
// registers answer as soon as they exist).
const CLL_WORDS = String.raw`(?:conforming\s+loan\s+limits?(?:\s+values?)?(?:\s*\(CLLs?\))?|CLLs?)`;
const CLL_YEAR = new RegExp(String.raw`^(?:the\s+)?(?:(20\d\d)\s+(?:FHFA\s+)?${CLL_WORDS}|(?:FHFA\s+)?${CLL_WORDS}\s+(?:for|in)\s+(20\d\d))$`, "i");
const CLL_ANY = new RegExp(String.raw`^(?:the\s+)?(?:FHFA(?:['’]s)?\s+)?(?:current\s+)?${CLL_WORDS}(?:\s+\(FHFA\))?$`, "i");
const CLL_FIRST_YEAR = 2026;
function cllYear(y) {
  return { kind: "fhfa-cll", canonical: `FHFA Conforming Loan Limit Values for ${y}`,
    register_ids: [`fhfa-cll-${y}`, `fhfa-cll-${y}-methodology`, `fhfa-cll-${y}-faqs`] };
}
// IRS tax-transcript forms (scripts/ingest-cg1.py --part irs): Form 8821 (Tax Information
// Authorization) and its Instructions; Form 4506-C (IVES Request for Transcript of Tax Return,
// instructions on the form). "IVES" alone names Form 4506-C, the IVES request form.
const IRS_FORM = String.raw`(?:(?:IRS|Internal\s+Revenue\s+Service)\s+)?(?:Form\s+)?`;
const F8821_INST = new RegExp(String.raw`^(?:the\s+)?(?:(?:IRS\s+)?Instructions\s+for\s+(?:IRS\s+)?Form\s+8821|${IRS_FORM}8821\s+instructions)$`, "i");
const F8821 = new RegExp(String.raw`^(?:the\s+)?${IRS_FORM}8821(?:\s*(?:,|-|—)?\s*(?:\(\s*)?Tax\s+Information\s+Authorization\)?)?$|^(?:the\s+)?(?:IRS\s+)?Tax\s+Information\s+Authorization(?:\s+\(Form\s+8821\))?$`, "i");
const F4506C = new RegExp(String.raw`^(?:the\s+)?${IRS_FORM}4506\s*-?\s*C(?:\s*(?:,|-|—)?\s*(?:\(\s*)?IVES\s+Request\s+for\s+Transcript\s+of\s+Tax\s+Return\)?)?$|^(?:the\s+)?(?:IRS\s+)?IVES(?:\s+(?:form|request(?:\s+form)?|Request\s+for\s+Transcript\s+of\s+Tax\s+Return))?$|^(?:the\s+)?(?:IRS\s+)?Income\s+Verification\s+Express\s+Service(?:\s+\(IVES\))?$`, "i");
// Identity Theft Red Flags Rule (scripts/ingest-cg1.py --part redflags). Each agency issues it
// for the creditors it supervises; the name alone means the FTC's 16 CFR 681.1 (non-bank
// creditors, incl. most independent mortgage companies), and the parse lists the banking
// agencies' versions. CFPB's Regulation V has none (12 CFR 1022 Subparts J-L are reserved).
const RF_VERSIONS = ["12 CFR 41.90 (OCC)", "12 CFR 222.90 (Federal Reserve Board)", "12 CFR 334.90 (FDIC)",
  "12 CFR 717.90 (NCUA)"];
const RF_NOTE = "16 CFR 681.1 is the FTC's rule (financial institutions and creditors under FTC jurisdiction, " +
  "including most non-bank mortgage lenders); banks, savings associations and federal credit unions follow " +
  "their regulator's version (also_issued_as). The CFPB has no Red Flags rule.";
const RED_FLAGS = /^(?:the\s+)?(?:FTC(?:['’]s)?\s+)?(?:(?:identity\s+theft\s+)?red\s+flags?(?:\s+rule)?|identity\s+theft\s+red\s+flags?\s+rule|identity\s+theft\s+prevention\s+program\s+rule)$/i;
const RF_GUIDELINES = /^(?:the\s+)?(?:FTC\s+)?(?:Interagency\s+Guidelines\s+on\s+Identity\s+Theft\s+Detection,?\s+Prevention,?\s+and\s+Mitigation|Red\s+Flags?\s+(?:Rule\s+)?Guidelines|Supplement\s+A\s+to\s+Appendix\s+A(?:\s+to\s+(?:16\s+CFR\s+)?Part\s+681)?)$/i;
const RF_APPENDIX = /^(?:the\s+)?(?:(12|16)\s*C\.?F\.?R\.?\s*(?:Part\s*)?(681|41|222|334|717)\s*,?\s*)?Appendix\s+([AJ])(?:\s+to\s+(?:(?:12|16)\s*C\.?F\.?R\.?\s*)?Part\s+(681|41|222|334|717))?$/i;
const RF_PREFIX = { 681: "ftc-16cfr", 41: "occ-12cfr", 222: "frb-12cfr", 334: "fdic-12cfr", 717: "ncua-12cfr" };
function parseRedFlags(s) {
  if (RED_FLAGS.test(s)) {
    return { kind: "red-flags", canonical: "16 CFR 681.1 (Identity Theft Red Flags Rule)",
      register_ids: ["ftc-16cfr-681-1", "ftc-16cfr-681.1", "ftc-16cfr-681-appendix-a"], also_issued_as: [...RF_VERSIONS], scope_note: RF_NOTE };
  }
  if (RF_GUIDELINES.test(s)) {
    return { kind: "red-flags", canonical: "16 CFR Part 681, Appendix A",
      register_ids: ["ftc-16cfr-681-appendix-a"],
      also_issued_as: ["12 CFR Part 41, Appendix J (OCC)", "12 CFR Part 222, Appendix J (Federal Reserve Board)",
        "12 CFR Part 334, Appendix J (FDIC)", "12 CFR Part 717, Appendix J (NCUA)"], scope_note: RF_NOTE };
  }
  const m = s.match(RF_APPENDIX);
  if (m && (m[2] || m[4]) && (!m[2] || !m[4] || m[2] === m[4])) {
    const part = m[2] ?? m[4];
    const letter = part === "681" ? "A" : "J";
    if (m[3].toUpperCase() !== letter) return null;
    return { kind: "red-flags", canonical: `${part === "681" ? 16 : 12} CFR Part ${part}, Appendix ${letter}`,
      register_ids: [`${RF_PREFIX[part]}-${part}-appendix-${letter.toLowerCase()}`] };
  }
  return null;
}

const NAMED = [
  [F8821_INST, { kind: "irs-form", canonical: "Instructions for IRS Form 8821", register_ids: ["irs-form-8821-instructions", "irs-form-8821"] }],
  [F8821, { kind: "irs-form", canonical: "IRS Form 8821", register_ids: ["irs-form-8821", "irs-form-8821-instructions"] }],
  [F4506C, { kind: "irs-form", canonical: "IRS Form 4506-C", register_ids: ["irs-form-4506-c"] }],
];

function parseNamed(s) {
  let m;
  for (const [re, out] of NAMED) if (re.test(s)) return { ...out, register_ids: [...out.register_ids] };
  const rf = parseRedFlags(s);
  if (rf) return rf;
  if ((m = s.match(CLL_YEAR))) return cllYear(m[1] ?? m[2]);
  if (CLL_ANY.test(s)) {
    const ids = [];
    for (let y = new Date().getUTCFullYear() + 1; y >= CLL_FIRST_YEAR; y--) ids.push(`fhfa-cll-${y}`);
    return { kind: "fhfa-cll", canonical: "FHFA Conforming Loan Limit Values (latest year held)", register_ids: ids };
  }
  return null;
}

const URAR_APP = /\bAppendix\s+([BF])\s*-?\s*1\b/i;
const URAR_APP_E = /\b(?:URAR|UAD)\b[^.;]{0,30}\bAppendix\s+E\b/i;
const URAR_APPENDICES = {
  F: { id: "uad-3-6-reference-guide", name: "UAD 3.6 URAR Reference Guide" },
  B: { id: "uad-3-6-implementation-guide", name: "UAD 3.6 Implementation Guide" },
  E: { id: "uad-3-6-report-style-guide", name: "UAD 3.6 URAR Report Style Guide" },
};
function parseStructured(s) {
  let m;
  const mapg = parseMapGuide(s);
  if (mapg) return mapg;
  const named = parseNamed(s);
  if (named) return named;
  if (FHLMC_GLOSSARY.test(s)) {
    return { kind: "fhlmc-glossary", canonical: "Freddie Mac Guide Glossary", register_ids: ["fhlmc-glossary"] };
  }
  if (FNMA_GLOSSARY.test(s)) return { ...FNMA_GLOSSARY_CHAPTER };
  if ((m = s.match(FNMA_CHAPTER))) {
    const code = m[2].toUpperCase();
    const id = code.toLowerCase();
    const guide = m[1]?.toLowerCase();
    // gl-1: the Selling Guide's glossary chapter lists its letter topics
    if (guide === "selling" && id === "e-3") return { ...FNMA_GLOSSARY_CHAPTER };
    const order = guide === "selling" ? ["sel"] : guide === "servicing" ? ["svc"]
      : /^[A-F]\d/.test(code) ? ["sel", "svc"] : ["svc", "sel"];
    return { kind: "fnma-chapter", canonical: code, register_ids: order.map((g) => `fnma-${g}-${id}`),
      ...(order.length > 1 ? { any_of: true } : {}) };
  }
  if ((m = s.match(FHLMC_CHAPTER))) {
    return { kind: "fhlmc-chapter", canonical: `Freddie Mac Guide Chapter ${m[1]}`, register_ids: [`fhlmc-${m[1]}`] };
  }
  for (const [re, build] of ISSUANCES) {
    if ((m = s.match(re))) return build(...m.slice(1));
  }
  if ((m = s.match(GNMA_CH))) {
    const ch = m[1] ?? m[2];
    return { kind: "gnma-mbs", canonical: `Ginnie Mae MBS Guide Ch. ${Number(ch)}`,
      register_ids: [`gnma-mbs-ch${pad2(ch)}`] };
  }
  if ((m = s.match(VA_HB_APP))) {
    return { kind: "va-handbook", canonical: `M26-4 App. ${m[1].toUpperCase()}`,
      register_ids: [`va-m26-4-appendix-${m[1].toLowerCase()}`] };
  }
  // Batch 13 (eval B12): the joint GSE URAR appendices -- "Fannie Mae Selling Guide Appendix
  // F-1", "URAR Appendix F-1", "appendix f 1" -- are the UAD 3.6 guides (Uniform Mortgage Data
  // Program): F-1 the URAR Reference Guide, B-1 the Implementation Guide, E the Report Style
  // Guide. B-1/F-1 need the "-1"; a bare "Appendix E" must name URAR or UAD.
  if ((m = s.match(URAR_APP)) || (m = s.match(URAR_APP_E))) {
    const letter = (m[1] ?? "E").toUpperCase();
    const doc = URAR_APPENDICES[letter];
    return { kind: "urar-appendix", canonical: `URAR Appendix ${letter}${letter === "E" ? "" : "-1"} (${doc.name})`,
      register_ids: [doc.id] };
  }
  if ((m = vaHandbookName(s).match(VA_HB))) {
    const [, hb, ch, topic, subA, subB] = m;
    const sub = (subA ?? subB)?.toLowerCase();
    const chapterId = `va-m26-${hb}-ch${pad2(ch)}`;
    const canonical = `M26-${hb} Ch. ${Number(ch)}${topic ? ` Topic ${Number(topic)}` : ""}${sub ? `(${sub})` : ""}`;
    // A whole chapter (no topic): its topic registers are listed too (Round 4, stress2 Q27:
    // "M26-7 Chapter 4" resolved to a three-obligation chapter stub, the topics unreachable).
    return { kind: "va-handbook", canonical,
      register_ids: topic ? [`${chapterId}-t${pad2(topic)}`, chapterId] : [chapterId],
      ...(topic ? {} : { topic_prefix: `${chapterId}-t` }) };
  }
  // 2026-10-13: the edition was matched but dropped, so every "SOP 50 10 8.1 ..." cite resolved
  // to the superseded SOP 8 register or to not_found. 8.1 -> sba-sop81-*, 8 -> sba-sop-*; no
  // edition named -> 8.1 (in force for applications from 2026-10-01) first, then 8.
  if ((m = s.match(SBA_SOP_APP))) {
    // "App15.A.1" names a paragraph register (sba-sop81-app15-a-1); its parents follow as fallbacks.
    const [, ed, app, sec, para] = m;
    const n = Number(app);
    const tails = [[`app${n}`, sec?.toLowerCase(), para && String(Number(para))].filter(Boolean)];
    while (tails[tails.length - 1].length > 1) tails.push(tails[tails.length - 1].slice(0, -1));
    const label = `${sec ? `App${n}.${[sec.toUpperCase(), para && Number(para)].filter(Boolean).join(".")}` : `Appendix ${n}`}`;
    const ids = (pre) => tails.map((t) => pre + t.join("-"));
    if (ed === "8.1") return { kind: "sba-sop", canonical: `SOP 50 10 8.1 ${label}`, register_ids: ids("sba-sop81-"), register_prefix: `sba-sop81-app${n}-` };
    if (ed) return { kind: "sba-sop", canonical: `SOP 50 10 8 ${label}`, register_ids: ids("sba-sop-"), register_prefix: `sba-sop-app${n}-` };
    return { kind: "sba-sop", canonical: `SOP 50 10 8.1 ${label}`,
      register_ids: [...ids("sba-sop81-"), ...ids("sba-sop-")], register_prefix: `sba-sop81-app${n}-` };
  }
  if ((m = s.match(SBA_SOP))) {
    const [, ed, part, ch, sec, para] = m;
    const bits = [part.toUpperCase(), `Ch${Number(ch)}`, sec?.toUpperCase(), para && String(Number(para))].filter(Boolean);
    const tail = bits.map((b) => b.toLowerCase()).join("-");
    if (ed === "8.1") return { kind: "sba-sop", canonical: `SOP 50 10 8.1 ${bits.join(".")}`, register_ids: [`sba-sop81-${tail}`] };
    if (ed) return { kind: "sba-sop", canonical: `SOP 50 10 8 ${bits.join(".")}`, register_ids: [`sba-sop-${tail}`] };
    return { kind: "sba-sop", canonical: `SOP 50 10 8.1 ${bits.join(".")}`,
      register_ids: [`sba-sop81-${tail}`, `sba-sop-${tail}`] };
  }
  if ((m = s.match(SBA_NOTICE))) {
    return { kind: "sba-notice", canonical: `SBA Notice ${m[1]}`, register_ids: [`sba-notice-${m[1]}`] };
  }
  if ((m = s.match(USDA_HB))) {
    const [, ch, para] = m;
    return para
      ? { kind: "usda-hb", canonical: `HB-1-3555 ${Number(ch)}.${Number(para)}`,
        register_ids: [`usda-hb-3555-${Number(ch)}-${Number(para)}`, `usda-hb-3555-${Number(ch)}`] }
      : { kind: "usda-hb", canonical: `HB-1-3555 Ch. ${Number(ch)}`, register_ids: [`usda-hb-3555-${Number(ch)}`] };
  }
  return null;
}

export function parseCitation(raw) {
  const s = String(raw ?? "").replace(DASHES, "-").trim();
  if (!s) return null;

  // 0. Structured handbook / notice / SOP cites (C4C-09): specific shapes, tested first so
  // "HB-1-3555 11.3" is never read as a CFR or Freddie number.
  const structured = parseStructured(s);
  if (structured) return structured;

  // 1. FHA handbook section -- MUST precede the Freddie rule.
  const fha = s.match(/\b((?:I{1,3}|IV|V)\.[A-Z]\.\d+(?:\.[a-z])?)\b/);
  if (fha) return { kind: "fha", canonical: fha[1] };

  // 2. Fannie Selling/Servicing Guide.
  const fnma = s.match(/\b([A-F]\d(?:-\d+(?:\.\d+)?)+-\d+)\b/);
  if (fnma) return { kind: "fnma", canonical: fnma[1] };
  // Batch 8 (stress6 C10): Servicing Guide parts A-F and Selling Guide Part E are numbered with
  // a bare letter -- "E-4.1-01", "F-1-05", "C-3-01" -- the form search_regs' own
  // canonical_citation gives them. Upper-case letter only, two-digit topic: "a-1-01" in prose
  // is not a cite.
  const svc = s.match(/(?<![\w.-])([A-F]-\d{1,2}(?:\.\d{1,2})?-\d{2})(?![\w.-]|\.\d)/);
  if (svc) return { kind: "fnma", canonical: svc[1] };

  // 3a. CFR -- MUST precede the generic Freddie rule below, same ordering lesson as
  // FHA-before-Freddie: a later, more specific rule needs a turn before the earlier
  // catch-all consumes the match. Matches the bare part.section number wherever it
  // appears in the string, so explicit markers like "12 CFR 1026.19" or
  // "Regulation Z 1026.19" resolve correctly too -- the marker text isn't required
  // for a 4-digit part, and isn't discarded when present. CFR_PARTS is generated
  // from the corpus (see the file-level note above), not hand-curated, and its
  // parts range from 2 digits (e.g. "34", OCC AVM rules) to 4 (e.g. "3555", USDA),
  // hence \d{1,4} below -- membership in CFR_PARTS, not digit count, is what gates
  // a match to a real part. But a short (1-3 digit) part additionally REQUIRES an
  // explicit marker (fix round 3): without one, it falls through instead, since a
  // short bare number collides constantly with ordinary mortgage-compliance prose
  // (percentages, ratios, dollar figures) in a way a 4-digit number essentially
  // never does.
  const cfr = s.match(/\b(\d{1,4})\.(\d+[A-Za-z]?)\b/);
  if (cfr && CFR_PARTS.includes(cfr[1]) && (cfr[1].length === 4 || CFR_MARKER_RE.test(s))) {
    return { kind: "cfr", canonical: `${cfr[1]}.${cfr[2]}` };
  }

  // 3b. Freddie Guide -- excluding handbook names / CFR parts that look like section numbers.
  const fhlmc = s.match(/\b(\d{4}\.\d+)\b/);
  if (fhlmc && !["4000.1", "4155.1", "5500.3"].includes(fhlmc[1])) {
    return { kind: "fhlmc", canonical: fhlmc[1] };
  }

  // 4. Statute.
  // A hyphenated section keeps its digits ("1681s-2", "1681c-1"); the old [A-Za-z\-]* tail
  // stopped at the hyphen and produced "1681s-", which never resolves.
  const usc = s.match(/\b(\d+)\s*U\.?S\.?C\.?\s*(?:§+\s*)?(\d+[A-Za-z]*(?:-\d+[A-Za-z]*)?)/i);
  if (usc) return { kind: "usc", canonical: `${usc[1]} U.S.C. ${usc[2]}` };

  return null;
}

// A WHOLE handbook named without a section (Round 4, stress2 Q13): "hud 4000.1" searched as
// two words returned ten tied micro-fragments, and lookup_citation("HUD Handbook 4000.1")
// was `unparsed`. Returns { kind: "handbook", canonical, family, prefix } when the string
// names a handbook and parseCitation finds no section in it, else null. `prefix` is the
// register-id prefix of the handbook's sections (tools/get.js handbookOverview).
const HANDBOOKS = [
  { re: /\b4000\.1\b/, canonical: "HUD Handbook 4000.1", family: "hud", prefix: "hud-4000-1-" },
  // mf-2a: HUD's MAP Guide (multifamily), one register per chapter
  { re: /\bMAP\s+Guide\b|\b4430\.G\b/i, canonical: "MAP Guide (HUD Handbook 4430.G REV-3)", family: "hudmf", prefix: "hud-4430g-" },
  { re: /\bM\s?26-?7\b|\bpamphlet\s+26-7\b|\blenders?['’]?s?\s+handbook\b|\bVA\s+handbook\b/i, canonical: "VA Lenders Handbook M26-7", family: "va", prefix: "va-m26-7-" },
  { re: /\bM\s?26-?4\b|\bservicer\s+handbook\b/i, canonical: "VA Servicer Handbook M26-4", family: "va", prefix: "va-m26-4-" },
  { re: /\bHB-?\s?1-?\s?3555\b/i, canonical: "USDA Technical Handbook HB-1-3555", family: "usda", prefix: "usda-hb-3555-" },
  { re: /\bMBS\s+Guide\b|\b5500\.3\b/i, canonical: "Ginnie Mae MBS Guide 5500.3", family: "gnma", prefix: "gnma-mbs-" },
  // 2026-10-07 citation-check test: "SOP 50 10 8" alone was `unparsed`, so a P&P citing the
  // superseded edition was never flagged. 8.1 first: the bare-8 pattern also matches "8.1".
  { re: /\bSOP\s*50\s*10\s*8\.1\b/i, canonical: "SBA SOP 50 10 8.1", family: "sba", prefix: "sba-sop81-" },
  { re: /\bSOP\s*50\s*10(?:\s*8)?\b/i, canonical: "SBA SOP 50 10 8", family: "sba", prefix: "sba-sop-" },
];

// A whole CFR part ("24 CFR Part 207", "12 C.F.R. part 1024", "24 CFR 221"), mf-3. Only when
// the input is not a section cite: "24 CFR Part 207, § 207.258" is the section.
const CFR_PART_RE = /\b(\d{1,2})\s*C\.?\s?F\.?\s?R\.?\s*,?\s*(?:(?:Part|pt\.?)\s*(\d{1,4})\b(?!\.\d)|(\d{1,4})\b(?![.\d]))/i;
export function parseCfrPart(raw) {
  const s = String(raw ?? "").replace(DASHES, "-").trim();
  if (!s || parseCitation(s)) return null;
  const m = s.match(CFR_PART_RE);
  if (!m) return null;
  const part = m[2] ?? m[3];
  return { kind: "cfr_part", canonical: `${m[1]} CFR Part ${part}`, title: m[1], part };
}

export function parseHandbook(raw) {
  const s = String(raw ?? "").replace(DASHES, "-").trim();
  if (!s || parseCitation(s)) return null;
  const hb = HANDBOOKS.find((h) => h.re.test(s));
  return hb ? { kind: "handbook", canonical: hb.canonical, family: hb.family, prefix: hb.prefix } : null;
}

// A handbook section's OWN document vs documents that merely cite it (agent eval
// 2026-09-25: "4000.1 II.A.4.c" came back as three Mortgagee Letters -- their obligations
// cite the section they amend -- and never as the handbook register, so the model
// summarized COVID-era letters instead of the rule). FHA has a register-id prefix that
// identifies the handbook itself; a statute section's own register is named
// <act>-<title>usc-<section>[-<slug>] (see uscOwnId). Other kinds keep treating every
// citing register as a candidate.
const OWN_PREFIX = { fha: "hud-4000-1-" };

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitUsc(canonical) {
  const m = String(canonical ?? "").match(/^(\d+) U\.S\.C\. (.+)$/);
  return m ? { title: m[1], section: m[2].replace(/-+$/, "") } : null;
}

// True when register_id is the statute section's own register: va-38usc-3710,
// va-38usc-3737-partial-claim (a slug starting with a letter may follow). A digit suffix
// is a different section (fcra-15usc-1681c-1 is not 1681c).
export function uscOwnId(canonical, register_id) {
  const p = splitUsc(canonical);
  if (!p) return false;
  const re = new RegExp(`-${p.title}usc-${escapeRe(p.section.toLowerCase())}(?:-[a-z][a-z0-9-]*)?$`);
  return re.test(String(register_id ?? "").toLowerCase());
}

export function isOwnDocument(kind, register_id, canonical) {
  if (kind === "usc") return uscOwnId(canonical, register_id);
  const prefix = OWN_PREFIX[kind];
  return prefix ? String(register_id ?? "").startsWith(prefix) : true;
}

// Owner's live test (2026-09-26): "38 U.S.C. 3709", "38 USC 3710" and "38 U.S.C. § 3737"
// all came back not_found although their registers exist -- the corpus writes a statute
// cite as "38 U.S.C. §3709(a)" or "VA Home Loan Guaranty (38 U.S.C. ch. 37) § 3710", never
// the canonical "38 U.S.C. 3709", so the plain boundary match never fired. This matcher
// accepts the title, any U.S.C. spelling, an optional "ch. NN)" and "§", then the section
// as a distinct token ("3709(a)" yes; "37091" and "1681c-1" for 1681c no).
export function uscMatches(canonical, text) {
  const p = splitUsc(canonical);
  if (!p || !text) return false;
  const re = new RegExp(
    `(?:^|[^0-9])${p.title}\\s*U\\.?\\s*S\\.?\\s*C\\.?\\s*(?:A\\.?\\s*)?` +
    `(?:ch(?:apter|\\.)?\\s*\\d+\\)?\\s*)?(?:§+\\s*)?${escapeRe(p.section)}` +
    "(?![A-Za-z0-9]|-[A-Za-z0-9])",
    "i",
  );
  return re.test(String(text));
}

// "section 4.1 of the handbook" names no handbook (owner's live test #15, 2026-09-26: it
// came back `unparsed` with a search hint, which invites the model to guess). A section
// number next to a bare "the handbook"/"the manual"/"the guide" is ambiguous: the caller
// must ask which handbook. Returns the section number, or null.
const HANDBOOK_NAMED_RE =
  /\b(?:4000\.1|4155|4430\.G|MAP|M26-?[47]|3555|HB-?1|SOP|5500\.3|MBS|Selling|Servicing|Freddie|Fannie|FHA|HUD|VA|USDA|SBA|Ginnie)\b|\b50\s*10\b/i;

export function bareHandbookSection(raw) {
  const s = String(raw ?? "").replace(DASHES, "-").trim();
  if (!s || HANDBOOK_NAMED_RE.test(s)) return null;
  const m =
    s.match(/\b(?:section|sec\.?|§|chapter|ch\.?|paragraph|para\.?|¶|topic)\s*(\d+(?:\.\d+)*[a-z]?)\s+(?:of|in)\s+(?:the|this|that)\s+(?:handbook|manual|guide)\b/i) ||
    s.match(/\b(?:the\s+)?(?:handbook|manual|guide)(?:'s)?\s+(?:section|sec\.?|§|chapter|ch\.?|paragraph|para\.?|¶|topic)?\s*(\d+(?:\.\d+)*[a-z]?)\b/i);
  return m ? m[1] : null;
}

// The handbooks a bare "section N of the handbook" could mean, and how to cite each.
export const HANDBOOK_CANDIDATES = [
  "FHA: HUD Handbook 4000.1 (cite e.g. \"4000.1 II.A.8.d\")",
  "VA: Lenders Handbook M26-7 (chapter and topic, e.g. \"M26-7 Chapter 4 Topic 9\")",
  "VA: Servicer Handbook M26-4",
  "USDA: Technical Handbook HB-1-3555 (paragraph, e.g. \"HB-1-3555 ¶4.1\")",
  "SBA: SOP 50 10 8",
  "HUD Multifamily: MAP Guide 4430.G (e.g. \"MAP Guide 3.2.1\", \"MAP Guide Chapter 9\")",
  "Ginnie Mae: MBS Guide 5500.3",
  "Fannie Mae Selling Guide (e.g. \"B3-4.3-04\") or Freddie Mac Guide (e.g. \"5306.1\")",
];

export function ambiguousHandbook(raw, section) {
  return {
    error: "ambiguous",
    citation: raw,
    section,
    candidates: HANDBOOK_CANDIDATES,
    hint: "No handbook is named. Ask the user which handbook they mean before answering; " +
      "do not guess. Then call lookup_citation or search_regs with the handbook named.",
  };
}

// The Update-18 full-verbatim handbook registers carry their section ONLY as a spelled-out
// outline path in registers.authority:
//   "... Handbook 4000.1, II. ORIGINATION ... > A. Title II ... > 4. Underwriting ... —
//    c. Income Requirements (TOTAL)"                                  -> "II.A.4.c"
// and their register ids do not mirror the letters (that one is
// hud-4000-1-ii-c-income-requirements-total). Pieces are split on " > " and " — "; a
// piece without a leading outline token ("DOING BUSINESS WITH FHA", after a bare "I.")
// is a heading and skipped. Returns null unless the path starts at a Roman part and has
// at least two levels.
const OUTLINE_TOKEN = /^\s*([IVX]+|[A-Z]|\d+|[a-z])\.(?:\s|$)/;

export function outlineCode(authority) {
  const a = String(authority ?? "");
  if (!a.includes(">")) return null;
  const at = a.indexOf("4000.1");
  const path = (at === -1 ? a : a.slice(at + "4000.1".length)).replace(/^[\s,]+/, "");
  const codes = [];
  for (const piece of path.split(/\s+>\s+|\s+[—–]\s+/)) {
    const m = piece.match(OUTLINE_TOKEN);
    if (m) codes.push(m[1]);
  }
  if (codes.length < 2 || !/^[IVX]+$/.test(codes[0])) return null;
  return codes.join(".");
}

const RELATED_NOTE =
  "Documents whose obligations cite this section (for example Mortgagee Letters that " +
  "amended it). They are NOT the section's text and may since have been incorporated " +
  "into or superseded by the current handbook.";

const ALSO_AT_NOTE =
  "Registers in also_at hold the SAME text as register_id (duplicate copies of one " +
  "section); quote from register_id.";

// `rows` are the section's own registers; `related` are ids of documents that cite it.
// Related documents are never ambiguity candidates and never the resolved register.
// `aliasRows` ({register_id, canonical_id}, src/aliases.js): candidates with identical
// text collapse to one BEFORE ambiguity is decided (2026-09-26: II.A.8.d refused between
// three copies of one text). Different texts for one citation still refuse.
export function resolve(rows, related = [], aliasRows = []) {
  const rel = related.length
    ? {
        related: related.map((register_id) => ({ register_id, relation: "cites_or_amends" })),
        related_note: RELATED_NOTE,
      }
    : {};
  if (!rows || rows.length === 0) return { error: "not_found", ...rel };
  const groups = collapseCandidates(rows.map((r) => r.register_id), aliasRows);
  if (groups.length > 1) {
    return { error: "ambiguous", candidates: groups.map((g) => g.register_id), ...rel };
  }
  const [g] = groups;
  return {
    register_id: g.register_id,
    ...(g.canonical_id !== g.register_id ? { canonical_id: g.canonical_id } : {}),
    ...(g.also_at.length ? { also_at: g.also_at, also_at_note: ALSO_AT_NOTE } : {}),
    ...rel,
  };
}
