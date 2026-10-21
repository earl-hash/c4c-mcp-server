// canonical_citation (C4C-08, owner's live test 2026-09-26): the section's citation in the
// regulator's own style -- "4000.1 II.A.5.d", "B3-3.3-07", "Freddie Mac Guide 5306.1",
// "38 U.S.C. 3709(b)", "38 CFR 36.4307(b)", "M26-7 Ch. 4 Topic 9", "HB-1-3555 11.3".
// Search, get and find responses labelled FHA sections only "Part II - d. Final
// Underwriting Decision (Manual)"; the pinpoint cite was available only through
// lookup_citation, so a model either cited vaguely or supplied it from memory -- the
// invented-citation risk the product exists to remove.
//
// Derived ONLY from identifiers already in D1 (register id, register title, obligation
// section). When no rule below recognizes the shape, the field is null: a missing cite is
// honest, a guessed one is not. This is OUR editorial field, beside the verbatim text.

import { outlineCode } from "./citation.js";

const FHA_CODE = /\b((?:IV|V|I{1,3})\.[A-Z]\.\d+(?:\.[a-z])?)(?![A-Za-z0-9])/;
const FNMA_ID = /\b([A-F]\d?(?:-\d+(?:\.\d+)?)*-\d+)\b/;
const CFR = /\b(\d+)\s*C\.?F\.?R\.?\s*(?:Part\s*)?§*\s*(\d+\.\d+[a-z]?(?:-\d+)?(?:\([A-Za-z0-9]+\))*)/;
const USC = /\b(\d+)\s*U\.?\s?S\.?\s?C\.?\s*(?:§+\s*)?(\d+[a-z]?(?:-\d+)?(?:\([A-Za-z0-9]+\))*)/;
const USC_CH = /\b(\d+)\s*U\.?S\.?C\.?\s*ch\.\s*\d+\)\s*§+\s*(\d+[a-z]?)/;

function first(re, ...texts) {
  for (const t of texts) {
    const m = String(t ?? "").match(re);
    if (m) return m;
  }
  return null;
}

// row: { register_id, register_title (registers.authority), section, authority }
export function canonicalCitation(row) {
  const id = String(row?.register_id ?? "");
  const title = row?.register_title ?? "";
  const section = row?.section ?? "";
  const auth = row?.authority ?? "";
  let m;

  if (id.startsWith("hud-4000-1-")) {
    const code = outlineCode(title) ?? first(FHA_CODE, title, section, auth)?.[1];
    return code ? `4000.1 ${code}` : null;
  }
  if ((m = id.match(/^hud-ml-(\d{4})-(\d+)/))) return `Mortgagee Letter ${m[1]}-${m[2]}`;
  // mf-2a: MAP Guide chapter registers; each obligation's section ends "— 3.1.1 Regulatory
  // Agreement" (scripts/ingest-map-guide.py). Appendices (mf-2b): hud-4430g-app05, "— A.5.1 ...".
  if (id === "hud-4430g-glossary") return "MAP Guide Glossary";
  if (id === "hud-4430g-acronyms") return "MAP Guide Acronym and Abbreviation List";
  if ((m = id.match(/^hud-4430g-(ch|app)(\d+)$/))) {
    const sec = String(section).match(/\s—\s+((?:A\.)?\d{1,2}(?:\.\d{1,2})+)\s/);
    if (sec) return `MAP Guide ${sec[1]}`;
    return `MAP Guide ${m[1] === "ch" ? "Chapter" : "Appendix"} ${Number(m[2])}`;
  }
  if ((m = id.match(/^fnma-ll-(\d{4})-(\d+)$/))) return `Fannie Mae Lender Letter LL-${m[1]}-${m[2]}`;
  if ((m = id.match(/^fnma-(sel|svc)-(\d{4})-(\d+)$/))) {
    return `Fannie Mae Announcement ${m[1].toUpperCase()}-${m[2]}-${m[3]}`;
  }
  if (id.startsWith("fnma-")) {
    m = first(FNMA_ID, section, title, auth);
    return m ? m[1] : null;
  }
  if ((m = id.match(/^fhlmc-bulletin-(\d{4})-(\d+)$/))) return `Freddie Mac Bulletin ${m[1]}-${m[2]}`;
  // gl-1: the Guide Glossary (scripts/ingest-fhlmc-glossary.py), one obligation per letter block
  if (id === "fhlmc-glossary") return "Freddie Mac Guide Glossary";
  // cg-1: the Red Flags Rule appendices (Interagency Guidelines), by agency part
  if ((m = id.match(/^(?:ftc|occ|frb|fdic|ncua)-(12|16)cfr-(\d+)-appendix-([a-z])$/))) {
    return `${m[1]} CFR Part ${m[2]}, Appendix ${m[3].toUpperCase()}`;
  }
  // cg-1: IRS Form 8821 / its Instructions / Form 4506-C (scripts/ingest-cg1.py --part irs)
  if (id === "irs-form-8821") return "IRS Form 8821";
  if (id === "irs-form-8821-instructions") return "Instructions for IRS Form 8821";
  if (id === "irs-form-4506-c") return "IRS Form 4506-C";
  // cg-1: FHFA conforming loan limit values (scripts/ingest-cg1.py --part fhfa)
  if ((m = id.match(/^fhfa-cll-(\d{4})(?:-(methodology|faqs))?$/))) {
    if (m[2] === "faqs") {
      const q = String(section).match(/Question (\d+)/);
      return `FHFA Conforming Loan Limit FAQs (${m[1]})${q ? `, Question ${q[1]}` : ""}`;
    }
    return m[2] ? `FHFA Conforming Loan Limit Methodology Addendum (${m[1]})`
      : `FHFA Conforming Loan Limit Values for ${m[1]}`;
  }
  if (/^fhlmc-\d/.test(id)) {
    m = first(/\bGuide\s+(?:Section\s+|§\s*)?(\d{4}\.\d+(?:\([a-z0-9]+\))*)/i, section, title, auth);
    if (m) return `Freddie Mac Guide ${m[1]}`;
    m = first(/\bGuide\s+(?:Chapter\s+)?(\d{4})\b/i, section, title, auth);
    return m ? `Freddie Mac Guide Chapter ${m[1]}` : null;
  }
  if ((m = id.match(/^va-m26-([47])-ch(\d+)(?:-t(\d+))?(?:$|-)/))) {
    const ch = Number(m[2]);
    // A chapter register's obligation may name its own topic/subsection:
    // "VA M26-7 Ch. 1, Topic 14, Subsection c".
    const sub = !m[3] && section.match(/\bCh\.\s*(\d+),\s*Topic\s+(\d+)(?:,\s*Subsection\s+([a-z]))?/);
    if (sub && Number(sub[1]) === ch) {
      return `M26-${m[1]} Ch. ${ch} Topic ${Number(sub[2])}${sub[3] ? `(${sub[3]})` : ""}`;
    }
    return `M26-${m[1]} Ch. ${ch}${m[3] ? ` Topic ${Number(m[3])}` : ""}`;
  }
  if ((m = id.match(/^va-m26-4-appendix-([a-z])$/))) return `M26-4 App. ${m[1].toUpperCase()}`;
  if ((m = id.match(/^va-circular-(\d+)-(\d+)-(\d+)(-change(\d+))?$/))) {
    return `VA Circular ${m[1]}-${m[2]}-${Number(m[3])}${m[4] ? ` Change ${m[5]}` : ""}`;
  }
  // Round 4: chapter registers "usda-hb-3555-ch07" whose obligations name a paragraph
  // ("USDA HB-1-3555 Ch. 7.3.A — Repayment Period").
  if ((m = id.match(/^usda-hb-3555-ch(\d+)$/))) {
    const para = section.match(/\bCh\.\s*(\d+\.\d+(?:\.[A-Z0-9]+)*)/);
    return para ? `HB-1-3555 ${para[1]}` : `HB-1-3555 Ch. ${Number(m[1])}`;
  }
  if ((m = id.match(/^usda-pn-(\d+)$/))) return `USDA Procedure Notice ${m[1]}`;
  if ((m = id.match(/^usda-hb-3555-(\d+)-(\d+)$/))) return `HB-1-3555 ${m[1]}.${m[2]}`;
  if ((m = id.match(/^usda-hb-3555-(\d+)$/))) return `HB-1-3555 Ch. ${m[1]}`;
  if ((m = id.match(/^sba-notice-(\d{4}-\d+)$/))) return `SBA Notice ${m[1]}`;
  // Round 4 (stress3 CITE-02): SOP 50 10 8.1 registers ("sba-sop81-...").
  if (id.startsWith("sba-sop81-")) {
    m = first(/\bSOP\s+50\s+10\s+8\.1,?\s+([A-Z](?:pp?)?[\w.]*)/, section, title);
    return m ? `SOP 50 10 8.1 ${m[1]}` : null;
  }
  if (id.startsWith("sba-sop-")) {
    m = first(/\bSOP\s+50\s+10\s+[\d.]+,?\s+([A-Z](?:pp?)?[\w.]*)/, section, title);
    return m ? `SOP 50 10 8 ${m[1]}` : null;
  }
  if ((m = id.match(/^gnma-apm-(\d+)-(\d+)$/))) return `Ginnie Mae APM ${m[1]}-${m[2]}`;
  if (id.startsWith("gnma-")) {
    m = first(/\bMBS Guide\s+((?:Ch\.\s*\d+(?:,\s*Part\s*\d+)?(?:,\s*(?:Section|§)\s*[A-Z0-9]+)?)|Appendix\s+[IVX]+-\d+)/, section, title);
    return m ? `Ginnie Mae MBS Guide ${m[1].replace(/§\s*/, "Section ")}` : null;
  }
  // Statutes and regulations: the obligation section carries the paragraph ("(b)").
  m = first(CFR, section, auth, title);
  if (m) return `${m[1]} CFR ${m[2]}`;
  m = first(USC_CH, section, auth, title);
  if (m) {
    const own = first(USC, section);
    return own ? `${own[1]} U.S.C. ${own[2]}` : `${m[1]} U.S.C. ${m[2]}`;
  }
  m = first(USC, section, auth, title);
  if (m) return `${m[1]} U.S.C. ${m[2]}`;
  // A superseded copy cites as the section it is a prior version of (its currency says so).
  const base = id.replace(/-superseded-\d{4}(?:-\d{2}){0,2}$/, "");
  if (base !== id) return canonicalCitation({ ...row, register_id: base });
  return fallbackCitation(id, title, section);
}

// Round 4 (stress2 I-15, stress3 CITE-02): shapes the rules above do not know, derived only
// when the register title states the citation unambiguously.
//   Supplement I commentary   "Supplement I to 12 CFR Part 1026" + "Comment 20(c)-2"
//                             -> "12 CFR Part 1026, Supp. I, Comment 20(c)-2"
//   UAD / URAR appendices     "UAD 3.6 / URAR Appendix F-1 — Reference Guide" -> "URAR Appendix F-1"
//   proposed rules            "CFPB NPRM §1024.41(f)(2)" -> "12 CFR 1024.41(f)(2) (proposed)"
//   Federal Register / public laws / executive orders, by the number the title carries.
function fallbackCitation(id, title, section) {
  let m;
  if ((m = title.match(/\bSupplement I to (?:12 CFR )?Part (\d{3,4})\b/))) {
    const c = section.match(/\bComment\s+([\w().-]*\d[\w().-]*?)(?=[:\s]|$)/);
    return `12 CFR Part ${m[1]}, Supp. I${c ? `, Comment ${c[1]}` : ""}`;
  }
  if ((m = title.match(/\bURAR Appendix ([A-Z]-?\d*)\b/))) return `URAR Appendix ${m[1]}`;
  if (/^cfpb-.*nprm/.test(id) && (m = section.match(/§\s*(10\d\d\.\d+(?:\([\w]+\))*)/))) {
    return `12 CFR ${m[1]} (proposed)`;
  }
  if ((m = title.match(/\bExecutive Order (\d{5})\b/))) return `Executive Order ${m[1]}`;
  if ((m = title.match(/\b(\d{2,3}) FR (\d{3,6})\b/))) return `${m[1]} FR ${m[2]}`;
  if ((m = title.match(/\bFR Doc\.?\s*(\d{4}-\d{4,6})\b/))) return `FR Doc. ${m[1]}`;
  if ((m = title.match(/\bPub\. L\. (\d{2,3}-\d{1,4})\b/))) return `Pub. L. ${m[1]}`;
  return null;
}

// A passage's pinpoint cite: the section's cite plus its outline markers below the section
// (heading_path, tools/find.js). FHA style "4000.1 II.A.8.d.vi(A)(1)(b)(i)"; a VA topic's
// lettered subsection "M26-7 Ch. 4 Topic 9(e)". Other families keep the section's cite:
// their obligations are already paragraph-level.
export function passageCitation(sectionCite, markers, register_id) {
  if (!sectionCite || !markers?.length) return sectionCite ?? null;
  const id = String(register_id ?? "");
  if (id.startsWith("hud-4000-1-")) {
    const last = sectionCite.split(".").pop();
    let ms = [...markers];
    // The section's own heading ("d. Refinances") opens the path: skip it.
    if (ms[0] && ms[0].replace(/\.$/, "") === last) ms = ms.slice(1);
    if (!ms.length) return sectionCite;
    return sectionCite + ms.map((x) => (x.startsWith("(") ? x : `.${x.replace(/\.$/, "")}`)).join("");
  }
  // Round 4: Freddie Mac passages under inline markers -> "Freddie Mac Guide 5306.1(b)(ii)".
  if (/^fhlmc-\d/.test(id) && /^Freddie Mac Guide \d{4}\.\d+$/.test(sectionCite)) {
    const parens = markers.filter((x) => /^\((?:[a-z]|[ivx]{1,5}|[A-Z]|\d{1,2})\)$/.test(x));
    return parens.length ? sectionCite + parens.join("") : sectionCite;
  }
  if (/^va-m26-[47]-ch\d+-t\d+/.test(id)) {
    const letter = markers.find((x) => /^[a-z]\.$/.test(x));
    return letter ? `${sectionCite}(${letter[0]})` : sectionCite;
  }
  return sectionCite;
}
