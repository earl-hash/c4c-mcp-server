// Output schemas for the ten tools (MCP 2025-06-18 `outputSchema` + `structuredContent`).
//
// CONTRACT: a tool that declares an outputSchema must return structuredContent that
// validates against it on EVERY successful result, or clients may reject the call (and
// @modelcontextprotocol/server validates it server-side with the zod schema, turning a
// mismatch into an isError "Output validation error" result). So every schema here is
// deliberately PERMISSIVE and TRUE for every shape the tool returns:
//   - one object per tool (the spec requires an object root), `z.looseObject`, so fields
//     added later (and the `...rest` columns search_regs passes through) never fail;
//   - nothing is `required` except fields every result shape carries -- the error shapes
//     ({error: "not_found", hint}), the daily-capacity refusal (budget.js, served by every
//     tool), `notice` (metrics.js) and the paging variants all validate;
//   - a field whose shape varies (or is nested deeply) is described, not typed.
// structuredContent is the SAME object as the JSON in content[0].text (metrics.js
// instrumentTools), so the text contract clients rely on is unchanged.
//
// MCP Directory policy (2026-09-27): these descriptions are shown to models, so they state
// what each field MEANS -- no instructions to the model, no directions to other tools. How
// to use the results lives in the server instructions (instructions.js).
// test/tool-text-policy.test.js enforces it.
//
// test/output-schemas.test.js validates every result shape against these through the real
// server; test/eval/validate-output-schemas.mjs does the same over real corpus queries.

import { z } from "zod";

const str = (d) => z.string().optional().describe(d);
const nstr = (d) => z.string().nullable().optional().describe(d);
const int = (d) => z.number().optional().describe(d);
const nint = (d) => z.number().nullable().optional().describe(d);
const bool = (d) => z.boolean().optional().describe(d);
const any = (d) => z.unknown().optional().describe(d);
const strs = (d) => z.array(z.string()).optional().describe(d);

// Fields shared by every tool's result: the error/refusal vocabulary and the notice.
const COMMON = {
  error: str(
    "Present only on an error or refusal: not_found, ambiguous, unparsed, empty_terms, " +
    "unknown_playbook, unknown_reference, offset_out_of_range, daily_capacity_reached.",
  ),
  hint: str("On an error: the server's explanation."),
  guidance: str("On a refusal or empty search: the server's explanation."),
  fallback: str("On daily_capacity_reached: where the full corpus can be downloaded."),
  resets: str("On daily_capacity_reached: when capacity resets (00:00 UTC)."),
  note: str("A note on this result."),
  notice: str("Terms notice: research use only, not legal advice."),
};

// Described, not typed (it appears ~8 times; typing its members tripled tools/list size).
const CURRENCY = any(
  "null, or a version/status signal {kind, headline, detail, effective_date, " +
  "mandatory_date, expires_on, as_of, links}; kind e.g. dual-version, pending, " +
  "revision-pending, superseded, superseded-in-part, modified-by, expired.",
);

const CANONICAL_CITATION = nstr(
  "The citation in the regulator's style (e.g. \"4000.1 II.A.5.d\", \"B3-3.3-07\"), or null.",
);
const VERSION = str("On a dual-version FHA section: \"in-force\" or \"update-18-optional\".");
const OTHER_VERSION = str("On a dual-version section: the other version's obligation_id.");
const MANDATORY = str("On an Update 18 revision: when it becomes mandatory.");
const VALID_IDS = strs("On unknown_playbook: the valid ids.");

// Provenance of one obligation (src/envelope.js provenance): get_obligation, find_in_section.
const PROVENANCE = {
  register_id: str("The register (source document) id."),
  obligation_id: str("The obligation (section) id."),
  authority: str("The document and section title as published."),
  section: str("The section designation."),
  canonical_citation: CANONICAL_CITATION,
  source_url: str("The regulator's URL for the document."),
  page_url: str("The section's page on claudeforcompliance.com (verbatim text, currency notices, link to the regulator)."),
  snapshot_id: str("The stored source snapshot."),
  fetched_at: str("When the source was retrieved."),
  content_hash: str("Hash of the stored text."),
  effective_date: nstr("Effective date, or null."),
  status: str("E.g. current, superseded, unknown."),
  superseded_by: nstr("The replacing register, or null."),
  coverage_tier: str("How completely the corpus holds the document."),
  currency: CURRENCY,
  canonical_id: str("Set when this register is a same-text copy of that register."),
  version: any("On a dual-version section: {label: in-force | update-18-optional, dates, note}."),
  other_version: any("On a dual-version section: the other version ({obligation_id, version, dates})."),
  resolved_from_alias: str("The retired obligation id requested; its text is now at obligation_id."),
  alias_note: str("Explains resolved_from_alias."),
};

// A section the regulator renumbered (src/renumbered.js): lookup_citation, get_reg and
// get_obligation answer with these; register_id / page_url are the section's new number.
const RENUMBERED = {
  kind: str("\"renumbered\": the regulator gave this section a new number; no text is given under the old one."),
  renumbered_from: str("The old register, when the section was renumbered."),
  renumbered_from_citation: str("On kind renumbered: the section's old citation."),
  renumbered_in: str("On kind renumbered: the regulator's posting that renumbered it."),
  renumbered_on: str("On kind renumbered: when (YYYY-MM)."),
  text_changed: bool("On kind renumbered: false when the text moved word for word."),
  requested_id: str("On kind renumbered: the old id asked for."),
};

const obj = (shape, description) => z.looseObject({ ...shape, ...COMMON }).describe(description);

export const OUTPUT_SCHEMAS = {
  search_regs: obj({
    results: z.array(z.looseObject({
      section: str("The section title."),
      register_id: str("The register id."),
      obligation_id: str("The obligation (section) id."),
      source_url: str("The regulator's URL for the document."),
      page_url: str("The section's page on claudeforcompliance.com (verbatim text, currency notices, link to the regulator)."),
      version: VERSION,
      other_version: OTHER_VERSION,
      mandatory_date: MANDATORY,
      excerpt: str("A verbatim fragment near the match; not the whole rule."),
      match: str("all_terms or partial."),
      canonical_citation: CANONICAL_CITATION,
      missing_terms: strs("On partial: the query terms this section lacks."),
      special_program: str("The special program this section belongs to (ranked x0.5)."),
      also_at: any("Same-text copies dropped from the list."),
      section_status: str("\"deleted\": a deleted-section stub."),
      section_status_date: str("Date of section_status."),
      obligation_type: str("note or index: not rule text."),
      authority: str("The document and section title."),
      rank_score: int("The score results are ordered by."),
      currency: CURRENCY,
    })).optional().describe("Ranked sections, highest rank_score first (may be empty)."),
    reason: str("With empty results: empty_query, no_match or no_match_above_threshold."),
    cited: any("When the query is a citation: {citation, register_ids}."),
    handbook: any("When the query names a whole handbook: its outline."),
  }, "search_regs result."),

  lookup_citation: obj({
    register_id: str("The register the citation resolves to."),
    source_url: str("The regulator's URL for the resolved section's document."),
    page_url: str("The section's page on claudeforcompliance.com (verbatim text, currency notices, link to the regulator)."),
    canonical_id: str("Set when the register is a same-text copy of that register."),
    also_at: strs("Identical copies of the section (other register ids)."),
    also_at_note: str("Explains also_at."),
    candidates: strs("On ambiguous: the registers the citation could mean."),
    superseded_candidates: strs("Candidates dropped because a current register replaces them."),
    superseded_register_id: str("The register holding the prior text of this section."),
    related: any("Documents that cite or amend the section ({register_id, relation}); not its text."),
    related_note: str("Explains related."),
    obligations: any("The register's sections ({obligation_id, section}; when no text is inlined, `opening`: the first words of the section's verbatim text, cut and marked with ...)."),
    parsed: any("The parse of the citation ({kind, canonical, ...})."),
    topics: any("Topics under a structured citation."),
    handbook: any("When the citation names a whole handbook: its outline."),
    citation: str("The citation as given (on unparsed)."),
    truncated: bool("The candidate scan hit its limit."),
    ...RENUMBERED,
  }, "lookup_citation result."),

  get_reg: obj({
    register_id: str("The register id."),
    canonical_id: str("Set when this register is a same-text copy of that register."),
    also_at: strs("Same-text copies of this register."),
    authority: str("The document title."),
    source_url: str("The regulator's URL for the document."),
    page_url: str("The section's page on claudeforcompliance.com (verbatim text, currency notices, link to the regulator)."),
    canonical_citation: CANONICAL_CITATION,
    effective_date: nstr("Effective date, or null."),
    status: str("E.g. current, superseded, unknown."),
    superseded_by: nstr("The replacing register, or null."),
    coverage_tier: str("How completely the corpus holds the document."),
    currency: CURRENCY,
    obligations: z.array(z.looseObject({
      obligation_id: str("The obligation (section) id."),
      section: str("The section designation or title."),
      canonical_citation: CANONICAL_CITATION,
      chars_total: int("Length of the section's text in characters."),
      will_truncate: bool("The section exceeds one 24,000-char page."),
      version: VERSION,
      other_version: OTHER_VERSION,
      mandatory_date: MANDATORY,
      currency: CURRENCY,
    })).optional().describe("The register's obligations (a manifest, not regulator text)."),
    obligation_id: str("Echoed on error."),
    ...RENUMBERED,
  }, "get_reg result."),

  get_obligation: obj({
    ...PROVENANCE,
    chars_offset: int("Where this response starts in the section's text."),
    chars_returned: int("Characters of text in this response."),
    chars_total: int("The section's total length."),
    truncated: bool("More text follows this response."),
    started_mid_section: bool("Text before chars_offset is not in this response."),
    next_offset: nint("The next page's offset, or null when the section ends here."),
    paging: z.looseObject({
      page: nint("This page's number, or null past the end."),
      pages: int("Total pages at this page size."),
      next_offset: nint("The next page's offset, or null at the end."),
      how: str("The server's paging note."),
    }).optional().describe("Page N of M."),
    verbatim: str("The regulator's exact text, between <<<BEGIN VERBATIM>>> and <<<END VERBATIM>>>."),
    figures: z.array(z.looseObject({
      value: str("The figure as a number string, e.g. \"43\", \"50/50\"."),
      unit: str("percent, percentage_point, currency, duration, ratio, fraction, age, day_of_period, time, count, number or temperature."),
      offset: int("Position in this response's text."),
      as_written: str("The figure as written, when it differs."),
    })).optional().describe("Best-effort extraction of figures in the text; an empty or incomplete list is not evidence that the text states no figure."),
    editorial: any("Reserved; summary is null (the text is not summarized)."),
    version_changes: any("With compare_versions: sentences Update 18 deletes and adds, or {error: \"single_version\"}."),
    obligations: any("On kind renumbered: the new register's sections ({obligation_id, section}), no text."),
    ...RENUMBERED,
  }, "get_obligation result."),

  find_in_section: obj({
    ...PROVENANCE,
    chars_total: int("The section's total length."),
    terms: z.array(z.looseObject({
      term: str("The term as given."),
      expanded_to: any("Spellings and abbreviations it expanded to."),
      paragraphs: int("Paragraphs containing it."),
    })).optional().describe("Per-term match counts."),
    total_matches: int("Matching paragraphs."),
    passages_available: int("Passages the matches make (tables and lists merged)."),
    passages_returned: int("Passages in this response."),
    truncated: bool("More passages matched than were returned."),
    toc_omitted: bool("The section's table-of-contents line was omitted."),
    merged_into_tables: int("Matching paragraphs merged into whole tables."),
    merged_into_lists: int("Matching paragraphs merged into lists with their lead-in."),
    matches_note: str("How total_matches became passages_available."),
    passages: z.array(z.looseObject({
      offset: int("Where the passage starts in the section's text."),
      chars: int("The passage's length."),
      heading: nstr("The nearest heading above (verbatim), or null."),
      heading_path: nstr("Every heading above, joined by \" > \", or null."),
      canonical_citation: CANONICAL_CITATION,
      matched_terms: strs("The terms this passage matched."),
      table: bool("The passage is a whole table."),
      table_layout: str("\"flattened\": the source lost its table layout; cells may not line up."),
      table_complete: bool("false when the table may continue past the passage."),
      continues_at: int("Offset where the table continues, when table_complete is false."),
      list_included: bool("The passage ends in a colon and includes the list it introduces."),
      verbatim: str("The regulator's exact text."),
    })).optional().describe("Matching verbatim passages, in section order."),
  }, "find_in_section result."),

  verify_quote: obj({
    source_url: z.string().optional().describe("The regulator's URL for the matched section's document."),
    page_url: z.string().optional().describe("The matched section's page on claudeforcompliance.com."),
    outcome: z.enum(["exact", "normalized", "composed", "not_found", "not_checked"]).optional().describe(
      "exact: contiguous in the source; normalized: matches after typography, spacing, footer " +
      "or list-marker folding; composed: all words in source order, non-contiguous; " +
      "not_found: no source support; not_checked: over 5,000 words.",
    ),
    coverage: int("Share of the text's words found in the source (0 to 1)."),
    unsupported: any("On not_found: spans with no source support."),
    omissions: any("On composed: short source phrases skipped between pieces."),
    differences: any("On a near miss: {closest_source, missing_from_quote, extra_in_quote}."),
    segments: int("On composed: source pieces the text is assembled from."),
    elisions: int("On composed: gaps (marked or not)."),
    typography_folded: bool("Matched after folding quotes and dashes."),
    furniture_ignored: bool("A page footer or running head was ignored."),
    spacing_ignored: bool("Only spacing differs."),
    list_markers_ignored: bool("Added list markers were ignored."),
    checked_against: any("Source documents checked (document, edition, retrieval date)."),
    checked_snapshot_ids: any("Snapshot ids checked."),
    matched_version: str("current, superseded (a prior version) or update-18-optional."),
    superseded_register_id: str("On superseded: the register holding the prior text."),
    superseded_by: nstr("On superseded: the current register."),
    matched_against: str("The checked document the text matched."),
    matched_register_id: str("The register whose stored text contains the passage."),
    matched_obligation_id: str("The obligation whose stored text contains the passage."),
    also_in_obligation_id: str("On a match in an amending issuance: the amended obligation that also carries the text."),
    mandatory_date: MANDATORY,
    reason: str("On not_checked: too_long."),
    words: int("On not_checked: the word count."),
    limit: int("On not_checked: the word limit."),
    register_id: str("Echoed on not_found."),
  }, "verify_quote result."),

  list_playbooks: obj({
    playbooks: z.array(z.looseObject({
      id: str("The playbook id."),
      title: str("The playbook's name."),
      what: str("What it does."),
      when: str("When it applies."),
      user_provides: any("What the user supplies."),
      version: any("The playbook's version."),
      prompt: str("The matching MCP prompt name."),
    })).optional().describe("The available playbooks."),
    privacy: any("How user material is handled."),
    next: str("The server's note on the next step."),
  }, "list_playbooks result."),

  start_playbook: obj({
    id: str("The playbook id."),
    title: str("The playbook's name."),
    version: any("The playbook's version."),
    privacy: any("How user material is handled."),
    user_provides: any("What the user supplies."),
    kit: any("The rule kit ({kind, source, version, load_with})."),
    stages: any("The workflow's stages."),
    references: strs("The playbook's reference names."),
    load_reference_with: nstr("How a reference is loaded, or null when there are none."),
    instructions: any("The playbook's workflow instructions."),
    valid_ids: VALID_IDS,
  }, "start_playbook result."),

  get_playbook_reference: obj({
    id: str("The playbook id."),
    name: str("The reference name."),
    content: any("The reference's content."),
    valid_ids: VALID_IDS,
    valid_names: strs("On unknown_reference: the valid names."),
  }, "get_playbook_reference result."),

  get_playbook_kit: obj({
    id: str("The playbook id."),
    kit: any("The kit's kind, source and version."),
    offset: int("Where this page starts."),
    rows_returned: int("Rows in this page."),
    rows_total: int("Rows in the kit."),
    next_offset: nint("The next page's offset, or null when the kit is complete."),
    rows: any("Kit rows: verbatim rule text with citations."),
    how_to_read: str("For a corpus-register kit: the server's reading note."),
    search_family: any("For a corpus-register kit: its search family."),
    areas: any("For a corpus-register kit: its areas and registers."),
    valid_ids: VALID_IDS,
  }, "get_playbook_kit result."),
};
