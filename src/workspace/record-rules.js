// record_rules (Plan 2, Task 2): the record-retention rule for a kind of lending decision,
// quoted verbatim from the corpus. The mapping is fixed by the Decision Workspace spec
// ("Retention anchors"); each obligation was checked in the live corpus on 2026-10-19.
//
// `period` and `clock_starts` are summaries, not regulator text: the result names them in
// `summary_fields`. A passage the corpus no longer holds (a re-ingest moved or dropped it)
// comes back verbatim: null, error "text_not_found" -- never invented text.

import { fetchObligationRow } from "../tools/get.js";
import { findPassages } from "../tools/find.js";
import { NOTICE } from "../metrics.js";

const REG_B = {
  obligation_id: "reg-b-1002-12::reg-b-1002.12-b",
  terms: ["25 months"],
  period: "25 months (12 months for business credit)",
  clock_starts: "the date the creditor notifies the applicant of action taken or of incompleteness",
};

export const RULES = Object.freeze({
  application_action: [REG_B],
  adverse_action: [REG_B],
  tila_disclosure: [{
    obligation_id: "reg-z-1026-25::reg-z-1026.25-a",
    terms: ["two years after the date"],
    period: "2 years",
    clock_starts: "the date disclosures are required to be made or action is required to be taken",
  }],
  // 1026.25(c)(1)(ii)(A): the Closing Disclosure and its related documents are kept five years,
  // longer than the (c)(1)(i) general rule (final review 2026-10-19).
  trid_disclosure: [{
    obligation_id: "reg-z-1026-25::reg-z-1026.25-c",
    terms: ["three years after the later of"],
    period: "3 years",
    clock_starts: "the later of consummation, the date disclosures are required, or the date action is required",
  }, {
    obligation_id: "reg-z-1026-25::reg-z-1026.25-c",
    terms: ["five years after consummation"],
    period: "5 years (Closing Disclosure and related documents)",
    clock_starts: "consummation",
  }],
  lo_compensation: [{
    obligation_id: "reg-z-1026-25::reg-z-1026.25-c",
    terms: ["compensation it pays to a loan originator"],
    period: "3 years",
    clock_starts: "the date of payment",
  }],
  servicing_action: [{
    obligation_id: "reg-x-1024-38::reg-x-1024.38-c",
    terms: ["Record retention"],
    period: "until 1 year after",
    clock_starts: "the loan is discharged or servicing is transferred",
  }],
});

export const DECISION_TYPES = Object.freeze(Object.keys(RULES));

// The sections the rules quote, as tag_record's `rule` accepts them (no free text there).
export const RETENTION_CITATIONS = Object.freeze(["12 CFR 1002.12(b)", "12 CFR 1026.25(a)", "12 CFR 1026.25(c)", "12 CFR 1024.38(c)"]);

export const NOT_COVERED = Object.freeze([
  "Investor and insurer retention requirements (Fannie Mae, Freddie Mac, FHA, VA, USDA) are not mapped yet.",
  "Records of advertising are excluded from 12 CFR 1026.25(a); their rule is not mapped yet.",
]);

async function ruleResult(env, rule) {
  const summary = { period: rule.period, clock_starts: rule.clock_starts };
  const row = await fetchObligationRow(env, rule.obligation_id);
  const found = row ? findPassages(row, rule.terms, 1) : null;
  const passage = found?.passages?.[0];
  if (!passage) {
    return {
      canonical_citation: found?.canonical_citation ?? null,
      verbatim: null,
      page_url: found?.page_url ?? null,
      source_url: found?.source_url ?? null,
      ...summary,
      error: "text_not_found",
    };
  }
  return {
    canonical_citation: passage.canonical_citation ?? found.canonical_citation ?? row.section,
    verbatim: passage.verbatim,
    page_url: found.page_url,
    source_url: found.source_url,
    ...summary,
  };
}

export async function recordRules(env, decisionType) {
  const rules = RULES[decisionType];
  if (!Object.hasOwn(RULES, decisionType) || !rules) {
    return { error: "unknown_decision_type", decision_type: decisionType, valid_types: [...DECISION_TYPES], notice: NOTICE };
  }
  return {
    decision_type: decisionType,
    rules: await Promise.all(rules.map((r) => ruleResult(env, r))),
    not_covered: [...NOT_COVERED],
    summary_fields: ["period", "clock_starts"],
    notice: NOTICE,
  };
}
