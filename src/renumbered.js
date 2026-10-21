// RENUMBERED SECTIONS (2026-10-13; SBA's "SOP 50 10 8.1 with Technical Updates" posting moved
// B.Ch5.A.6, word for word, to B.Ch5.B.8). The old register leaves the corpus at the next build,
// so lookup_citation on the old cite answered not_found and get_reg on the old id the same --
// to a model, "this section does not exist". The table (data/renumbered-sections.json, bundled
// as renumbered.generated.js) maps each old number to its new one; the site publishes a
// pointer page at /regs/<old_id>/ from the same rows.
//
// The answer is kind "renumbered", resolved to the NEW register (register_id, page_url,
// canonical_citation are the new section's), with renumbered_from the old id. No text is
// given under the old number: the new register's obligations are listed by id only.
import { RENUMBERED } from "./renumbered.generated.js";
import { parseCitation } from "./citation.js";
import { pageUrl } from "./sourceurl.js";
import { LOOKUP_LIST_MAX } from "./inline.js";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];

export function monthName(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym ?? ""));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(ym ?? "");
}

// "SOP 50 10 8.1 B.Ch5.A.6" / "SOP 50 10 8.1 B.Ch5.B.8" -> "B.Ch5.A.6" / "B.Ch5.B.8": the words
// both cites share are dropped, so the sentence names what changed.
export function shortPair(a, b) {
  const x = String(a).split(" "), y = String(b).split(" ");
  let i = 0;
  while (i < x.length - 1 && i < y.length - 1 && x[i] === y[i]) i++;
  return [x.slice(i).join(" "), y.slice(i).join(" ")];
}

// The site banner's sentence (src/pages/regs/[renumbered].astro says the same).
export function renumberedHeadline(row) {
  const [from, to] = shortPair(row.old_citation, row.new_citation);
  const when = `In the "${row.source_document}" posting (${monthName(row.date)}), ${from} became ${to}.`;
  return row.text_changed
    ? `${row.regulator} renumbered and revised this section. ${when} Its text changed: read the new section.`
    : `${row.regulator} renumbered this section. ${when} The text did not change.`;
}

// number_reused: the regulator gave the old number to another section (Freddie 4703.7 ->
// 4703.4, with 4703.7 now "Mortgagee clause"), so the old id is that current section's
// register. Such a row never answers for an id; a cite to the number gets only the note.
const BY_ID = new Map(RENUMBERED.filter((r) => !r.number_reused).map((r) => [r.old_id, r]));

export function renumberedById(id, rows = RENUMBERED) {
  const s = String(id ?? "");
  return rows === RENUMBERED ? BY_ID.get(s) ?? null
    : rows.find((r) => r.old_id === s && !r.number_reused) ?? null;
}

// An old obligation id: the old register's own id or one of its sections ("<old_id>-1",
// "<old_id>::..."). Only asked once the corpus has no such obligation.
export function renumberedByObligation(id, rows = RENUMBERED) {
  const s = String(id ?? "");
  return rows.find((r) => !r.number_reused && (s === r.old_id || s.startsWith(`${r.old_id}::`) ||
    (s.startsWith(`${r.old_id}-`) && /^\d+$/.test(s.slice(r.old_id.length + 1))))) ?? null;
}

// The row a parsed citation names: a structured cite whose preferred register is the old id
// (an SOP cite without an edition reads as 8.1 first), or a cite that parses to the old
// citation's canonical form.
export function renumberedByCitation(parsed, rows = RENUMBERED) {
  if (!parsed) return null;
  return rows.find((r) => {
    if (parsed.register_ids?.[0] === r.old_id) return true;
    const old = parseCitation(r.old_citation);
    return Boolean(old && old.kind === parsed.kind && old.canonical === parsed.canonical);
  }) ?? null;
}

// The new register's obligations, ids and sections only. [] when it has none (or no D1).
async function newObligations(env, id) {
  try {
    const { results } = await env.CORPUS
      .prepare("SELECT obligation_id, section FROM obligations WHERE register_id = ?1 ORDER BY rowid")
      .bind(id).all();
    return (results ?? []).slice(0, LOOKUP_LIST_MAX).map((r) => ({ obligation_id: r.obligation_id, section: r.section }));
  } catch {
    return [];
  }
}

// The tool answer for one row. `extra` carries what the tool adds (parsed, requested id).
export async function renumberedResult(env, row, extra = {}) {
  const obligations = await newObligations(env, row.new_id);
  return {
    kind: "renumbered",
    register_id: row.new_id,
    canonical_citation: row.new_citation,
    page_url: pageUrl(row.new_id),
    renumbered_from: row.old_id,
    renumbered_from_citation: row.old_citation,
    title: row.title,
    renumbered_in: row.source_document,
    renumbered_on: row.date,
    text_changed: row.text_changed,
    ...(obligations.length ? { obligations } : {}),
    ...extra,
    note: `${renumberedHeadline(row)}${row.note ? ` ${row.note}` : ""} No text is given under the ` +
      `old number: the section is register_id ${row.new_id}; quote it and cite it as ${row.new_citation}.`,
  };
}

// lookup_citation: a cite to an old number answers renumbered when the corpus has nothing else
// under it (not_found, or the old register itself while the corpus still holds it). When the
// regulator has given the old number to another section, that resolution stands and the note
// names where the earlier section went.
export async function withRenumbered(env, result, parsed, rows = RENUMBERED) {
  const row = renumberedByCitation(parsed, rows);
  if (!row || !result) return result;
  const unresolved = result.error === "not_found" || (!row.number_reused && (
    result.register_id === row.old_id ||
    (result.error === "ambiguous" && (result.candidates ?? []).includes(row.old_id)) ||
    parsed.register_ids?.[0] === row.old_id));
  if (unresolved) {
    const { register_ids: _ids, register_prefix: _p, topic_prefix: _tp, any_of: _a, ...shown } = parsed;
    return renumberedResult(env, row, { parsed: shown });
  }
  const moved = `Until ${monthName(row.date)}, ${row.old_citation} numbered a different section ` +
    `("${row.title}"), now ${row.new_citation} (${row.new_id}).`;
  return { ...result, note: result.note ? `${result.note} ${moved}` : moved };
}
