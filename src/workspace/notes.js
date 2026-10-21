// propose_file_note and tag_record (Plan 2, Task 3). Spec decisions D2 (a person approves the
// text) and D3 ("no" is never final).
//
// propose_file_note returns a DRAFT: nothing is stored here, and the note says a person must
// approve it before it is saved anywhere (saving happens in the lender's own system). Each
// citation is checked the way lookup_citation resolves it: held -> resolved: true; not held
// -> resolved: false with the reviewer's wording; a lookup that errored -> resolved: null
// ("could not be checked right now"), never reported as missing from the corpus.
//
// tag_record stores nothing either: the call itself is the tag, and it appears in the
// conversation's transcript (Compliance API: mcp__<server>__tag_record). Only enumerated
// fields are echoed (`rule` is one of the mapped retention sections); free text (reason_detail)
// is accepted but not repeated back. propose_file_note does return the conclusion and citations:
// they are the draft the person reviews.
//
// `date` is the UTC date (the server has no time zone for the user).

import { z } from "zod";
import { resolveCitation } from "../tools/get.js";
import { pageUrl } from "../sourceurl.js";
import { canonicalCitation } from "../canonical.js";
import { NOTICE } from "../metrics.js";
import { DECISION_TYPES, RETENTION_CITATIONS, recordRules } from "./record-rules.js";

export const APPROVAL_REQUIRED = "A person must read and approve this text before it is saved anywhere.";
export const TAG_NOTE =
  "This call is the tag: it appears in this conversation's transcript. Nothing is stored on this server.";
export const UNVERIFIED = "Not in the C4C corpus, so it could not be checked; confirm at the source.";
export const UNCHECKED = "Could not be checked right now.";
const AMBIGUOUS = "Matches more than one section in the C4C corpus, so it could not be checked; cite the section.";
const NOT_A_SECTION = "Names a whole document, not one section, so it could not be checked; cite the section.";

export const STATUSES = Object.freeze(["saved", "edited", "declined"]);
export const REASONS = Object.freeze(["not_a_file_decision", "already_in_file", "not_now", "other"]);

// A loan reference, never borrower data: letters, digits and hyphens, and not shaped like an
// SSN. Error messages name the rule, never the value.
const SSN_SHAPE = /^\d{3}-?\d{2}-?\d{4}$/;
export const loanRef = z.string()
  .regex(/^[A-Za-z0-9-]{1,32}$/, { error: "1-32 letters, digits or hyphens" })
  .refine((v) => !SSN_SHAPE.test(v), { error: "must not be shaped like an SSN" });
const citation = z.string().trim().min(1).max(80, { error: "at most 80 characters" });

export const NOTE_SCHEMA = {
  decision_type: z.enum(DECISION_TYPES).describe("The kind of decision the note records."),
  conclusion: z.string().min(1).max(2000, { error: "at most 2,000 characters" })
    .describe("The decision and its basis, in 2,000 characters or fewer."),
  citations: z.array(citation).max(10).describe("Up to 10 citations the conclusion relies on."),
  loan_ref: loanRef.optional().describe("Optional loan reference: letters, digits and hyphens."),
};

export const TAG_SCHEMA = {
  decision_type: z.enum(DECISION_TYPES).describe("The kind of decision."),
  status: z.enum(STATUSES).describe("What happened to the proposed note."),
  reason: z.enum(REASONS).optional().describe("Why the note was declined."),
  reason_detail: z.string().max(200, { error: "at most 200 characters" }).optional()
    .describe("Optional detail on the reason, 200 characters or fewer; not echoed."),
  rule: z.enum(RETENTION_CITATIONS).optional().describe("Optional: the retention section that applies."),
  loan_ref: loanRef.optional().describe("Optional loan reference: letters, digits and hyphens."),
};

// The register's citation in the regulator's style ("12 CFR 1002.9"); the parse alone is bare
// ("1002.9"). Null when the register has none (statutes) or the read fails.
async function registerCitation(env, registerId) {
  try {
    const reg = await env.CORPUS.prepare("SELECT register_id, authority FROM registers WHERE register_id = ?1")
      .bind(registerId).first();
    return reg ? canonicalCitation({ register_id: reg.register_id, register_title: reg.authority }) : null;
  } catch {
    return null;
  }
}

async function checkCitation(env, cite) {
  let r;
  try {
    r = await resolveCitation(env, cite);
  } catch {
    return { citation: cite, resolved: null, note: UNCHECKED };
  }
  if (r?.register_id) {
    return {
      citation: cite,
      resolved: true,
      canonical_citation: (await registerCitation(env, r.register_id)) ?? r.parsed?.canonical ?? cite,
      page_url: r.page_url ?? pageUrl(r.register_id, r.operative_obligation_id ?? r.obligation_id),
    };
  }
  if (r?.error === "ambiguous") return { citation: cite, resolved: false, note: AMBIGUOUS };
  if (r?.error === "not_found" || r?.error === "unparsed") return { citation: cite, resolved: false, note: UNVERIFIED };
  return { citation: cite, resolved: false, note: NOT_A_SECTION };
}

async function retentionOf(env, decisionType) {
  try {
    const { rules } = await recordRules(env, decisionType);
    return { retention: rules.map(({ canonical_citation, period, clock_starts }) => ({ canonical_citation, period, clock_starts })) };
  } catch {
    return { retention: [], retention_note: UNCHECKED };
  }
}

// One probe before any lookup: some lookup paths (bare "§ 1691" statute cites) swallow a D1
// error and fall through to "unparsed", which would read as "not in the corpus" (final review
// 2026-10-19). With the corpus down, every citation is unchecked.
async function corpusUp(env) {
  try {
    await env.CORPUS.prepare("SELECT 1 FROM registers LIMIT 1").first();
    return true;
  } catch {
    return false;
  }
}

export async function proposeFileNote(env, { decision_type, conclusion, citations = [], loan_ref }) {
  const up = await corpusUp(env);
  const [checked, retention] = await Promise.all([
    Promise.all(citations.map((c) => (up ? checkCitation(env, c) : { citation: c, resolved: null, note: UNCHECKED }))),
    retentionOf(env, decision_type),
  ]);
  return {
    status: "draft",
    stored: false,
    approval_required: APPROVAL_REQUIRED,
    decision_type,
    loan_ref: loan_ref ?? null,
    date: new Date().toISOString().slice(0, 10),
    conclusion,
    citations: checked,
    ...retention,
    notice: NOTICE,
  };
}

export function tagRecord({ decision_type, status, reason, rule, loan_ref }) {
  return {
    stored: false,
    tag: { decision_type, status, reason: reason ?? null, rule: rule ?? null, loan_ref: loan_ref ?? null },
    note: TAG_NOTE,
    notice: NOTICE,
  };
}
