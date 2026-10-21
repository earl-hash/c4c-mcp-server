import { z } from "zod";
import { buildEnvelope, MAX_CHARS } from "../envelope.js";
import {
  ambiguousHandbook, bareHandbookSection, isOwnDocument, outlineCode, parseCfrPart, parseCitation,
  parseHandbook, resolve, uscMatches,
} from "../citation.js";
import {
  CURRENCY_COLUMNS, CURRENCY_COLUMNS_BRIEF, currencyJoin, currencyOf, fetchObligationCurrency, withObligationCurrency,
} from "../currency.js";
import { collapseCandidates, fetchAliasRows, resolveObligationAlias } from "../aliases.js";
import { canonicalCitation } from "../canonical.js";
import { shortTitle } from "../titlefit.js";
import { dualVersionIds, fetchVersions, versionBrief, UPDATE_18 } from "../versions.js";
import { compareVersions } from "../versiondiff.js";
import { withCitationText, hoistKeys, LOOKUP_LIST_MAX } from "../inline.js";
import { withSourceUrl } from "../sourceurl.js";
import { leadsText } from "../currency-lead.js";
import { buildDigest } from "../digest.js";
import { renumberedById, renumberedByObligation, renumberedResult, withRenumbered } from "../renumbered.js";

// Task 6 fix round 1, Defect A: outline codes nest (Chapter I is a substring of
// every Chapter II/III section sharing the same sub-path), so a raw LIKE '%...%'
// hit is only a cheap SQL prefilter -- it is NOT authoritative on whether the
// canonical citation actually occurs in `authority` as a distinct token. This
// boundary regex is the authority: a candidate qualifies only when `canonical` is
// not immediately preceded or followed by an alphanumeric or ".". escapeRegExp is
// required because canonical routinely contains "." (a regex metacharacter) that
// must be matched literally, not as a wildcard.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function boundaryMatches(canonical, authority) {
  const re = new RegExp(`(^|[^A-Za-z0-9.])${escapeRegExp(canonical)}([^A-Za-z0-9]|$)`);
  return re.test(authority ?? "");
}

// Raised from the original 10 (Task 6 fix round 1): the boundary filter above runs
// after the SQL LIKE prefilter, so more raw rows must be fetched than the number of
// genuine candidates expected, to avoid silently dropping real matches. If the raw
// row count still hits this cap, `truncated: true` is surfaced in the response
// rather than silently capping the candidate list.
const CITATION_LIMIT = 100;

// Pulled out of the tool handler so the LIMIT/truncated-flag behavior (Task 6 fix
// round 1's "one small thing") has a unit test that doesn't require mocking D1:
// `rawRows` is exactly the shape `env.CORPUS...all().results` would carry --
// `[{register_id, authority}, ...]`, already capped at `limit` by the SQL LIMIT.
// `registerRows` ([{register_id, authority}], FHA only) are the handbook registers, whose
// section is recoverable only from the spelled-out outline path in registers.authority
// (see outlineCode). A derived code must EQUAL the canonical: "II.A.4" is not "II.A.4.c".
// The section's own register ids and the ids of documents that merely cite it.
// A statute (kind "usc") is matched by uscMatches, which reads the corpus's own spellings
// ("38 U.S.C. §3709(a)", "(38 U.S.C. ch. 37) § 3710"); its own register is the one named
// for the section (uscOwnId). When no citing register is named for the section, every
// citing register stays a candidate (the pre-2026-09-26 behavior for statutes).
export function lookupCandidates(rawRows, parsed, registerRows = []) {
  const c = parsed.canonical;
  const cites = parsed.kind === "usc"
    ? (t) => uscMatches(c, t)
    : (t) => boundaryMatches(c, t);
  const own = new Set();
  const others = new Set();
  for (const r of registerRows ?? []) {
    if (outlineCode(r.authority) === c || boundaryMatches(c, r.authority)) own.add(r.register_id);
  }
  // LIKE is a cheap SQL prefilter only; the matcher is authoritative (Defect A).
  const hits = (rawRows ?? []).filter((r) => cites(r.authority) || cites(r.section));
  const anyOwn = parsed.kind !== "usc" ||
    hits.some((r) => isOwnDocument(parsed.kind, r.register_id, c));
  for (const r of hits) {
    const isOwn = anyOwn ? isOwnDocument(parsed.kind, r.register_id, c) : true;
    (isOwn ? own : others).add(r.register_id);
  }
  return { own: [...own].sort(), related: [...others].filter((id) => !own.has(id)).sort() };
}

// `aliasRows` (src/aliases.js): same-text copies among the own registers collapse to one
// before ambiguity is decided.
export function buildLookupResult(rawRows, parsed, limit, registerRows = [], aliasRows = [], citation = "") {
  const raw = rawRows ?? [];
  const found = lookupCandidates(raw, parsed, registerRows);
  const { related } = found;
  const own = narrowCandidates(found.own, raw, parsed, citation, registerRows);
  const truncated = raw.length === limit;
  const result = resolve(own.map((register_id) => ({ register_id })), related, aliasRows);
  if (result.error === "not_found" && related.length) {
    result.hint = "The section's own text is not in this corpus under that number; the " +
      "related documents cite it but are not it. Use search_regs for the section's topic.";
  }
  return { ...result, parsed, ...(truncated ? { truncated: true } : {}) };
}

// NARROWING (batch 8, stress6 C11): candidates that are not a real choice leave the list before
// ambiguity is decided --
//   qualifier  "Fannie Mae Servicing Guide A2-1-01" names the Servicing Guide: its fnma-svc-
//              registers only ("Selling Guide" likewise fnma-sel-);
//   excerpts   an excerpt register (every matched row's section a digest line, "FNMA Servicing
//              Guide D2-2-03 — Send payment reminder ...") yields to the section's full register.
// Each step applies only when it leaves at least one candidate.
const EXCERPT_SECTION = /^(?:FNMA|FHLMC)\s/;
//   level      (batch 10, stress6 C11 N8) an FHA 4000.1 register whose OWN outline position is
//              the cited one ("... 4. Underwriting ... TOTAL -- b. Credit Requirements (TOTAL)"
//              for "4000.1 II.A.4.b", the section's full text) wins over a register that
//              matched only through rows citing a deeper level (hud-4000-1-ii-a-4: two
//              excerpts headed "II.A.4.b.i", same source snapshot).
export function narrowCandidates(own, rawRows, parsed, citation = "", registerRows = []) {
  let out = [...own];
  const keep = (next) => { if (next.length) out = next; };
  if (parsed?.kind === "fha" && out.length > 1) {
    const exact = new Set((registerRows ?? []).filter((r) => outlineCode(r.authority) === parsed.canonical)
      .map((r) => r.register_id));
    keep(out.filter((id) => exact.has(id)));
  }
  if (parsed?.kind === "fnma") {
    const c = String(citation ?? "");
    if (/\bservic(?:ing|er)\s+guide\b/i.test(c)) keep(out.filter((id) => id.startsWith("fnma-svc-")));
    else if (/\bsell(?:ing|er)\s+guide\b/i.test(c)) keep(out.filter((id) => id.startsWith("fnma-sel-")));
  }
  if (out.length > 1) {
    const rows = new Map();
    for (const r of rawRows ?? []) {
      if (!out.includes(r.register_id) || r.section === undefined) continue;
      rows.set(r.register_id, (rows.get(r.register_id) ?? true) && EXCERPT_SECTION.test(String(r.section ?? "")));
    }
    // Only against a full register of the same document (fnma-svc- / fnma-sel- ...): an excerpt
    // of the Selling Guide's A2-1-01 is not a copy of the Servicing Guide's A2-1-01.
    const doc = (id) => String(id).split("-").slice(0, 2).join("-");
    const fullDocs = new Set(out.filter((id) => rows.get(id) !== true).map(doc));
    keep(out.filter((id) => rows.get(id) !== true || !fullDocs.has(doc(id))));
  }
  return out;
}

// One obligation with its register's provenance and currency (src/currency.js). Shared
// with find_in_section (tools/find.js).
// canonical_id is non-null only when the register is a same-text copy (src/aliases.js).
export const OBLIGATION_SQL = `
  SELECT o.*, r.effective_date, r.coverage_tier, r.status, r.superseded_by,
         r.authority AS register_title, ${CURRENCY_COLUMNS},
         al.canonical_id AS canonical_id
  FROM obligations o JOIN registers r ON r.register_id = o.register_id
  ${currencyJoin("o.register_id")}
  LEFT JOIN aliases al ON al.register_id = o.register_id
  WHERE o.obligation_id = ?1`;

// One obligation row (OBLIGATION_SQL) with its own obligation-level currency, if any, in
// place of the register's (src/currency.js). null when the obligation does not exist.
// An id that is not in `obligations` is resolved through obligation_aliases (src/aliases.js;
// a retired CFR paragraph split or Freddie "-full" duplicate): the row then carries
// `resolved_from_alias` (the id asked for). Up to 3 hops; fails open (no table = no alias).
export async function fetchObligationRow(env, obligationId) {
  let row = await env.CORPUS.prepare(OBLIGATION_SQL).bind(obligationId).first();
  let from = null;
  if (!row) {
    let id = obligationId;
    for (let hop = 0; hop < 3 && !row; hop++) {
      const next = await resolveObligationAlias(env, id);
      if (!next || next === id) break;
      id = next;
      row = await env.CORPUS.prepare(OBLIGATION_SQL).bind(id).first();
    }
    if (row) from = obligationId;
  }
  if (!row) return null;
  const out = withObligationCurrency(row, await fetchObligationCurrency(env, [row.obligation_id]));
  return from ? { ...out, resolved_from_alias: from } : out;
}

// The response fields for a row reached through an alias (empty otherwise).
export function aliasNote(row) {
  if (!row?.resolved_from_alias) return {};
  return {
    resolved_from_alias: row.resolved_from_alias,
    alias_note: `${row.resolved_from_alias} is a retired obligation id; its text is now in ` +
      `${row.obligation_id}. Use that obligation_id from here on (paging, find_in_section).`,
  };
}

const REGISTER_SQL =
  `SELECT r.*, ${CURRENCY_COLUMNS}, al.canonical_id AS canonical_id FROM registers r ` +
  `${currencyJoin("r.register_id")} LEFT JOIN aliases al ON al.register_id = r.register_id ` +
  "WHERE r.register_id = ?1";

export function registerGetTools(server, env) {
  server.registerTool(
    "get_obligation",
    {
      description:
        "Returns one obligation's (section's) verbatim regulator text with provenance. " +
        "Inputs: `obligation_id`; optional `offset`, `limit`, `compare_versions`. `verbatim` " +
        "holds the text between <<<BEGIN VERBATIM>>> and <<<END VERBATIM>>>. " +
        "`canonical_citation` is the section's citation in the regulator's style (e.g. " +
        "\"4000.1 II.A.5.d\", \"B3-3.3-07\", \"38 U.S.C. 3709(b)\"), or null. Paging: at most " +
        "24,000 chars per response; `chars_offset` + `chars_returned` is the position within " +
        "`chars_total`; `next_offset` is the offset of the next page, or null when the section " +
        "ends in this response; `truncated` means more text follows; `started_mid_section` " +
        "means text before `chars_offset` is not included; `paging` gives page N of M. " +
        "`currency` is null or a version/status signal (dual-version, pending, " +
        "revision-pending, superseded, expired...) with a one-line `headline`. An FHA 4000.1 " +
        "section HUD's Update 18 revises has two obligations, the in-force text and the " +
        "revision (`<id>::update-18`); `version` says which this is and `other_version` " +
        "identifies the other. `compare_versions: true` adds `version_changes`, the sentences " +
        "Update 18 deletes and adds. `figures` is a best-effort extraction of figures in the " +
        "text; an empty or incomplete list is not evidence that the text states no figure. `canonical_id`, when set, is the register this " +
        "one is a same-text copy of.",
      inputSchema: {
        obligation_id: z.string().min(1),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(MAX_CHARS).optional()
          .describe("Max chars to return from offset (200-24000; default 24000)."),
        compare_versions: z.boolean().optional()
          .describe("On an FHA section Update 18 revises: also return `version_changes`, " +
            "the sentences Update 18 deletes and adds (verbatim units with offsets)."),
      },
    },
    async ({ obligation_id, offset, limit, compare_versions }) => {
      const row = await fetchObligationRow(env, obligation_id);
      // A section the regulator renumbered (src/renumbered.js): no text under the old number.
      const moved = renumberedById(row?.register_id) ?? (row ? null : renumberedByObligation(obligation_id));
      if (moved) {
        const out = await renumberedResult(env, moved, { requested_id: obligation_id });
        return { content: [{ type: "text", text: JSON.stringify(await withSourceUrl(env, out)) }] };
      }
      if (!row) {
        // Refusal contract, spec 5.4: no suggestions. A near match is
        // nearest-matching through the back door.
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "not_found",
              obligation_id,
              hint: "Use search_regs or lookup_citation to find a valid obligation_id.",
              // Batch 17 (OpenAI A/B N37): a register_id passed as an obligation_id is not a
              // near match -- it names the register exactly; list its obligation ids.
              ...(await registerObligations(env, obligation_id)),
            }),
          }],
        };
      }
      const versions = await fetchVersions(env, dualVersionIds([row]));
      const envelope = { ...buildEnvelope(row, { offset: offset ?? 0, versions, limit }), ...aliasNote(row) };
      if (compare_versions) envelope.version_changes = await versionChanges(env, row, versions);
      // Batch 22: an active currency signal is read first, not ~600 chars in (src/currency-lead.js).
      const out = leadsText(envelope.currency) ? hoistKeys(envelope, "obligation_id", ["currency"]) : envelope;
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    },
  );

  server.registerTool(
    "get_reg",
    {
      description:
        "Returns a manifest of one register (source document): its provenance, `currency` " +
        "(null or a version/status signal: dual-version, pending revision, superseded, " +
        "expired...) and its obligations (sections), each with `obligation_id`, section, " +
        "`canonical_citation`, `chars_total` and `will_truncate` (true when the section " +
        "exceeds one 24,000-char page). The manifest contains no regulator text. A " +
        "dual-version section lists both obligations, each with `version` (\"in-force\" or " +
        "\"update-18-optional\") and `other_version`.",
      inputSchema: { register_id: z.string().min(1) },
    },
    async ({ register_id }) => {
      const moved = renumberedById(register_id);
      if (moved) {
        const out = await renumberedResult(env, moved, { requested_id: register_id });
        return { content: [{ type: "text", text: JSON.stringify(await withSourceUrl(env, out)) }] };
      }
      const reg = await env.CORPUS.prepare(REGISTER_SQL).bind(register_id).first();
      if (!reg) {
        return { content: [{ type: "text", text: JSON.stringify({
          error: "not_found", register_id,
          hint: "Use search_regs or lookup_citation to find a valid register_id.",
        }) }] };
      }
      // chars_total = the served text's length (the build-time count can disagree; see
      // envelope.js buildEnvelope), so will_truncate matches what get_obligation returns.
      const { results } = await env.CORPUS
        .prepare("SELECT obligation_id, section, length(verbatim) AS chars_total FROM obligations " +
                 "WHERE register_id = ?1 ORDER BY obligation_id")
        .bind(register_id).all();
      const aliasRows = await fetchAliasRows(env, [register_id]);
      const versions = reg.currency_kind === "dual-version"
        ? await fetchVersions(env, (results ?? []).map((o) => o.obligation_id))
        : new Map();
      const oc = await fetchObligationCurrency(env, (results ?? []).map((o) => o.obligation_id));
      // Batch 19: a chapter / chapter-index / whole-document register also carries the same
      // key-rules digest lookup_citation gives (src/digest.js) -- a one-call model that picks
      // get_reg would otherwise see only a manifest of heading obligations.
      let manifest = buildManifest(reg, results ?? [], aliasRows, versions, oc);
      const digest = await buildDigest(env, register_id);
      if (digest) {
        const { child_ids: childIds, ...rest } = digest;
        manifest.digest = { ...rest, ...(childIds && (results ?? []).length <= 1 ? { child_ids: childIds } : {}) };
        // Batch 22: a currency-led digest is read before the obligation list.
        if (/^CURRENCY[ :(]/.test(rest.operative_text ?? "")) manifest = hoistKeys(manifest, "currency", ["digest"]);
      }
      return { content: [{ type: "text", text: JSON.stringify(await withSourceUrl(env, manifest)) }] };
    },
  );

  server.registerTool(
    "lookup_citation",
    {
      description:
        "Resolves a regulatory citation (e.g. '4000.1 II.A.8.d', 'B3-4.3-04', " +
        "'Freddie Mac Guide 5306.1', '38 U.S.C. 3737', 'M26-7 Chapter 4 Topic 9', " +
        "'SBA Notice 5000-872764', 'SOP 50 10 8 B.Ch1.A.2', 'HB-1-3555 11.3') to a " +
        "`register_id`. Errors: `not_found` (the cite parses but is not in the corpus; " +
        "`parsed` shows the parse), `ambiguous` (it could mean several registers, listed in " +
        "`candidates`; no guess is made), `unparsed` (not recognizable as a citation). Near " +
        "matches are not suggested. A handbook section resolves to the handbook's own " +
        "register; documents that cite or amend it (e.g. Mortgagee Letters) are listed in " +
        "`related` and are not the section's text. Identical copies of a section resolve to " +
        "one register and are listed in `also_at`. A whole-handbook name returns `handbook`, " +
        "an outline of its parts. A section the regulator renumbered returns `kind` " +
        "\"renumbered\": `register_id` is the section under its new number, `renumbered_from` the " +
        "old register, and no text is given under the old number.",
      inputSchema: { citation: z.string().min(1) },
    },
    async ({ citation }) => {
      const result = await resolveCitation(env, citation);
      // A renumbered section carries no inline text: its text is quoted under the new number.
      const shown = result?.kind === "renumbered" ? result : await withCitationText(env, result);
      return { content: [{ type: "text", text: JSON.stringify(await withSourceUrl(env, shown)) }] };
    },
  );
}


// BARE STATUTE SECTIONS (citation-anchored search, 2026-09-30; real session: "2605(e)(3)
// qualified written request ..." and "1681i(a)(1) reinvestigation ..." named RESPA and FCRA
// sections without their title and were read as plain words). A 4-5 digit section number
// (optional letter / "-N" suffix) followed by a pinpoint, or written after "§", is a statute
// cite when the corpus holds exactly one statute register with that section number, of
// whichever title. Returns the full cite ("12 U.S.C. 2605(e)(3)") or null. Short numbers are
// never read ("401(k)", "203(k)" are program names, not cites).
const BARE_USC = /(?<![\w.§-])(\d{4,5}[a-z]{0,2}(?:-\d{1,2})?)((?:\([A-Za-z0-9]{1,4}\))+)|§\s*(\d{4,5}[a-z]{0,2}(?:-\d{1,2})?)((?:\([A-Za-z0-9]{1,4}\))*)/;

export function bareStatuteParse(raw) {
  const m = String(raw ?? "").match(BARE_USC);
  if (!m) return null;
  return m[1] ? { section: m[1].toLowerCase(), pinpoint: m[2] } : { section: m[3].toLowerCase(), pinpoint: m[4] ?? "" };
}

export async function bareStatute(env, raw) {
  const p = bareStatuteParse(raw);
  if (!p) return null;
  try {
    const { results } = await env.CORPUS
      .prepare("SELECT register_id FROM registers WHERE register_id LIKE ?1 LIMIT 50")
      .bind(`%usc-${p.section}%`).all();
    const own = new RegExp(`-(\\d+)usc-${p.section}(?:-[a-z][a-z0-9-]*)?$`);
    const titles = new Set((results ?? []).map((r) => String(r.register_id).match(own)?.[1]).filter(Boolean));
    return titles.size === 1 ? `${[...titles][0]} U.S.C. ${p.section}${p.pinpoint}` : null;
  } catch {
    return null;
  }
}

// lookup_citation's body (Round 4: shared with search_regs citation routing). Returns the
// tool's JSON object: a resolved register (register_id / canonical_id / also_at / related),
// `ambiguous` with candidates, `not_found` with the parse, or `unparsed`. A whole handbook
// named without a section ("HUD Handbook 4000.1") returns its overview (`handbook`).
export async function resolveCitation(env, citation) {
  const parsed = parseCitation(citation);
  if (!parsed) {
    const bare = await bareStatute(env, citation);
    if (bare) return resolveCitation(env, bare);
    const section = bareHandbookSection(citation);
    if (section) return ambiguousHandbook(citation, section);
    const cfrPart = parseCfrPart(citation);
    if (cfrPart) return cfrPartResult(env, cfrPart);
    const hb = parseHandbook(citation);
    if (hb) {
      const overview = await handbookOverview(env, hb);
      if (overview) {
        return {
          parsed: { kind: hb.kind, canonical: hb.canonical },
          ...(overview.currency ? { currency: overview.currency } : {}),
          handbook: overview,
          hint: "This names a whole handbook, not a section. Cite a section (see `handbook` " +
            "for its parts) or use search_regs with the topic and family \"" + hb.family + "\".",
        };
      }
    }
    return {
      error: "unparsed", citation,
      hint: "Not recognizable as a citation. Use search_regs for a topical question.",
    };
  }
  if (parsed.register_ids) return withRenumbered(env, await lookupStructured(env, parsed), parsed);
  const like = `%${parsed.canonical}%`;
  let results, registerRows = [];
  if (parsed.kind === "usc") {
    // The corpus never writes the canonical "38 U.S.C. 3709" (it has "§3709(a)" or
    // "(38 U.S.C. ch. 37) § 3710"): prefilter on the section number among statute
    // cites; uscMatches (lookupCandidates) is authoritative.
    const sectionLike = `%${parsed.canonical.split(" ").pop()}%`;
    ({ results } = await env.CORPUS
      .prepare("SELECT DISTINCT register_id, authority, section FROM obligations " +
               "WHERE (authority LIKE ?1 OR section LIKE ?1) " +
               "AND (authority LIKE '%U%S%C%' OR section LIKE '%U%S%C%') " +
               "ORDER BY register_id LIMIT ?2")
      .bind(sectionLike, CITATION_LIMIT).all());
  } else if (parsed.kind === "fha") {
    // Handbook registers first: their section lives in registers.authority (an outline
    // path or a short "Part II.A.4"), and curated ones carry it in obligation.section.
    ({ results: registerRows } = await env.CORPUS
      .prepare("SELECT register_id, authority FROM registers " +
               "WHERE register_id LIKE 'hud-4000-1-%' AND (authority LIKE '%>%' OR authority LIKE ?1)")
      .bind(like).all());
    ({ results } = await env.CORPUS
      .prepare("SELECT register_id, authority, section FROM obligations " +
               "WHERE authority LIKE ?1 OR section LIKE ?1 ORDER BY register_id LIMIT ?2")
      .bind(like, CITATION_LIMIT).all());
  } else {
    ({ results } = await env.CORPUS
      .prepare("SELECT register_id, authority, section FROM obligations " +
               "WHERE authority LIKE ?1 ORDER BY register_id LIMIT ?2")
      .bind(like, CITATION_LIMIT).all());
  }
  const { own } = lookupCandidates(results, parsed, registerRows);
  const aliasRows = await fetchAliasRows(env, own);
  const result = withOwnSection(buildLookupResult(results, parsed, CITATION_LIMIT, registerRows, aliasRows, citation), parsed);
  return withRenumbered(env, commentaryNote(await amendingPinpoint(env, await pinpointObligation(env, withPinpoint(withCommentary(withSupersession(result, await fetchSupersession(env, [
    ...(result.register_id ? [result.register_id] : []), ...(result.candidates ?? []),
  ])), citation), citation)), parsed, citation)), parsed);
}

// A WHOLE CFR PART (mf-3, 2026-10-14): "24 CFR Part 207" named no section, so it came back
// `unparsed` -- for every part, "12 CFR Part 1026" too. It now lists the part's section
// registers the corpus holds (each register is one section), with their families: 24 CFR
// Part 200 mixes multifamily (hudmf) and single family / cross-program (hud) subparts.
const CFR_PART_LIST_MAX = 120;
export async function cfrPartResult(env, cp) {
  const { results } = await env.CORPUS
    .prepare("SELECT r.register_id, r.authority, r.family, MIN(o.section) AS section FROM obligations o " +
             "JOIN registers r ON r.register_id = o.register_id " +
             "WHERE (o.section LIKE ?1 OR o.section LIKE ?2) AND r.register_id NOT LIKE '%superseded%' " +
             "GROUP BY r.register_id")
    .bind(`${cp.title} CFR §${cp.part}.%`, `${cp.title} CFR ${cp.part}.%`).all();
  const rows = results ?? [];
  const parsed = { kind: cp.kind, canonical: cp.canonical };
  if (!rows.length) {
    return { error: "not_found", parsed,
      hint: `The corpus holds no section of ${cp.canonical}. Use search_regs for the topic.` };
  }
  const num = (r) => {
    const m = String(r.section ?? "").match(/§?\s*\d+\.(\d+)([a-z]*)/);
    return m ? [Number(m[1]), m[2]] : [Infinity, ""];
  };
  rows.sort((a, b) => {
    const [x, xs] = num(a), [y, ys] = num(b);
    return x - y || xs.localeCompare(ys) || a.register_id.localeCompare(b.register_id);
  });
  const families = {};
  for (const r of rows) families[r.family] = (families[r.family] ?? 0) + 1;
  return {
    parsed,
    handbook: {
      name: cp.canonical, kind: "cfr_part", registers: rows.length, families,
      sections: rows.slice(0, CFR_PART_LIST_MAX).map((r) => ({
        register_id: r.register_id, authority: r.authority, family: r.family })),
      ...(rows.length > CFR_PART_LIST_MAX ? { truncated: true } : {}),
    },
    hint: `This names a whole CFR part, not a section. Cite a section ("${cp.title} CFR ` +
      `${cp.part}.x") with lookup_citation, or search_regs with the topic.`,
  };
}

// AMENDING PINPOINT (2026-10-07 citation-check test): "4000.1 III.A.2.i.iii(C)" resolved to the
// whole III.A.2.i register and never surfaced ML 2026-08, whose own provisions are titled with
// that pinpoint ("Trial Payment Plans -- Definitions (III.A.2.i.iii(C)(1))") and replaced the
// rule. When an FHA cite goes deeper than the section we resolve, attach the non-handbook
// obligations (Mortgagee Letters) whose section carries the pinpoint, with their currency.
const FHA_PIN_RE = /\b((?:I{1,3}|IV|V)\.[A-Z]\.\d+\.[a-z](?:\.[ivx]+)?(?:\([A-Za-z0-9]+\))*)/;
export async function amendingPinpoint(env, result, parsed, citation) {
  if (!result || parsed?.kind !== "fha") return result;
  const m = FHA_PIN_RE.exec(String(citation ?? ""));
  if (!m || m[1].length <= String(parsed.canonical ?? "").length) return result;
  const pin = m[1];
  let rows = [];
  try {
    ({ results: rows } = await env.CORPUS
      .prepare(`SELECT o.obligation_id, o.section, o.register_id, ${CURRENCY_COLUMNS_BRIEF} ` +
               `FROM obligations o ${currencyJoin("o.register_id")} ` +
               "WHERE o.section LIKE ?1 AND o.register_id NOT LIKE 'hud-4000-1-%' " +
               "ORDER BY o.register_id DESC, o.obligation_id LIMIT 8")
      .bind(`%${pin}%`).all());
  } catch { return result; }
  if (!rows?.length) return result;
  return {
    ...result,
    amending_pinpoint: {
      citation: pin,
      note: "Provisions of later issuances (e.g. Mortgagee Letters) written for this exact pinpoint. " +
        "They may replace the handbook text; read them with get_obligation and apply each one's currency.",
      obligations: rows.map((r) => ({
        obligation_id: r.obligation_id, section: r.section, register_id: r.register_id,
        ...(currencyOf(r) ? { currency: currencyOf(r) } : {}),
      })),
    },
  };
}

// RULE vs ITS COMMENTARY (2026-10-03, Copilot test): lookup_citation("12 CFR 1026.43(g)")
// came back ambiguous between reg-z-1026-43 and reg-z-1026-supplement-i-43, so the model
// never read the rule. A per-section Supplement I register interprets the rule named in its
// id; it is not a second reading of the citation. Ambiguity between a rule and only its own
// commentary resolves to the rule (pinpoints then apply to it), or to the commentary when
// the citation asks for it ("comment 43(c)-1", "Supplement I", "official interpretation").
// The other register is named in `note`. Anything else stays ambiguous.
const RULE_COMMENTARY_RE = /^(.+)-supplement-i-(\d+[a-z]?)$/;
const CITES_COMMENTARY_RE = /\b(comment(?:ary|s)?|interpretations?|supplement|staff)\b/i;

export function withCommentary(result, citation) {
  if (result?.error !== "ambiguous" || !Array.isArray(result.candidates)) return result;
  const rules = new Set(), commentary = [];
  for (const c of result.candidates) {
    const m = RULE_COMMENTARY_RE.exec(c);
    if (m) commentary.push({ id: c, rule: `${m[1]}-${m[2]}` });
    else rules.add(c);
  }
  if (rules.size !== 1 || !commentary.length) return result;
  const [rule] = rules;
  if (!commentary.every((x) => x.rule === rule)) return result;
  const { error: _e, candidates: _c, ...rest } = result;
  const ids = commentary.map((x) => x.id).join(", ");
  if (CITES_COMMENTARY_RE.test(String(citation ?? "")) && commentary.length === 1) {
    return {
      ...rest, register_id: commentary[0].id,
      [COMMENTARY_NOTE]: `${commentary[0].id} is the official interpretation (commentary) of ${rule}; ` +
        `the rule's own text is ${rule}.`,
    };
  }
  return {
    ...rest, register_id: rule,
    [COMMENTARY_NOTE]: `${rule} is the rule's text. Its official interpretation (commentary) is ${ids}; ` +
      "quote the commentary only when the question is about how the rule is interpreted.",
  };
}

// CHAPTER vs ITS OWN SECTION (2026-10-13, ChatGPT Skill map check): "Freddie Mac Guide
// 8202.2" came back ambiguous between fhlmc-8202 (the curated chapter register, whose
// obligations cite 8202.2 among its sections) and fhlmc-8202-2 (the section's verbatim
// text); 8201.1 and 9201.2 the same. A cite to a section means that section: when one
// candidate is the cited section's own register and every other candidate is a chapter
// containing it (its id is a prefix), resolve to the section and name the chapter in `note`.
export function withOwnSection(result, parsed) {
  if (result?.error !== "ambiguous" || !Array.isArray(result.candidates)) return result;
  if (parsed?.kind !== "fhlmc" || !/^\d{4}\.\d+$/.test(String(parsed.canonical ?? ""))) return result;
  const own = `fhlmc-${parsed.canonical.replace(".", "-")}`;
  if (!result.candidates.includes(own)) return result;
  // The section's own prior text ("fhlmc-8202-2-superseded-2026-10", batch b28-3) is not a rival:
  // live on 2026-10-13 it kept "8202.2" ambiguous, since this runs before withSupersession.
  const prior = result.candidates.filter((c) => c.startsWith(`${own}-superseded-`));
  const chapters = result.candidates.filter((c) => c !== own && !prior.includes(c));
  if (!chapters.length || !chapters.every((c) => own.startsWith(`${c}-`))) return result;
  const { error: _e, candidates: _c, ...rest } = result;
  return {
    ...rest, register_id: own,
    // the latest prior copy (-superseded-2026-10 < -superseded-2026-10-14, cu-5)
    ...(prior.length ? { superseded_register_id: [...prior].sort().at(-1) } : {}),
    [COMMENTARY_NOTE]: `${own} is the full text of Section ${parsed.canonical}. ` +
      `${chapters.join(", ")} covers the whole chapter; read it only for the chapter's other sections.` +
      (prior.length ? ` ${prior.join(", ")} holds prior text of this section (superseded); quote it ` +
        "only for what applied before, and say it is superseded." : ""),
  };
}

// Carried past withPinpoint/pinpointObligation (which rewrite `note`), then merged into it.
const COMMENTARY_NOTE = "__commentary_note";
export function commentaryNote(result) {
  if (!result || !(COMMENTARY_NOTE in result)) return result;
  const { [COMMENTARY_NOTE]: extra, ...rest } = result;
  return { ...rest, note: rest.note ? `${extra} ${rest.note}` : extra };
}

// SUPERSEDED / RENUMBERED CITES (batch 3, stress4 item 4 / PROBE-7): lookup_citation
// ("C1-2-06") resolved to fnma-sel-c1-2-06 -- the May 2026 text of a topic Fannie Mae
// renumbered C1-2-05 in the September 2, 2026 Selling Guide -- with no pointer, so a model
// quoted prior text as current. A cite that resolves to a register with `superseded_by`
// now resolves to the CURRENT register, naming the one it replaced:
//   renumbered_from         the old register, when its number differs (the id without its
//                           "-superseded-<year>" suffix is not the replacement's id)
//   superseded_register_id  the old register (prior text, still published and quotable
//                           for what applied before)
// Ambiguity between a superseded copy and its own replacement is not ambiguity: the
// superseded candidate drops out. Any lookup error leaves the result as it was.
export async function fetchSupersession(env, ids) {
  const list = [...new Set((ids ?? []).filter(Boolean))];
  if (!list.length) return new Map();
  try {
    const { results } = await env.CORPUS
      .prepare("SELECT register_id, superseded_by FROM registers " +
               "WHERE register_id IN (SELECT value FROM json_each(?1)) AND superseded_by IS NOT NULL")
      .bind(JSON.stringify(list)).all();
    return new Map((results ?? []).filter((r) => r?.superseded_by && r.superseded_by !== r.register_id)
      .map((r) => [r.register_id, r.superseded_by]));
  } catch {
    return new Map();
  }
}

// -superseded-<year>, or -<year>-<month> for a second prior text in one year (fnma b28-2)
const baseId = (id) => String(id).replace(/-superseded-\d{4}(?:-\d{2}){0,2}$/, "");

// PINPOINTS (batch 8, stress6 C11): "38 U.S.C. 3737(c)(1)(A)" resolves to the section; the
// subsection the section-level canonical leaves out is reported, never silently dropped.
export function withPinpoint(result, citation) {
  const canon = result?.parsed?.canonical;
  if (!canon || !result.register_id || result.parsed.kind === "fha") return result;
  const c = String(citation ?? "").replace(/[‐‑‒–—―−]/g, "-");
  const at = c.indexOf(canon);
  const tail = at === -1 ? "" : c.slice(at + canon.length);
  const m = tail.match(/^\s*((?:\([A-Za-z0-9]{1,4}\))+)/);
  if (!m) return result;
  return {
    ...result,
    pinpoint_dropped: m[1],
    note: `${result.note ? `${result.note} ` : ""}Resolved to the whole section ${canon}; the ` +
      `pinpoint ${m[1]} is not a separate register. Use find_in_section or get_reg on the ` +
      "section to read that subsection.",
  };
}

// PINPOINT OBLIGATIONS (citation-anchored search, 2026-09-30; real session: lookup_citation
// "12 U.S.C. 2605(e)" came back as the whole section with pinpoint_dropped "(e)" although
// obligation respa-12usc-2605::respa-12usc-2605-e holds exactly that subsection). A pinpoint
// resolves to the DEEPEST obligation of the resolved register whose own pinpoint (read from
// its section string: "12 CFR §1026.20(c)(1)") is a prefix of the cited one: "(e)(3)" -> the
// "(e)" obligation, with "(3)" still reported in pinpoint_dropped. The register_id is kept.
export function pinpointParts(s) {
  return [...String(s ?? "").matchAll(/\(([A-Za-z0-9]{1,4})\)/g)].map((m) => m[1].toLowerCase());
}

// The pinpoint path of an obligation's section string, read after the section number the
// canonical cite ends with ("2605" of "12 U.S.C. 2605", "1024.35"); null when it has none.
export function sectionPinpoint(section, canonical) {
  const num = String(canonical ?? "").split(" ").pop();
  if (!num) return null;
  const esc = num.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![0-9A-Za-z.])${esc}\\s*((?:\\([A-Za-z0-9]{1,4}\\))+)`);
  const m = String(section ?? "").match(re);
  return m ? pinpointParts(m[1]) : null;
}

export function bestPinpoint(rows, canonical, cited) {
  let best = null;
  for (const r of rows ?? []) {
    const path = sectionPinpoint(r.section, canonical);
    if (!path?.length || path.length > cited.length) continue;
    if (!path.every((p, i) => p === cited[i])) continue;
    if (!best || path.length > best.path.length) best = { obligation_id: r.obligation_id, path };
  }
  return best;
}

export async function pinpointObligation(env, result) {
  if (!result?.pinpoint_dropped || !result.register_id) return result;
  try {
    const cited = pinpointParts(result.pinpoint_dropped);
    const { results } = await env.CORPUS
      .prepare("SELECT obligation_id, section FROM obligations WHERE register_id = ?1 ORDER BY rowid")
      .bind(result.register_id).all();
    const best = bestPinpoint(results, result.parsed?.canonical, cited);
    if (!best) return result;
    const { pinpoint_dropped: _p, note: _n, ...rest } = result;
    const held = best.path.map((p) => `(${p})`).join("");
    const left = cited.slice(best.path.length).map((p) => `(${p})`).join("");
    return {
      ...rest,
      obligation_id: best.obligation_id,
      pinpoint: held,
      ...(left ? { pinpoint_dropped: left } : {}),
      note: `The pinpoint ${held} is obligation ${best.obligation_id} (get_obligation for its ` +
        `text)${left ? `; ${left} is inside it, not a separate obligation` : ""}. register_id is ` +
        "the whole section.",
    };
  } catch {
    return result;
  }
}

export function withSupersession(result, sup) {
  if (!sup?.size || !result) return result;
  let out = result;
  if (out.error === "ambiguous" && Array.isArray(out.candidates)) {
    // Batch 8 (stress6 C11 R13): any candidate with a replacement yields to a current one, not
    // only to its own replacement (C1-2-05: the deleted Green MBS topic vs the renumbered one).
    const own = out.candidates.filter((c) => !out.candidates.includes(sup.get(c)));
    const current = out.candidates.filter((c) => !sup.has(c));
    const keep = own.length < out.candidates.length || !current.length ? own : current;
    if (keep.length < out.candidates.length) {
      const dropped = out.candidates.filter((c) => !keep.includes(c));
      const { error: _e, candidates: _c, ...rest } = out;
      out = keep.length === 1
        ? { ...rest, register_id: keep[0], superseded_register_id: dropped[0] }
        : { ...out, candidates: keep, superseded_candidates: dropped };
      if (keep.length === 1) {
        out.note = dropped.every((d) => sup.get(d) === keep[0])
          ? `${dropped.join(", ")} holds prior text of this section, superseded by ` +
            `${keep[0]} (the current text). Quote ${keep[0]}; quote the prior text only for what ` +
            "applied before, and say it is superseded."
          : `${keep[0]} is the current text under this number. ${dropped.join(", ")} held earlier ` +
            `text under it (superseded; now ${dropped.map((d) => sup.get(d)).join(", ")}); quote it ` +
            "only for what applied before, and say it is superseded.";
      }
      return out;
    }
  }
  const old = out.register_id;
  const cur = old && sup.get(old);
  if (!cur) return out;
  const renumbered = baseId(old) !== baseId(cur);
  return {
    ...out,
    register_id: cur,
    superseded_register_id: old,
    ...(renumbered ? { renumbered_from: old } : {}),
    note: renumbered
      ? `${out.parsed?.canonical ?? old} was renumbered: its current text is ${cur}. ${old} holds ` +
        "the prior text under the old number (superseded, still published); quote the current " +
        "register and give its current number."
      : `${old} holds superseded text of this section; the current text is ${cur}. Quote ` +
        `${cur}; quote the prior text only for what applied before, and say it is superseded.`,
  };
}

// get_obligation compare_versions (C4C-11, src/versiondiff.js): the in-force text vs its
// Update 18 revision, whichever of the two was asked for. null (with a reason) when the
// obligation has a single version.
export async function versionChanges(env, row, versions) {
  const v = versions?.get?.(row.obligation_id);
  if (!v) {
    return { error: "single_version",
      hint: "This section has one version: no Update 18 revision to compare. Search with " +
        "currency_kind \"dual-version\" to list the FHA sections Update 18 revises." };
  }
  const other = await fetchObligationRow(env, v.pair_id);
  if (!other) return { error: "other_version_missing", other_obligation_id: v.pair_id };
  return v.version === UPDATE_18 ? compareVersions(other, row) : compareVersions(row, other);
}

// A structured cite (C4C-09: M26-7 / M26-4 chapter-topic, SBA notice, SOP 50 10 paragraph,
// HB-1-3555 paragraph) names its register by id. `register_ids` are tried in order (a
// topic, then the chapter register that holds it); `register_prefix` also admits an
// appendix's parts. Parsed but absent -> not_found with the parse, never `unparsed`.
export async function lookupStructured(env, parsed) {
  const ids = parsed.register_ids ?? [];
  const { results } = await env.CORPUS
    .prepare("SELECT register_id FROM registers WHERE register_id IN (SELECT value FROM json_each(?1)) " +
             "OR (?2 <> '' AND register_id LIKE ?2 || '%') ORDER BY register_id")
    .bind(JSON.stringify(ids), parsed.register_prefix ?? "").all();
  const found = new Set((results ?? []).map((r) => r.register_id));
  const { register_ids: _ids, register_prefix: _p, topic_prefix: _tp, any_of: anyOf,
    obligation_ids: _oids, obligation_prefix: _op, ...shown } = parsed;
  // any_of (batch 8): the ids are alternatives, not a fallback order -- a bare Fannie chapter
  // "A4-1" is both the Selling Guide's and the Servicing Guide's chapter, so both are candidates.
  const primary = anyOf ? undefined : ids.find((id) => found.has(id));
  const own = anyOf ? ids.filter((id) => found.has(id)) : primary ? [primary] : [...found].sort();
  const aliasRows = await fetchAliasRows(env, own);
  const topics = parsed.topic_prefix ? await chapterTopics(env, parsed.topic_prefix) : [];
  const result = resolve(own.map((register_id) => ({ register_id })), [], aliasRows);
  if (result.error === "not_found" && topics.length) {
    delete result.error;
    result.note = `${parsed.canonical} has no chapter register of its own here; its topics ` +
      "are listed in `topics` -- use get_reg or find_in_section on the topic that fits.";
  } else if (result.error === "not_found") {
    result.hint = `Read as ${parsed.canonical}, but that section is not in this corpus. Use ` +
      "search_regs for its topic; do not quote it from memory.";
  } else if (primary && primary !== ids[0]) {
    result.note = `${parsed.canonical} has no register of its own here; ${primary} (the ` +
      "chapter) holds it -- use find_in_section or get_reg to reach the topic.";
  } else if (topics.length) {
    result.note = `${primary} is the chapter's own register (often only its introduction); ` +
      "the chapter's rules are in its topic registers, listed in `topics`.";
  }
  const section = result.register_id && (parsed.obligation_ids?.length || parsed.obligation_prefix)
    ? await structuredSection(env, parsed) : {};
  return { ...result, ...section, ...(topics.length ? { topics } : {}), parsed: shown };
}

// mf-2a: a cite that names a SECTION inside a chapter register (MAP Guide "3.2.1" lives in
// hud-4430g-ch03) resolves to the obligation that holds it: `obligation_ids` are tried in
// order (the cited section, then its parent); a deeper pinpoint ("9.6.8.K") is reported as
// inside the section found. `obligation_prefix` (a level-2 cite) also lists its level-3
// sections, since the level-2 text itself may be only a heading.
export async function structuredSection(env, parsed) {
  const ids = parsed.obligation_ids ?? [];
  let rows = [], subs = [];
  try {
    ({ results: rows } = await env.CORPUS
      .prepare("SELECT obligation_id, section FROM obligations WHERE obligation_id IN (SELECT value FROM json_each(?1))")
      .bind(JSON.stringify(ids)).all());
    if (parsed.obligation_prefix) {
      ({ results: subs } = await env.CORPUS
        .prepare("SELECT obligation_id, section FROM obligations WHERE obligation_id LIKE ?1 || '%' ORDER BY rowid LIMIT ?2")
        .bind(parsed.obligation_prefix, LOOKUP_LIST_MAX).all());
    }
  } catch { return {}; }
  const have = new Map((rows ?? []).map((r) => [r.obligation_id, r.section]));
  const hit = ids.find((id) => have.has(id));
  const out = {};
  if (hit) {
    out.obligation_id = hit;
    out.section = have.get(hit);
    const num = String(parsed.canonical).split(" ").pop();
    // ids are tried from the cited depth (at most 4) down; "A.2.1.1.10" has 4 levels after "A."
    const exact = hit === ids[0] && num.replace(/^A\./, "").split(".").length <= 4 && !/[A-Z]$/.test(num);
    out.note = exact
      ? `${parsed.canonical} is obligation ${hit} (get_obligation for its text); register_id is the whole chapter.`
      : `${parsed.canonical} has no obligation of its own: it is inside ${hit} (${have.get(hit)}). Read it ` +
        "with get_obligation or find_in_section on that obligation.";
  }
  if (subs?.length) {
    out.sections = subs.map((r) => ({ obligation_id: r.obligation_id, section: r.section }));
    if (!hit) out.note = `${parsed.canonical} is split into the sections listed in \`sections\`; read the one that fits.`;
  }
  if (!hit && !subs?.length && ids.length) {
    out.note = `${parsed.canonical}: the chapter is in this corpus but no section with that number is; ` +
      "use get_reg on register_id to see its sections. Do not quote it from memory.";
  }
  return out;
}

// A chapter's topic registers in topic order: [{ register_id, topic, title }].
export async function chapterTopics(env, prefix) {
  const { results } = await env.CORPUS
    .prepare("SELECT register_id, authority FROM registers WHERE register_id LIKE ?1 || '%' " +
             "AND register_id NOT LIKE '%superseded%'")
    .bind(prefix).all();
  return (results ?? [])
    .map((r) => {
      const m = r.register_id.slice(prefix.length).match(/^(\d+)/);
      return m ? { register_id: r.register_id, topic: Number(m[1]), title: shortTitle(r.authority) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.topic - b.topic || a.register_id.localeCompare(b.register_id));
}

// HANDBOOK OVERVIEW (Round 4, stress2 Q13 / P1-7): a whole handbook named without a section
// ("hud 4000.1", lookup_citation "HUD Handbook 4000.1") gets a map of its parts from the
// registers this corpus holds, so the model can pick a section instead of guessing.
// FHA 4000.1: Parts (I..V) and their lettered subparts, read from the outline path in
// registers.authority ("4000.1, II. ORIGINATION ... > A. Title II ... > ..."). Chapter-based
// handbooks (M26-7, M26-4, HB-1-3555, MBS Guide): chapters from the register ids, titled by
// the chapter register or a topic's "Chapter N (Name)". null when nothing is held.
const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8 };

export async function handbookOverview(env, hb) {
  const { results } = await env.CORPUS
    .prepare("SELECT register_id, authority FROM registers WHERE register_id LIKE ?1 || '%' " +
             "AND register_id NOT LIKE '%superseded%'")
    .bind(hb.prefix).all();
  const regs = results ?? [];
  if (!regs.length) return null;
  const base = { name: hb.canonical, family: hb.family, registers: regs.length };
  if (hb.family === "sba") {
    // SOP edition overview: parts A-C by chapter, appendices, and the edition's own currency
    // (every SOP 8 register carries "superseded for applications received on or after
    // 2026-10-01"), so a bare "SOP 50 10 8" in a P&P is flagged as the superseded edition.
    const chapters = new Map(), appendices = new Set();
    for (const r of regs) {
      const rest = r.register_id.slice(hb.prefix.length);
      const ch = rest.match(/^([abc])-ch(\d+)/);
      const app = rest.match(/^app(\d+)/);
      if (ch) {
        const key = `${ch[1].toUpperCase()}.Ch${Number(ch[2])}`;
        chapters.set(key, (chapters.get(key) ?? 0) + 1);
      } else if (app) appendices.add(Number(app[1]));
    }
    let currency = null;
    try {
      const row = await env.CORPUS
        .prepare(`SELECT ${CURRENCY_COLUMNS} FROM registers r ${currencyJoin("r.register_id")} ` +
                 "WHERE r.register_id LIKE ?1 || '%' AND c.kind IS NOT NULL LIMIT 1")
        .bind(hb.prefix).first();
      currency = currencyOf(row);
    } catch { /* overview without currency */ }
    return {
      ...base,
      ...(currency ? { currency } : {}),
      chapters: [...chapters.entries()].sort().map(([chapter, sections]) => ({ chapter, sections })),
      appendices: [...appendices].sort((a, b) => a - b),
      how: `Cite a section as "${hb.canonical.replace(/^SBA /, "")} A.Ch5.B" (lookup_citation), or ` +
        "search_regs with family \"sba\" and the topic.",
    };
  }
  if (hb.prefix === "hud-4000-1-") {
    const parts = new Map();
    for (const r of regs) {
      const a = String(r.authority ?? "");
      const m = a.match(/4000\.1,\s*([IVX]+)\.\s*(?:>\s*)?([^>—]+?)\s*(?:>\s*([A-Z])\.\s+([^>—]+?)\s*(?:>|—|$)|—|$)/);
      const code = m ? null : a.match(/4000\.1,?\s*(?:Part\s+)?([IVX]+)(?:\.([A-Z]))?\b/);
      const part = m?.[1] ?? code?.[1];
      if (!part || !ROMAN[part]) continue;
      if (!parts.has(part)) parts.set(part, { part, title: null, sections: 0, subparts: new Map() });
      const p = parts.get(part);
      p.sections++;
      if (m?.[2] && !p.title) p.title = m[2].trim();
      const sub = m?.[3] ?? code?.[2];
      if (sub) {
        const code2 = `${part}.${sub}`;
        if (!p.subparts.has(code2)) p.subparts.set(code2, { code: code2, title: null, sections: 0 });
        const sp = p.subparts.get(code2);
        sp.sections++;
        if (m?.[4] && !sp.title) sp.title = m[4].replace(/\s*\(\d{1,2}\/\d{1,2}\/\d{4}\)\s*$/, "").trim();
      }
    }
    return {
      ...base,
      parts: [...parts.values()].sort((a, b) => ROMAN[a.part] - ROMAN[b.part]).map((p) => ({
        part: p.part, ...(p.title ? { title: p.title } : {}), sections: p.sections,
        subparts: [...p.subparts.values()].sort((a, b) => a.code.localeCompare(b.code))
          .map((sp) => ({ code: sp.code, ...(sp.title ? { title: sp.title } : {}), sections: sp.sections })),
      })),
      how: "Cite a section as \"4000.1 II.A.4.c\" (lookup_citation), or search_regs with family " +
        "\"hud\" and the topic.",
    };
  }
  const chapters = new Map(), appendices = [], other = [];
  for (const r of regs) {
    const rest = r.register_id.slice(hb.prefix.length);
    // mf-2b: the MAP Guide's appendix registers (hud-4430g-app05) and back matter
    // (hud-4430g-glossary, hud-4430g-acronyms) are listed beside its chapters
    const app = hb.family === "hudmf" && rest.match(/^app(\d+)$/);
    if (app) {
      const t = String(r.authority ?? "").match(/Appendix\s+\d+\s*\(([^)]+)\)/);
      appendices.push({ appendix: Number(app[1]), ...(t ? { title: t[1].trim() } : {}), register_id: r.register_id });
      continue;
    }
    if (hb.family === "hudmf" && /^(glossary|acronyms)$/.test(rest)) {
      const t = String(r.authority ?? "").split(", ").pop();
      other.push({ title: t, register_id: r.register_id });
      continue;
    }
    const m = rest.match(/^(?:ch)?(\d+)(?:-|$)/);
    if (!m) continue;
    const ch = Number(m[1]);
    if (!chapters.has(ch)) chapters.set(ch, { chapter: ch, title: null, registers: 0, register_id: null });
    const c = chapters.get(ch);
    c.registers++;
    const own = r.register_id === `${hb.prefix}ch${String(ch).padStart(2, "0")}` ||
      r.register_id === `${hb.prefix}${ch}`;
    if (own) c.register_id = r.register_id;
    const named = String(r.authority ?? "").match(new RegExp(String.raw`Chapter\s+${ch}\b\s*(?:\(([^)]+)\)|—\s*([^—]+?)\s*$)`));
    const title = named ? (named[1] ?? named[2]) : null;
    if (title && (!c.title || own)) c.title = title.trim();
  }
  return {
    ...base,
    chapters: [...chapters.values()].sort((a, b) => a.chapter - b.chapter).map((c) => ({
      chapter: c.chapter, ...(c.title ? { title: c.title } : {}),
      ...(c.register_id ? { register_id: c.register_id } : {}), registers: c.registers,
    })),
    ...(appendices.length ? { appendices: appendices.sort((a, b) => a.appendix - b.appendix) } : {}),
    ...(other.length ? { back_matter: other.sort((a, b) => a.register_id.localeCompare(b.register_id)) } : {}),
    how: `Cite a chapter or section (lookup_citation), or search_regs with family "${hb.family}" ` +
      "and the topic.",
  };
}

// `aliasRows`: the register's same-text group (src/aliases.js) -> canonical_id (only when
// this register is a copy) and also_at (the group's other members). `versions`
// (src/versions.js): a dual-version section's obligations carry their version labels.
// `oc` (src/currency.js fetchObligationCurrency): an obligation with its own currency (a
// Freddie Mac pending version) lists it, short form, beside its size.
export function buildManifest(reg, obligations, aliasRows = [], versions = new Map(), oc = new Map()) {
  const [g] = collapseCandidates([reg.register_id], aliasRows);
  return {
    register_id: reg.register_id,
    ...(g.canonical_id !== reg.register_id ? { canonical_id: g.canonical_id } : {}),
    ...(g.also_at.length ? { also_at: g.also_at } : {}),
    authority: reg.authority ?? "",
    canonical_citation: canonicalCitation({ register_id: reg.register_id, register_title: reg.authority }),
    effective_date: reg.effective_date ?? null,
    status: reg.status ?? "unknown",
    superseded_by: reg.superseded_by ?? null,
    coverage_tier: reg.coverage_tier ?? "unknown",
    currency: currencyOf(reg),
    obligations: obligations.map((o) => ({
      obligation_id: o.obligation_id,
      section: o.section ?? "",
      canonical_citation: canonicalCitation({
        register_id: reg.register_id, register_title: reg.authority, section: o.section,
      }),
      chars_total: o.chars_total ?? 0,
      will_truncate: (o.chars_total ?? 0) > MAX_CHARS,
      ...versionBrief(o.obligation_id, versions),
      ...(oc.has(o.obligation_id) ? { currency: currencyOf(withObligationCurrency({
        obligation_id: o.obligation_id }, oc)) } : {}),
    })),
  };
}

// get_obligation not_found on an exact register_id: that register's obligation ids (batch 17).
export async function registerObligations(env, id) {
  try {
    const { results } = await env.CORPUS
      .prepare("SELECT obligation_id, section FROM obligations WHERE register_id = ?1 ORDER BY rowid")
      .bind(String(id)).all();
    if (!results?.length) return {};
    return {
      register_id: String(id),
      obligations: results.slice(0, LOOKUP_LIST_MAX).map((r) => ({ obligation_id: r.obligation_id, section: r.section })),
      ...(results.length > LOOKUP_LIST_MAX ? { obligations_total: results.length } : {}),
      hint: `${id} is a register_id, not an obligation_id. Call get_obligation with one of ` +
        "`obligations` (or get_reg for the register).",
    };
  } catch {
    return {};
  }
}
