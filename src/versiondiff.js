// What Update 18 changes in one FHA section (C4C-11, owner's live test 2026-09-26).
//
// "What does Update 18 change for refinances?" meant hunting HUD's "[Text was deleted in
// this section.]" markers by hand; additions were invisible that way, and a fifth deletion
// (streamline "(4)": the "(d) HUD Employee Mortgage" paragraph) was never found.
//
// compareVersions() splits both texts into units -- sentences, outline items and bullets --
// and lists the units of the in-force text absent from the revision (`deleted`) and the
// units of the revision absent from the in-force text (`added`). Units compare on a KEY:
// whitespace collapsed, typography folded, leading outline markers dropped -- so a
// paragraph that was only re-lettered ("(e) Borrower Additions" -> "(d) ...") is not a
// change. Every listed unit is an exact slice of its own text, with its offset, so it can
// be quoted and checked like any passage. A changed sentence appears once in each list.
//
// It is a MACHINE comparison, not HUD's summary of changes: PDF and web extraction differ
// in table layout, so a table can show as deleted-and-added with the same cells. The
// response says so.

import { normalizeForMatch } from "./normalize.js";

export const MAX_UNITS_LISTED = 40;
export const MAX_UNIT_CHARS = 600;
const DELETION_MARKER = /\[Text was deleted in this section\.?\]/g;

// Cut points in the ORIGINAL text: after sentence punctuation before a capital/bracket, and
// before a line that starts an outline item or bullet, and around deletion markers.
const CUTS = [
  /(?<=[.;:])(?<!(?:^|\s)(?:[a-z]|[ivx]{1,5}|\d{1,3})\.)\s+(?=[A-Z(•"“[])/g,
  /\n(?=[ \t]*(?:\((?:[ivxlcdm]{1,6}|[IVXLCDM]{1,6}|[A-Za-z]|\d{1,3})\)|(?:[ivxlcdm]{1,6}|[a-z]|\d{1,3})\.)\s)/g,
  /\n(?=[ \t]*[•▪■●◦*-]\s)/g,
  // After a heading line (an outline marker and a short title with no closing
  // punctuation), so a heading never fuses with the paragraph under it.
  /(?<=(?:^|\n)[ \t]*(?:\((?:[ivxlcdm]{1,6}|[IVXLCDM]{1,6}|[A-Za-z]|\d{1,3})\)|(?:[ivxlcdm]{1,6}|[a-z]|\d{1,3})\.)[^\n]{0,100}[^.;:,\s])[ \t]*\n(?=[ \t]*[A-Z[])/g,
  /(?=\[Text was deleted in this section)/g,
  /(?<=\[Text was deleted in this section\.?\])/g,
];

export function units(text) {
  const t = String(text ?? "");
  const cuts = new Set([0, t.length]);
  for (const re of CUTS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t)) !== null) {
      cuts.add(m.index + m[0].length);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  const pts = [...cuts].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    let s = pts[i], e = pts[i + 1];
    while (s < e && /\s/.test(t[s])) s++;
    while (e > s && /\s/.test(t[e - 1])) e--;
    if (e > s) out.push({ offset: s, text: t.slice(s, e) });
  }
  return out;
}

const LEAD_MARKERS = /^(?:\s*(?:\((?:[ivxlcdm]{1,6}|[IVXLCDM]{1,6}|[A-Za-z]|\d{1,3})\)\s*|(?:[ivxlcdm]{1,6}|[a-z]|\d{1,3})\.\s+|[•*-]\s+))+/;

export function unitKey(s) {
  return normalizeForMatch(s).replace(DELETION_MARKER, "").replace(LEAD_MARKERS, "")
    .replace(/["']/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

function listed(list) {
  return list.slice(0, MAX_UNITS_LISTED).map((u) => ({
    offset: u.offset,
    verbatim: u.text.length > MAX_UNIT_CHARS ? u.text.slice(0, MAX_UNIT_CHARS) : u.text,
    ...(u.text.length > MAX_UNIT_CHARS ? { cut: true } : {}),
  }));
}

// inForce / revision: { obligation_id, verbatim }.
export function compareVersions(inForce, revision) {
  const a = units(inForce.verbatim), b = units(revision.verbatim);
  const keyed = (us) => us.map((u) => ({ ...u, key: unitKey(u.text) })).filter((u) => u.key.length >= 3);
  const ka = keyed(a), kb = keyed(b);
  const inA = new Set(ka.map((u) => u.key)), inB = new Set(kb.map((u) => u.key));
  const deleted = ka.filter((u) => !inB.has(u.key));
  const added = kb.filter((u) => !inA.has(u.key));
  const markers = (String(revision.verbatim).match(DELETION_MARKER) ?? []).length;
  return {
    in_force_obligation_id: inForce.obligation_id,
    update_18_obligation_id: revision.obligation_id,
    deleted_count: deleted.length,
    added_count: added.length,
    deletion_markers: markers,
    // Offsets index the in-force text for `deleted`, the Update 18 text for `added`.
    deleted: listed(deleted),
    added: listed(added),
    ...(deleted.length > MAX_UNITS_LISTED || added.length > MAX_UNITS_LISTED ? { truncated: true } : {}),
    note: "Machine comparison of the two texts, sentence by sentence (re-lettered items are " +
      "not counted as changes). Not HUD's own summary: a table extracted differently can " +
      "show as deleted and added with the same cells. Quote the `verbatim` units and say " +
      "which version each comes from; `deletion_markers` counts HUD's \"[Text was deleted in " +
      "this section.]\" notes in the Update 18 text.",
  };
}
