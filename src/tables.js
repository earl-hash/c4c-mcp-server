// FLATTENED TABLE RECONSTRUCTION (batch 5, 2026-09-27; stress2 C4C-03 / stress4 S4-08).
//
// The Fannie and Freddie guides are stored as one unbroken line: a table's header, row labels
// and cells run together ("LTV Range Transaction Type 80.01 – 85.00% 85.01-90.00% ... Fixed-rate,
// term ≤ 20 years 6% 12% 16%* + MI LLPA 18%* + MI LLPA 25%^ 35%^ ..."), so a model reading the
// B7-1-02 mortgage insurance grid could not tell which percentage belongs to which LTV band.
//
// reconstructGrid() rebuilds the rows of a NUMERIC GRID -- the one table shape whose column
// structure can be inferred from the text alone: a header of N range labels ("80.01 – 85.00%"),
// then rows of a text label followed by figure cells ("6%", "16%* + MI LLPA", "Not applicable").
// It is best-effort and ADDITIVE: the passage's `verbatim` string is never changed, every cell
// is an exact substring of it, and `table_confidence` says how the cells were placed:
//   high    every row has exactly N cells;
//   medium  some row has 2N cells (two values per column, joined " / "), or N cells plus a
//           second line placed in the columns whose first value carries the other marker
//           ("16%*" minimum coverage + "25%^" standard coverage);
//   low     a row's cells were placed by marker pairing only, or could not be placed (then
//           the row is the label followed by its cells in text order).
// A prose table (rows of sentences or bullet lists: B3-3.3-03 Option 1 / Option 2, B8-5-05
// agents vs permitted exceptions) has no inferable columns and gets no table_rows.
//
// Page-break reprints of the table's caption ("Mortgage Insurance Coverage Requirements"
// printed again mid-table) are dropped from the reconstruction only.

export const TABLE_NOTE =
  "table_rows is a best-effort reconstruction of a table whose layout was lost in the source " +
  "text; the passage's `verbatim` string is authoritative. Check every cell you rely on " +
  "against it. Two values in one cell are joined with \" / \".";

// A column-header range label: "80.01 – 85.00%" (three tokens, merged) or "85.01-90.00%".
const RANGE = /^[<>≤≥]?\$?\d[\d.,]*%?\s*[–—-]\s*\$?\d[\d.,]*%?$/;
// A grid cell: a percentage or money figure, with its footnote markers.
const CELL = /^[([]?\$?\d[\d.,]*%[*^†‡]*[)\]]?[,;.]?$|^\$\d[\d.,]*(?:\s?(?:million|billion))?[*^]*[,;.]?$/i;
const NOT_APPLICABLE = /^(?:Not applicable|N\/A|NA|None)$/;

function tokens(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ s: m[0], start: m.index, end: m.index + m[0].length });
  // Merge "80.01 – 85.00%" into one token.
  const merged = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    const dash = out[i + 1];
    const b = out[i + 2];
    if (b && /^[–—-]$/.test(dash.s) && /\d/.test(a.s) && /\d/.test(b.s) &&
        RANGE.test(`${a.s} ${dash.s} ${b.s}`)) {
      merged.push({ s: `${a.s} ${dash.s} ${b.s}`, start: a.start, end: b.end, raw: true });
      i += 2;
    } else merged.push(a);
  }
  return merged;
}

function markerOf(s) {
  const m = String(s).match(/[*^†‡]+/);
  return m ? m[0] : "";
}

// Place one row's cells into n columns. Returns { cells, confidence } (cells.length === n),
// or null when they cannot be placed.
function placeRow(cells, n) {
  const k = cells.length;
  if (k === n) return { cells: cells.map((c) => c.s), confidence: "high" };
  if (k === 2 * n) {
    return { cells: cells.slice(0, n).map((c, i) => `${c.s} / ${cells[n + i].s}`), confidence: "medium" };
  }
  if (k > n && k < 2 * n) {
    const line1 = cells.slice(0, n);
    const line2 = cells.slice(n);
    const m2 = markerOf(line2[0].s);
    if (m2 && line2.every((c) => markerOf(c.s) === m2)) {
      // The second line fills the columns whose first value carries a DIFFERENT marker.
      const slots = line1.map((c, i) => (markerOf(c.s) && markerOf(c.s) !== m2 ? i : -1)).filter((i) => i >= 0);
      if (slots.length === line2.length) {
        const out = line1.map((c) => c.s);
        slots.forEach((col, j) => { out[col] = `${out[col]} / ${line2[j].s}`; });
        return { cells: out, confidence: "medium" };
      }
    }
  }
  // Marker pairing: two marker kinds in equal numbers, paired in order from the first column.
  const kinds = [...new Set(cells.map((c) => markerOf(c.s)))];
  if (kinds.length === 2 && kinds.every(Boolean)) {
    const a = cells.filter((c) => markerOf(c.s) === kinds[0]);
    const b = cells.filter((c) => markerOf(c.s) === kinds[1]);
    if (a.length === b.length && a.length <= n) {
      const out = Array.from({ length: n }, (_, i) => (i < a.length ? `${a[i].s} / ${b[i].s}` : ""));
      return { cells: out, confidence: "low" };
    }
  }
  return null;
}

const RANK = { high: 3, medium: 2, low: 1 };

// { table_rows, table_confidence, table_note } for a flattened numeric grid, or null.
// `text` is the passage (an exact slice of the obligation text).
export function reconstructGrid(text) {
  const t = String(text ?? "");
  const toks = tokens(t);
  // Header: the first run of >= 2 consecutive range labels.
  let h = -1;
  let n = 0;
  for (let i = 0; i < toks.length; i++) {
    let j = i;
    while (j < toks.length && RANGE.test(toks[j].s)) j++;
    if (j - i >= 2) { h = i; n = j - i; break; }
  }
  if (h === -1) return null;
  const labelsFrom = (() => {
    // The header's own label words: back to the previous sentence end.
    let i = h - 1;
    while (i >= 0 && !/[.:;]$/.test(toks[i].s) && h - i <= 12) i--;
    return i + 1;
  })();
  // Page-break reprints of the caption, dropped from the reconstruction only: the longest
  // leading run (>= 3 words) of the header's label words that occurs again after the header.
  const skip = new Set();
  let caption = "";
  const leadToks = toks.slice(labelsFrom, h);
  for (let k = leadToks.length; k >= 3 && !caption; k--) {
    const phrase = leadToks.slice(0, k).map((x) => x.s).join(" ");
    if (phrase.length < 20) break;
    let at = t.indexOf(phrase, toks[h].start);
    if (at === -1) continue;
    caption = phrase;
    while (at !== -1) {
      for (const x of toks) if (x.start >= at && x.end <= at + phrase.length) skip.add(x);
      at = t.indexOf(phrase, at + phrase.length);
    }
  }
  let lead = t.slice(toks[labelsFrom].start, toks[h - 1]?.end ?? toks[h].start).trim();
  if (caption && lead.startsWith(caption)) lead = lead.slice(caption.length).trim();
  const header = [lead || "", ...toks.slice(h, h + n).map((x) => x.s)];

  // Body: label runs and cell runs. "+ MI LLPA" after a cell belongs to it.
  const rows = [];
  let label = [];
  let cells = [];
  const flush = () => {
    if (label.length && cells.length) rows.push({ label: label.map((x) => x.s).join(" "), cells });
    else if (!label.length && cells.length && rows.length) rows[rows.length - 1].cells.push(...cells);
    label = [];
    cells = [];
  };
  const body = toks.slice(h + n).filter((x) => !skip.has(x) && !RANGE.test(x.s));
  for (let i = 0; i < body.length; i++) {
    const x = body[i];
    const na = NOT_APPLICABLE.test(x.s) ? x : (x.s === "Not" && body[i + 1]?.s === "applicable"
      ? { s: "Not applicable", start: x.start, end: body[i + 1].end } : null);
    if (na && label.length) {
      if (na.s === "Not applicable") i++;
      cells.push({ s: na.s });
      continue;
    }
    if (CELL.test(x.s)) {
      let s = x.s.replace(/[,;.]$/, "");
      // "+ MI LLPA": a "+" and the words up to the next cell join the cell.
      while (body[i + 1]?.s === "+") {
        let j = i + 2;
        const extra = [];
        while (j < body.length && extra.length < 4 && /^[A-Z]{2,}$/.test(body[j].s)) {
          extra.push(body[j].s);
          j++;
        }
        if (!extra.length) break;
        s = `${s} + ${extra.join(" ")}`;
        i = j - 1;
      }
      cells.push({ s });
      continue;
    }
    if (cells.length) flush();
    label.push(x);
  }
  flush();
  if (!rows.length) return null;

  let confidence = "high";
  const out = [header];
  let placedAny = false;
  for (const r of rows) {
    const placed = placeRow(r.cells, n);
    if (placed) {
      placedAny = true;
      out.push([r.label, ...placed.cells]);
      if (RANK[placed.confidence] < RANK[confidence]) confidence = placed.confidence;
    } else {
      out.push([r.label, ...r.cells.map((c) => c.s)]);
      confidence = "low";
    }
  }
  if (!placedAny) return null;
  return {
    table_rows: out,
    table_confidence: confidence,
    table_note: TABLE_NOTE,
    ...(caption ? { table_repeated_header: caption } : {}),
  };
}
