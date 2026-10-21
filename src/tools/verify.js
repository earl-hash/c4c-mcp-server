import { z } from "zod";
import { normalizeForMatch } from "../normalize.js";
import { buildOrQuery } from "./search.js";
import { IN_FORCE, UPDATE_18, VERSION_SUFFIX } from "../versions.js";
import { resolveObligationAlias } from "../aliases.js";
import { withMatchedSourceUrl } from "../sourceurl.js";

// verify_quote -- spec 5.x, Task 8 as amended by the controller 2026-09-25.
//
// Four outcomes, strongest first:
//   exact      -- the candidate is a contiguous substring of the snapshot
//   normalized -- contiguous after normalize_for_match() typography folding
//   composed   -- every candidate word lies in a source segment of >= MIN_SEG
//                 consecutive words, segments taken IN SOURCE ORDER, matched on a
//                 hyphen-insensitive projection (PDF joins: "Mac-approved" vs our
//                 "Macapproved"). Short skipped source text is DISCLOSED as
//                 `omissions` because a deleted "not" is structurally identical to
//                 legitimate elision and cannot be classified away.
//                 A quote with MARKED elisions ("…", "...", ". . .") is also `composed`
//                 (never exact), with `elisions: n`: each piece between markers must be
//                 contiguous, in order, tightest placement; the skipped source text is
//                 disclosed the same way. Pieces under 3 words must sit within 10 words of
//                 a neighbor. Quote marks ' and " are equivalent in every stage but exact.
//   not_found  -- anything else, with `coverage` and `unsupported` spans so a
//                 near-miss is diagnosable.
//
// The earlier window-coverage (>= 0.85 of 10-word windows) design is kept only as
// the `chunkCoverage` diagnostic: measured on the real corpus it let an altered
// figure mid-quote classify as composed, and cost seconds per long quote.

export const MIN_SEG = 5;          // words per source segment for `composed`
export const MAX_WORDS = 5000;     // candidate cap (refusal, not a fifth outcome)
const MAX_OCCURRENCES = 200;       // seed occurrences examined per segment
const OMISSION_MAX_WORDS = 12;     // longer skips are structural: counted, not listed
const MAX_OMISSIONS = 10;
const MAX_UNSUPPORTED = 5;
const UNSUPPORTED_MAX_WORDS = 20;

// Diagnostic only. Fraction of `size`-word windows from `candidate` present in `source`.
export function chunkCoverage(candidate, source, size = 10) {
  const words = candidate.split(" ").filter(Boolean);
  if (words.length < size) return source.includes(candidate) ? 1 : 0;
  let hit = 0, total = 0;
  for (let i = 0; i + size <= words.length; i++) {
    total++;
    if (source.includes(words.slice(i, i + size).join(" "))) hit++;
  }
  return total === 0 ? 0 : hit / total;
}

// Hyphen-insensitive projection: drop a "-" (and one following space) only when a
// LETTER follows. The PDF joins this exists for are all letter-led ("Mac-approved",
// "60-day", "third- party"); a hyphen before a digit is kept so "1-4 units" never
// matches "14 units" and a range cannot silently become a different number.
const LOOSE_RE = /-\s?(?=\p{L})/gu;
const loose = (s) => s.replace(LOOSE_RE, "");

// Project normalized candidate words the same way, remembering which original
// words each projected word came from (a "third-" + "party" pair merges into one).
function looseWords(words) {
  const out = [];
  let cur = null;
  for (let j = 0; j < words.length; j++) {
    const w = words[j];
    const next = words[j + 1] ?? "";
    const joins = w.endsWith("-") && /^\p{L}/u.test(next);
    let piece = w.replace(/-(?=\p{L})/gu, "");
    if (joins) piece = piece.slice(0, -1);   // drop the line-break hyphen itself
    if (cur) { cur.text += piece; cur.to = j; }
    else cur = { text: piece, from: j, to: j };
    if (!joins) { if (cur.text) out.push(cur); cur = null; }
  }
  if (cur && cur.text) out.push(cur);
  return out;
}

// Map ascending offsets in loose(ns) back to offsets in ns, in one pass.
function mapLooseOffsets(ns, targets) {
  const out = [];
  const re = new RegExp(LOOSE_RE.source, LOOSE_RE.flags);
  let removed = 0, t = 0, m;
  while (t < targets.length && (m = re.exec(ns)) !== null) {
    while (t < targets.length && targets[t] <= m.index - removed) out.push(targets[t++] + removed);
    removed += m[0].length;
  }
  while (t < targets.length) out.push(targets[t++] + removed);
  return out;
}

const isBoundary = (s, i) => i <= 0 || i >= s.length || s[i] === " " ;

// Greedy in-order segmentation of candidate words `w` against source `s`.
// Word boundaries are enforced on both ends so "6" never matches inside "60".
function segment(w, s) {
  const segs = [];          // {from, to (exclusive word idx), start, end (source offsets)}
  const covered = new Array(w.length).fill(false);
  let i = 0, floor = 0;
  while (i < w.length) {
    let best = 0, bestStart = -1, bestEnd = 0;
    if (i + MIN_SEG <= w.length) {
      const seed = w.slice(i, i + MIN_SEG).join(" ");
      let p = s.indexOf(seed, floor), tries = 0;
      while (p !== -1 && tries < MAX_OCCURRENCES) {
        if (isBoundary(s, p - 1) && isBoundary(s, p + seed.length)) {
          tries++;
          let k = i + MIN_SEG, pos = p + seed.length;
          while (k < w.length && s.startsWith(" " + w[k], pos) &&
                 isBoundary(s, pos + 1 + w[k].length)) {
            pos += 1 + w[k].length; k++;
          }
          if (k - i > best) { best = k - i; bestStart = p; bestEnd = pos; }
          if (k === w.length) break;
        }
        p = s.indexOf(seed, p + 1);
      }
    }
    if (best >= MIN_SEG) {
      segs.push({ from: i, to: i + best, start: bestStart, end: bestEnd });
      for (let k = i; k < i + best; k++) covered[k] = true;
      i += best; floor = bestEnd;
    } else {
      i++;
    }
  }
  return { segs, covered };
}

function unsupportedSpans(lw, covered, ncWords) {
  const spans = [];
  let k = 0;
  while (k < lw.length && spans.length < MAX_UNSUPPORTED) {
    if (covered[k]) { k++; continue; }
    let e = k;
    while (e < lw.length && !covered[e]) e++;
    const words = ncWords.slice(lw[k].from, lw[e - 1].to + 1);
    spans.push(words.slice(0, UNSUPPORTED_MAX_WORDS).join(" "));
    k = e;
  }
  return spans;
}

// `snapshot` is the regulator source. Pass `normalized: true` when it is already
// normalize_for_match() output (snapshots.content_norm), to skip re-normalizing
// multi-MB text; otherwise it is normalized here.
// Punctuation a quoter adds where they cut a sentence: "... financial reserves," when the
// source continues "financial reserves subject to". Found by the end-to-end agent eval
// (2026-09-25): 7 of 7 genuine mid-sentence quotes from the TARGET register came back
// not_found, every one failing only on its final word. Only EDGE punctuation is ignored;
// parentheses are kept because "(a)" can be substantive.
const EDGE_LEAD = /^[\s"'“”‘’,;:.…]+/;
const EDGE_TRAIL = /[\s"'“”‘’,;:.…]+$/;

// Quote-initial capitalization (agent eval 2026-09-25): a quoter starting mid-sentence
// writes "such accounts..." for the source's "Such accounts...", or capitalizes "A PC can
// only..." where the source reads "...and a PC can only". Legal style marks it "[s]uch";
// most writers just change the letter. Only the FIRST letter of the candidate is folded --
// case anywhere else still has to match.
function flipFirstLetter(s) {
  const i = s.search(/\p{L}/u);
  if (i < 0) return s;
  const c = s[i];
  const f = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
  return f === c ? s : s.slice(0, i) + f + s.slice(i + 1);
}

export function classify(args) {
  // One memo per quote x source: the footer-free and compact projections of a multi-MB
  // snapshot are computed once, not once per retry below.
  args = { ...args, memo: args.memo ?? {} };
  const first = classifyText(args);
  if (first.outcome !== "not_found") return first;
  const raw = String(args.candidate ?? "");
  const trimmed = raw.replace(EDGE_LEAD, "").replace(EDGE_TRAIL, "");
  // Retry order: edge punctuation, then first-letter case, then both. Each retry changes
  // only the quote's edges, so none can hide an altered word inside it.
  const variants = [];
  if (trimmed && trimmed !== raw) variants.push([trimmed, { edge_punctuation_ignored: true }]);
  const flipped = flipFirstLetter(raw);
  if (flipped !== raw) variants.push([flipped, { first_letter_case_ignored: true }]);
  const both = flipFirstLetter(trimmed);
  if (trimmed && both !== trimmed && trimmed !== raw) {
    variants.push([both, { edge_punctuation_ignored: true, first_letter_case_ignored: true }]);
  }
  for (const [candidate, flags] of variants) {
    const r = classifyText({ ...args, candidate });
    if (r.outcome !== "not_found") return { ...r, ...flags };
  }
  return first;
}

// Quote-mark equivalence (agent eval 2026-09-25): a quoter nesting source text writes
// 'reasonable time' where the source has "reasonable time". normalizeForMatch already
// folds curly to straight quotes (and must stay byte-identical to the Python normalizer),
// so the ' vs " fold lives here, applied to BOTH sides and only after the exact stage.
// It is 1:1 in length, so offsets into the folded text are offsets into the unfolded one.
const qfold = (s) => s.replace(/"/g, "'");

// Marked elisions: "…", "...", ". . ." (NFKC has already turned "…" into "..."), with or
// without spaces, glued to words or not. Each piece between markers must appear
// contiguously IN ORDER; the result is `composed` with the skipped source disclosed.
const ELLIPSIS_RE = /\s*\.(?:\s?\.){2,}\s*/;
const PIECE_LEAD = /^[\s'",;:]+/;
const PIECE_TRAIL = /[\s'",;:.]+$/;
const MIN_ANCHOR = 3;          // words; a shorter piece ("…the") must sit next to a neighbor
const ELISION_NEAR_WORDS = 10; // max skipped words beside a short piece (so it is always listed)
const ELISION_BUDGET = 5000;   // occurrence probes per candidate

const LN = /[\p{L}\p{N}]/u;
const DIGIT = /\p{N}/u;
// A piece must start and end on a word edge in the source. Beyond letters/digits, a
// digit-joining connector (".", ",", "-", "/") followed by a digit is also a non-edge,
// so "6" never matches inside "96.5" and "26" never inside "26-1880".
function okEdges(s, p, e) {
  const before = s[p - 1] ?? "", after = s[e] ?? "";
  if (LN.test(before) || LN.test(after)) return false;
  if (/[.,\-/]/.test(before) && DIGIT.test(s[p - 2] ?? "")) return false;
  if (/[.,\-/]/.test(after) && DIGIT.test(s[e + 1] ?? "")) return false;
  return true;
}

// Offset limits n words ahead of / behind `at` (approximate word counting on spaces).
function wordsAhead(s, at, n) {
  let p = at;
  for (let i = 0; i <= n; i++) { const q = s.indexOf(" ", p + 1); if (q === -1) return s.length; p = q; }
  return p + 1;
}
function wordsBehind(s, at, n) {
  let p = at;
  for (let i = 0; i <= n; i++) { const q = s.lastIndexOf(" ", p - 1); if (q <= 0) return 0; p = q; }
  return p;
}

// Place pieces (strings on the loose projection) in source order. Anchored pieces
// (>= MIN_ANCHOR words) may be anywhere after the previous piece; a short piece only
// within ELISION_NEAR_WORDS of its neighbor, never anywhere in a multi-MB snapshot. A
// quote with no anchored piece is refused.
//
// Among feasible placements the TIGHTEST is chosen (minimum-window search: a forward
// earliest placement, then pull every piece right against its successor, then restart
// after the window's start). First-feasible is not enough: measured on the corpus, a
// quote eliding just a "not" otherwise matched an earlier copy of its first piece and
// reported the skip as an unlisted long skip -- hiding the "not".
function placePieces(texts, counts, s) {
  const anchored = counts.map((c) => c >= MIN_ANCHOR);
  const first = anchored.indexOf(true);
  if (first === -1) return null;
  const last = texts.length - 1;
  let budget = ELISION_BUDGET;
  let place = new Array(texts.length);

  const nextAt = (t, from) => {
    let p = s.indexOf(t, from);
    while (p !== -1 && budget-- > 0 && !okEdges(s, p, p + t.length)) p = s.indexOf(t, p + 1);
    return budget > 0 ? p : -1;
  };
  const prevAt = (t, from, min) => {
    let p = s.lastIndexOf(t, from);
    while (p !== -1 && p >= min && budget-- > 0 && !okEdges(s, p, p + t.length)) p = s.lastIndexOf(t, p - 1);
    return p !== -1 && p >= min && budget > 0 ? p : -1;
  };

  // Leading short pieces: nearest occurrence ending before the next piece, within reach.
  const placeLeading = () => {
    for (let k = first - 1; k >= 0; k--) {
      const t = texts[k], next = place[k + 1].start;
      const p = prevAt(t, next - t.length, wordsBehind(s, next, ELISION_NEAR_WORDS));
      if (p === -1) return false;
      place[k] = { start: p, end: p + t.length };
    }
    return true;
  };

  const dfs = (k, floor, fromFirst) => {
    if (k === texts.length) return true;
    const t = texts[k];
    const limit = anchored[k] ? Infinity : wordsAhead(s, floor, ELISION_NEAR_WORDS);
    let p = nextAt(t, k === first ? fromFirst : floor), tries = 0;
    while (p !== -1 && p <= limit && tries++ < MAX_OCCURRENCES) {
      place[k] = { start: p, end: p + t.length };
      if ((k !== first || placeLeading()) && dfs(k + 1, p + t.length, 0)) return true;
      if (k === first) return false;   // the outer loop advances the first piece
      p = nextAt(t, p + 1);
    }
    return false;
  };

  // Pull pieces right against their successors (keeps order, only shrinks gaps).
  const tighten = () => {
    for (let k = last - 1; k >= first; k--) {
      const t = texts[k];
      const p = prevAt(t, place[k + 1].start - t.length, place[k].start);
      if (p === -1 || p === place[k].start) continue;
      if (!anchored[k] && k > 0 && p > wordsAhead(s, place[k - 1].end, ELISION_NEAR_WORDS)) continue;
      place[k] = { start: p, end: p + t.length };
    }
    if (first > 0) placeLeading();
  };

  let best = null, bestSpan = Infinity, from = 0;
  for (let round = 0; round < 50 && budget > 0; round++) {
    const firstAt = nextAt(texts[first], from);
    if (firstAt === -1) break;
    place = new Array(texts.length);
    if (!dfs(first, 0, firstAt)) { from = firstAt + 1; continue; }
    tighten();
    const span = place[last].end - place[0].start;
    if (span < bestSpan) { bestSpan = span; best = place.map((x) => ({ ...x })); }
    if (span <= texts.join(" ").length) break; // pieces abut: cannot get tighter
    from = place[first].start + 1;
  }
  return best;
}

// Skipped source text between consecutive placed spans (offsets in loose(ns)). Short
// skips are listed verbatim from the ORIGINAL source (a dropped "not" must be visible);
// long ones are structural and counted.
function disclose(nsOrig, nsFolded, ls, spans) {
  const shortGaps = [];
  let longSkips = 0;
  for (let g = 1; g < spans.length; g++) {
    const gap = ls.slice(spans[g - 1].end, spans[g].start).trim();
    if (!gap) continue;
    if (gap.split(" ").length <= OMISSION_MAX_WORDS) shortGaps.push([spans[g - 1].end, spans[g].start]);
    else longSkips++;
  }
  const listed = shortGaps.slice(0, MAX_OMISSIONS);
  const offs = mapLooseOffsets(nsFolded, listed.flat());
  return {
    omissions: listed.map((_, n) => nsOrig.slice(offs[2 * n], offs[2 * n + 1]).trim()),
    ...(shortGaps.length > MAX_OMISSIONS ? { omissions_truncated: true } : {}),
    long_skips: longSkips,
  };
}

// ---- List markers the quoter added (batch 5, stress4 Q16 / stress5 I17) ----
// A model that copies a run-in list ("... as long as: the Veteran is not placed ..., the loan
// ... may not exceed the NOV, and ...") often lays it out as a list, adding "- ", "1. " or
// "(a) " at each line start. Those markers are not the regulator's words, so the quote came
// back `composed` (or not_found) although every word was copied verbatim. When the quote as
// written is not exact/normalized, it is checked again with line-leading list markers
// removed; a contiguous match then is `normalized` with `list_markers_ignored: true`. The
// retry only ever removes characters from the QUOTE, and still requires the remaining text
// to be contiguous in the source, so it cannot pass words the source lacks.
const LIST_MARKER_LINE =
  /(^|\n)[ \t]*(?:[-*–—•▪■●◦‣⁃·]|\(?(?:\d{1,3}|[a-zA-Z]|[ivxlcdm]{1,6})[.)])[ \t]+/g;
export function stripListMarkers(text) {
  return String(text ?? "").replace(LIST_MARKER_LINE, "$1");
}
// Batch 11 (stress6 C21 N13/N24): list glyphs the normalizer keeps ("⚬" U+26AC, the
// Letter's "o" sub-bullet, "*", a spaced "-", PDF Wingdings bullets) broke a quote that left
// them out, or wrote them differently ("-" for the source's "o"), into `composed`. The last
// retry removes a STANDALONE glyph token (whitespace on both sides) from BOTH sides and
// requires the rest to be contiguous; a match is normalized with list_markers_ignored. Only
// glyph tokens are removed, never a word, so no word the source lacks can pass.
const GLYPH_TOKEN = /(^| )[\u26ac\u2043\u2023\uf0a7\uf0b7\uf0d8\uf076o*-](?= |$)/gu;
export function stripGlyphTokens(norm) {
  let prev, out = String(norm ?? "");
  do { prev = out; out = out.replace(GLYPH_TOKEN, "$1"); } while (out !== prev);
  return out.replace(/ {2,}/g, " ").trim();
}
let glyphSrc = null, glyphOut = "";   // the last snapshot's glyph-free form
function classifyListAware(text, snapshot) {
  const r = classify({ candidate: text, snapshot, normalized: true });
  if (r.outcome === "exact" || r.outcome === "normalized") return r;
  const stripped = stripListMarkers(text);
  if (stripped !== text) {
    const s = classify({ candidate: stripped, snapshot, normalized: true });
    if (s.outcome === "exact" || s.outcome === "normalized") {
      return { ...s, outcome: "normalized", list_markers_ignored: true };
    }
  }
  const qg = stripGlyphTokens(normalizeForMatch(stripped));
  if (!qg || qg.split(" ").length < 4) return r;
  if (glyphSrc !== snapshot) { glyphSrc = snapshot; glyphOut = stripGlyphTokens(snapshot); }
  if (glyphOut.includes(qg)) return { outcome: "normalized", coverage: 1, list_markers_ignored: true };
  return r;
}

// ---- Page furniture and extraction spacing (Round 4) ----
// Stress2 P1-8: a sentence copied from get_obligation came back `composed`, its one omission
// "Published May 6, 2026 444" -- the Selling Guide's running footer, which the served text
// no longer carries but the snapshot the quote is checked against still does. The same
// furniture is removed from the source (and the quote) before the normalized comparison.
const FURNITURE_MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const FURNITURE_RE = new RegExp(
  String.raw`\s*\bPublished (?:${FURNITURE_MONTHS}) \d{1,2}, \d{4} (?:\d{1,4}|[IVXLC]{1,7})\b(?=\s|$)|` +
  String.raw`\s*\bContinued on next page\b|` +
  // Batch 5 (stress5 I17): the Freddie Guide's PDF running footer, "Freddie Mac Single-Family
  // Seller/Servicer Guide Chapter 1201 As of 12/17/25 Page 1201-12".
  String.raw`\s*\bFreddie Mac Single-Family Seller/Servicer Guide Chapter \d{3,4} As of \d{1,2}/\d{1,2}/\d{2,4} Page \d{3,4}-\d{1,4}\b`,
  "g",
);
export function stripFurniture(s) {
  return String(s ?? "").replace(FURNITURE_RE, "");
}

// Stress3 VER-01: correct regulator text came back not_found because the STORED text carries
// extraction artifacts -- "holi days" / "Satur days" (Reg X), "mustsubmit" (M26-4), "consumer
// 's" (Reg Z), "general rule ," (eCFR). The quote and source are compared on a projection
// with every whitespace run removed; a match there is `normalized` with `spacing_ignored:
// true`. The match must still start and end on word edges in the source (okEdges), and letters,
// digits, punctuation and case must agree exactly -- only spacing is forgiven.
const COMPACT_MIN = 12;       // characters: shorter quotes carry too little to compare this way
const COMPACT_TRIES = 50;

export function spacingMatch(nc, ns, memo = {}) {
  const c = String(nc ?? "").replace(/\s+/g, "");
  if (c.length < COMPACT_MIN) return false;
  const src = String(ns ?? "");
  // Native replace/indexOf over the multi-MB source; offsets are mapped back to `src` only
  // for an actual hit (a forward scan that resumes where the previous one stopped). `memo`
  // keeps the compact source across classify()'s retries of one quote.
  if (memo.src !== src) { memo.src = src; memo.cs = src.replace(/\s+/g, ""); }
  const cs = memo.cs;
  let at = cs.indexOf(c);
  if (at === -1) return false;
  let i = 0;   // position in src
  let k = 0;   // non-space characters seen before i
  const toSrc = (target) => {
    if (target < k) { i = 0; k = 0; }   // an overlapping later occurrence: rescan
    while (i < src.length) {
      const ch = src.charCodeAt(i);
      const space = ch === 32 || ch === 10 || ch === 9 || ch === 13 || ch === 12 || ch === 11;
      if (!space) {
        if (k === target) return i;
        k++;
      }
      i++;
    }
    return src.length;
  };
  for (let tries = 0; at !== -1 && tries < COMPACT_TRIES; tries++) {
    const p = toSrc(at);
    const e = toSrc(at + c.length - 1) + 1;
    if (okEdges(src, p, e)) return true;
    at = cs.indexOf(c, at + 1);
  }
  return false;
}

function classifyText({ candidate, verbatim, snapshot, normalized = false, memo = {} }) {
  const raw = String(candidate ?? "");
  if (!raw.trim()) return { outcome: "not_found", coverage: 0, unsupported: [] };

  const source = String(snapshot ?? verbatim ?? "");
  if (source.includes(raw)) return { outcome: "exact", coverage: 1 };

  const nc00 = normalizeForMatch(raw);
  const ns00 = normalized ? source : normalizeForMatch(source);
  if (!nc00) return { outcome: "not_found", coverage: 0, unsupported: [] };
  if (ns00.includes(nc00)) return { outcome: "normalized", coverage: 1 };

  // Page furniture out of both sides; every later stage works on the furniture-free text.
  if (memo.ns00 !== ns00) {
    memo.ns00 = ns00;
    memo.furnished = FURNITURE_RE.test(ns00);
    FURNITURE_RE.lastIndex = 0;
    // (Removing "\s*<footer>" before a space keeps the normalized text normalized.)
    memo.nsOrig = memo.furnished ? stripFurniture(ns00) : ns00;
  }
  const furnished = memo.furnished;
  const nsOrig = memo.nsOrig;
  const nc0 = furnished ? normalizeForMatch(stripFurniture(nc00)) || nc00 : nc00;
  if (furnished && nsOrig.includes(nc0)) return { outcome: "normalized", coverage: 1, furniture_ignored: true };

  // Folding only matters when the candidate carries a quote mark; skip the multi-MB copy otherwise.
  const quoted = /["']/.test(nc0);
  const nc = quoted ? qfold(nc0) : nc0;
  const ns = quoted ? qfold(nsOrig) : nsOrig;
  if (quoted && ns.includes(nc)) {
    return { outcome: "normalized", coverage: 1, ...(furnished ? { furniture_ignored: true } : {}) };
  }
  memo.spacing ??= {};
  if (spacingMatch(nc, ns, quoted ? (memo.spacingQ ??= {}) : memo.spacing)) {
    return { outcome: "normalized", coverage: 1, spacing_ignored: true,
      ...(furnished ? { furniture_ignored: true } : {}) };
  }

  const ls = loose(ns);

  // Interior elisions. Edge-only ellipses are left to classify()'s edge retry.
  const pieces = nc.split(ELLIPSIS_RE)
    .map((p) => p.replace(PIECE_LEAD, "").replace(PIECE_TRAIL, ""))
    .filter(Boolean);
  if (pieces.length >= 2) {
    const lws = pieces.map((p) => looseWords(p.split(" ")));
    const place = placePieces(lws.map((lw) => lw.map((x) => x.text).join(" ")),
                              lws.map((lw) => lw.length), ls);
    if (place) {
      return {
        outcome: "composed", coverage: 1, segments: pieces.length, elisions: pieces.length - 1,
        ...disclose(nsOrig, ns, ls, place),
      };
    }
    // Pieces not individually contiguous: the general composed test below still enforces
    // in-order >= MIN_SEG segments. Try the text as written first (dots can be literal
    // source text: dot leaders, "..." in a form), then with the markers removed.
    const asWritten = composeTest(nc, nsOrig, ns, ls);
    if (asWritten.outcome === "composed") return asWritten;
    const stripped = composeTest(pieces.join(" "), nsOrig, ns, ls);
    const res = stripped.outcome === "composed" || stripped.coverage > asWritten.coverage ? stripped : asWritten;
    // Batch 11 (stress6 C21 N14): every piece between the ellipses is in the source, but not
    // in the order given -- say so instead of a bare "No source support found".
    if (res.outcome === "not_found") {
      const at = lws.map((lw) => ls.indexOf(lw.map((x) => x.text).join(" ")));
      if (at.every((p) => p >= 0) && at.some((p, i) => i > 0 && p < at[i - 1])) {
        return { ...res, segments_out_of_order: true,
          source_order: at.map((p, i) => [p, i + 1]).sort((a, b) => a[0] - b[0]).map((x) => x[1]) };
      }
    }
    return res;
  }
  return composeTest(nc, nsOrig, ns, ls);
}

function composeTest(nc, nsOrig, ns, ls) {
  const ncWords = nc.split(" ");
  const lw = looseWords(ncWords);
  const { segs, covered } = segment(lw.map((x) => x.text), ls);
  const nCovered = covered.filter(Boolean).length;
  const coverage = lw.length ? nCovered / lw.length : 0;

  if (lw.length > 0 && nCovered === lw.length) {
    return { outcome: "composed", coverage: 1, segments: segs.length, ...disclose(nsOrig, ns, ls, segs) };
  }
  return { outcome: "not_found", coverage, unsupported: unsupportedSpans(lw, covered, ncWords) };
}

// Snapshot text by id. 5 of 604 snapshots overflow D1's per-value ceiling and are
// stored as content_norm = '' with the text in snapshot_overflow. Per the migration
// comment, never reassemble with SQL group_concat (it hits SQLITE_TOOBIG on read):
// fetch the small chunk rows in order and join them here.
export async function loadSnapshot(env, snapshot_id) {
  const row = await env.CORPUS
    .prepare("SELECT content_norm FROM snapshots WHERE snapshot_id = ?1")
    .bind(snapshot_id).first();
  if (!row) return null;
  if (row.content_norm !== "") return row.content_norm;
  const { results } = await env.CORPUS
    .prepare("SELECT seq, chunk FROM snapshot_overflow WHERE snapshot_id = ?1 ORDER BY seq")
    .bind(snapshot_id).all();
  const text = (results ?? []).map((r) => r.chunk).join("");
  return text || null;
}

// ---- Token differences on a near miss (owner's live test 2026-09-26) ----
// A not_found quote that is ONE word off the source ("must be" for the source's "must not
// be", with too little text on one side for a MIN_SEG segment) only listed `unsupported`
// candidate spans; the user could not see WHICH word was dropped or added. tokenDiff aligns
// the quote with its closest source passage (anchored on 3- then 2-word seeds, then a word
// LCS that ignores case and edge punctuation) and names the source words the quote lacks
// and the words the quote adds. Returned only when most of the quote aligns -- otherwise
// the passage is not a near miss and a "difference" would be noise.
const DIFF_MAX_WORDS = 200;      // longer quotes are not diffed (cost; and not a near miss)
const DIFF_MIN_ALIGNED = 0.6;    // share of quote words that must align
const DIFF_MAX_RUNS = 5;
const DIFF_RUN_WORDS = 12;
// Bounded source scans on a multi-MB snapshot: seed positions tried from each end of the
// quote, and occurrences of the start seed examined.
const DIFF_SEED_TRIES = 12;
const DIFF_OCCURRENCES = 10;
const diffKey = (w) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

function seedAt(s, seed, from) {
  let p = s.indexOf(seed, from);
  while (p !== -1 && !(isBoundary(s, p - 1) && isBoundary(s, p + seed.length))) p = s.indexOf(seed, p + 1);
  return p;
}

// Runs of consecutive indices, as text: [[1,2],[5]] -> ["w1 w2", "w5"].
function runsOf(idx, words) {
  const runs = [];
  let cur = [];
  for (const i of idx) {
    if (cur.length && i !== cur[cur.length - 1] + 1) { runs.push(cur); cur = []; }
    cur.push(i);
  }
  if (cur.length) runs.push(cur);
  return runs.slice(0, DIFF_MAX_RUNS).map((r) => r.slice(0, DIFF_RUN_WORDS).map((i) => words[i]).join(" "));
}

export function tokenDiff(candidate, source, { normalized = true } = {}) {
  const s = normalized ? String(source ?? "") : normalizeForMatch(source);
  const cw = normalizeForMatch(candidate).split(" ").filter(Boolean);
  if (cw.length < 3 || cw.length > DIFF_MAX_WORDS || !s) return undefined;

  // Start seed: the first 3-word (then 2-word) run of the quote found in the source.
  let startSeed = null;
  for (const n of [3, 2]) {
    for (let i = 0; i + n <= cw.length && i < DIFF_SEED_TRIES && !startSeed; i++) {
      const seed = cw.slice(i, i + n).join(" ");
      if (seedAt(s, seed, 0) !== -1) startSeed = { i, seed };
    }
    if (startSeed) break;
  }
  if (!startSeed) return undefined;
  // End anchor for a start position: the last run of the quote found at or after it.
  const endFor = (p) => {
    for (const n of [3, 2]) {
      for (let j = cw.length - n; j > startSeed.i && j >= cw.length - n - DIFF_SEED_TRIES; j--) {
        const seed = cw.slice(j, j + n).join(" ");
        const q = seedAt(s, seed, p);
        if (q !== -1) return { j: j + n, e: q + seed.length };
      }
    }
    return { j: startSeed.i, e: p };
  };
  // A seed can recur ("Subject to subparagraph" in every paragraph of a statute): take the
  // occurrence whose end anchor reaches furthest into the quote, then the tightest window.
  let start = null, end = null, bestSpan = Infinity;
  for (let p = seedAt(s, startSeed.seed, 0), tries = 0; p !== -1 && tries < DIFF_OCCURRENCES; tries++) {
    const e = endFor(p);
    if (!end || e.j > end.j || (e.j === end.j && e.e - p < bestSpan)) {
      bestSpan = e.e - p; start = { i: startSeed.i, p }; end = e;
    }
    p = seedAt(s, startSeed.seed, p + 1);
  }
  const a = wordsBehind(s, start.p, start.i + 2);
  const b = wordsAhead(s, end.e, cw.length - end.j + 2);
  const sw = s.slice(a, b).trim().split(" ").filter(Boolean);
  if (!sw.length || sw.length > 3 * cw.length + 10) return undefined;

  // Word LCS on folded keys.
  const ck = cw.map(diffKey), sk = sw.map(diffKey);
  const n = ck.length, m = sk.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = ck[i] && ck[i] === sk[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const cMatched = new Set(), sMatched = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (ck[i] && ck[i] === sk[j]) { cMatched.add(i); sMatched.push(j); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  // Punctuation-only "words" (a bare "-") never count either way.
  const real = (k) => k !== "";
  if (cMatched.size < DIFF_MIN_ALIGNED * ck.filter(real).length || !sMatched.length) return undefined;
  const lo = sMatched[0], hi = sMatched[sMatched.length - 1];
  const sSet = new Set(sMatched);
  const missing = [];
  for (let j = lo; j <= hi; j++) if (!sSet.has(j) && real(sk[j])) missing.push(j);
  const extra = [];
  for (let i = 0; i < n; i++) if (!cMatched.has(i) && real(ck[i])) extra.push(i);
  return {
    missing_from_quote: runsOf(missing, sw),
    extra_in_quote: runsOf(extra, cw),
    closest_source: sw.slice(lo, hi + 1).join(" "),
  };
}

// ---- Readable `checked_against` (owner's live test 2026-09-26) ----
// Bare snapshot ids ("8c03836f77f317e1") could not be audited: nobody could tell a Fannie
// quote had been checked against the FHA handbook. Each checked snapshot is now named from
// the obligations citing it: the document (register authority; for a snapshot shared by
// several registers, the document part before " — ", " > " or ", "), its edition when the
// corpus records one (Update NN, an "issued" date, the eCFR date in the source URL) and the
// retrieval date. The ids stay in `checked_snapshot_ids`; `checked_documents` has the parts.
//
// Batch 3 (owner's live test 2026-09-26, item 3): the in-force 4000.1 snapshot was
// labelled "Update 18" (its registers say "... Update 18 revision optional until ..."),
// the Update 18 snapshot was dated 2026-05-23 (the most common retrieval date among the
// obligations citing it; the Update 18 text itself was retrieved 2026-08-23), and both FHA
// entries could share one label. Now: an "Update NN revision ..." mention is not an
// edition; the version rows (obligation ids ending ::update-18, src/versions.js) mark the
// Update 18 revision and "in force by default" text; the retrieval date is the LATEST
// retrieval citing the snapshot; and labels are made unique.
const LABEL_SQL = `
  SELECT o.snapshot_id, o.authority, o.source_url, o.fetched_at, o.register_id, o.obligation_id,
         r.authority AS reg_authority, r.effective_date
  FROM obligations o JOIN registers r ON r.register_id = o.register_id
  WHERE o.snapshot_id IN (SELECT value FROM json_each(?1))`;

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best, n = 0;
  for (const [v, c] of counts) if (c > n || (c === n && v < best)) { best = v; n = c; }
  return best;
}

// "Update 18 revision optional until ..." / "Update 18 revision stamped ..." names the OTHER
// version of a dual-version section, not this text's edition.
const REVISION_MENTION = /\bUpdate\s+\d+\s+revision\b[^;)]*/gi;

function editionOf(rows, url) {
  const revision = rows.filter((r) => String(r.obligation_id ?? "").endsWith(VERSION_SUFFIX));
  if (revision.length && revision.length === rows.filter((r) => r.obligation_id).length) {
    return "Update 18 revision";
  }
  const eds = rows.map((r) => {
    const a = `${r.authority ?? ""} ${r.reg_authority ?? ""}`.replace(REVISION_MENTION, "");
    const pub = a.match(/\bedition (?:published |of )?([A-Z][a-z]+ \d{1,2}, \d{4})/);
    return a.match(/\bUpdate\s+\d+\b/i)?.[0] ?? a.match(/\bissued\s+\d{4}-\d{2}-\d{2}\b/i)?.[0] ??
      (pub ? `edition of ${pub[1]}` : undefined);
  });
  let ed = mostCommon(eds);
  // A snapshot holding the Update 18 revision text, or text marked in force by default,
  // says which (the two FHA snapshots otherwise read alike).
  if (revision.length) ed = ed ? `${ed}, incl. Update 18 revision text` : "incl. Update 18 revision text";
  else if (rows.some((r) => /\bversion in force by default\b/i.test(r.authority ?? ""))) {
    ed = ed ? `${ed}, text in force by default` : "text in force by default";
  }
  if (ed) return ed;
  const ecfr = String(url ?? "").match(/ecfr\.gov\/.*?(\d{4}-\d{2}-\d{2})/);
  if (ecfr) return `eCFR as of ${ecfr[1]}`;
  if (/[?&]edition=prelim\b/.test(String(url ?? ""))) return "U.S. Code (preliminary release)";
  return undefined;
}

const SUPERSEDED_PREFIX = /^\s*SUPERSEDED\s*[—:-]\s*(?:prior (?:version|text)[^—]*—\s*)?/i;

export function snapshotLabel(snapshot_id, rows) {
  if (!rows?.length) return { snapshot_id, label: snapshot_id };
  const regs = new Set(rows.map((r) => r.register_id));
  // stress6 C20: a superseded register's name starts "SUPERSEDED — [prior version (...) — ]",
  // which named the whole document "SUPERSEDED"; the prefix is dropped here and the
  // superseded state is stated in the edition instead.
  const cut = (a) => String(a ?? "").replace(SUPERSEDED_PREFIX, "")
    .split(/\s+—\s+|\s+>\s+|,\s+/)[0].trim();
  // A snapshot shared by several registers is one document (a whole guide or handbook):
  // name it by the longest leading words that at least 60% of its registers' names share
  // ("Fannie Mae Single Family Selling Guide", not the first section that happens to cite
  // it), else the commonest name.
  let document;
  if (regs.size > 1) {
    const perReg = new Map();
    for (const r of rows) if (!perReg.has(r.register_id)) perReg.set(r.register_id, cut(r.reg_authority || r.authority));
    const split = [...perReg.values()].filter(Boolean).map((n) => n.split(" "));
    const longest = Math.max(0, ...split.map((w) => w.length));
    for (let k = longest; k >= 2 && !document; k--) {
      const top = mostCommon(split.filter((w) => w.length >= k).map((w) => w.slice(0, k).join(" ")));
      if (!top) continue;
      const n = split.filter((w) => w.slice(0, k).join(" ") === top).length;
      if (n >= 0.6 * split.length) document = top;
    }
    if (!document) document = mostCommon(split.map((w) => w.join(" ")));
  } else {
    document = String(rows[0].reg_authority || rows[0].authority || "").replace(SUPERSEDED_PREFIX, "").trim();
  }
  const source_url = mostCommon(rows.map((r) => r.source_url));
  let edition = editionOf(rows, source_url);
  const allSuperseded = rows.every((r) => /-superseded-/.test(String(r.register_id ?? "")) ||
    SUPERSEDED_PREFIX.test(String(r.reg_authority ?? "")));
  if (allSuperseded) edition = edition ? `${edition}, superseded text` : "superseded text";
  // Retrieval date: the commonest among the obligations citing the snapshot -- except that
  // the Update 18 revision rows (::update-18) date a snapshot holding them: the other rows
  // on the Update 18 PDF carry pre-issue dates (2026-05-23 for a PDF issued 2026-08-12, an
  // index defect reported separately). The full span is in `retrieved_range`.
  const dates = rows.map((r) => String(r.fetched_at ?? "").slice(0, 10)).filter(Boolean).sort();
  const revDates = rows.filter((r) => String(r.obligation_id ?? "").endsWith(VERSION_SUFFIX))
    .map((r) => String(r.fetched_at ?? "").slice(0, 10)).filter(Boolean);
  const retrieved = mostCommon(revDates.length ? revDates : dates);
  const range = dates.length && dates[0] !== dates[dates.length - 1]
    ? { first: dates[0], last: dates[dates.length - 1] } : null;
  const effective = regs.size === 1 ? rows[0].effective_date ?? undefined : undefined;
  if (!document) return { snapshot_id, label: snapshot_id };
  const parts = [edition && !document.includes(edition) ? edition : null,
    effective ? `effective ${effective}` : null, retrieved ? `retrieved ${retrieved}` : null].filter(Boolean);
  return {
    snapshot_id,
    label: parts.length ? `${document} (${parts.join(", ")})` : document,
    document,
    ...(edition ? { edition } : {}),
    ...(effective ? { effective_date: effective } : {}),
    ...(retrieved ? { retrieved } : {}),
    ...(range ? { retrieved_range: range } : {}),
    ...(source_url ? { source_url } : {}),
  };
}

// Two checked snapshots never share a label: a repeat gets its snapshot id appended.
export function uniqueLabels(docs) {
  const seen = new Map();
  for (const d of docs) seen.set(d.label, (seen.get(d.label) ?? 0) + 1);
  return docs.map((d) => (seen.get(d.label) > 1 && d.label !== d.snapshot_id
    ? { ...d, label: `${d.label} [snapshot ${d.snapshot_id}]` } : d));
}

async function checkedFields(env, ids) {
  let rows = [];
  if (ids.length) {
    try {
      ({ results: rows } = await env.CORPUS.prepare(LABEL_SQL).bind(JSON.stringify(ids)).all());
    } catch {
      rows = []; // labels are a convenience: never fail the check over them
    }
  }
  const docs = uniqueLabels(
    ids.map((id) => snapshotLabel(id, (rows ?? []).filter((r) => r.snapshot_id === id))),
  );
  return {
    checked_against: docs.map((d) => d.label),
    checked_snapshot_ids: ids,
    ...(docs.some((d) => d.document) ? { checked_documents: docs } : {}),
  };
}

const RANK = { exact: 3, normalized: 2, composed: 1, not_found: 0 };
const better = (a, b) =>
  RANK[a.outcome] !== RANK[b.outcome] ? RANK[a.outcome] > RANK[b.outcome] : a.coverage > b.coverage;

// Candidate lookup when no register_id is given (Task 9b). An OR over the content
// terms of the passage's first CANDIDATE_WORDS words, bm25-ranked: the old AND over
// the first 12 words failed whenever one of them was absent from the obligation
// text (a mid-heading start, a digit-hyphen the extract dropped), and found the
// passage's own source only 38/50 on the golden sample. Several obligations share
// a snapshot, so CANDIDATE_ROWS obligations are fetched and de-duplicated to at
// most MAX_CANDIDATE_SNAPSHOTS snapshots.
export const CANDIDATE_WORDS = 25;
const CANDIDATE_ROWS = 10;
const MAX_CANDIDATE_SNAPSHOTS = 3;
const FTS_SQL = `
  SELECT o.snapshot_id
  FROM obligations_fts
  JOIN obligations o ON o.rowid = obligations_fts.rowid
  WHERE obligations_fts MATCH ?1
  ORDER BY bm25(obligations_fts) LIMIT ${CANDIDATE_ROWS}`;

// stress6 C20 (N2, N21): the OR query above ranks by term overlap, so a verbatim Selling
// Guide sentence was checked against USDA and FHA text and never against the Selling Guide,
// and a sentence in both the May and September Selling Guide editions was checked only
// against May's. Candidates now start from obligations that contain the passage's own word
// runs: an FTS5 phrase query over three PHRASE_WORDS-token windows (start, middle, end).
// Their snapshots come first -- snapshots whose containing obligation is in a current
// register before superseded ones, newer retrievals first -- then the OR query's.
export const PHRASE_WORDS = 8;
const PHRASE_ROWS = 20;
const PHRASE_SQL = `
  SELECT o.snapshot_id, o.register_id, o.fetched_at, r.coverage_tier
  FROM obligations_fts
  JOIN obligations o ON o.rowid = obligations_fts.rowid
  JOIN registers r ON r.register_id = o.register_id
  WHERE obligations_fts MATCH ?1
  ORDER BY bm25(obligations_fts) LIMIT ${PHRASE_ROWS}`;

// FTS5 phrase windows ('"w1 w2 ... w8"', start/middle/end) from the passage: unicode61 splits
// on every non-alphanumeric, so the tokens are the passage's alphanumeric runs.
export function buildPhraseWindows(text) {
  const toks = String(text ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (toks.length < 4) return [];
  const n = Math.min(PHRASE_WORDS, toks.length);
  const starts = [...new Set([0, Math.floor((toks.length - n) / 2), toks.length - n])];
  return starts.map((i) => `"${toks.slice(i, i + n).join(" ")}"`);
}

export function buildPhraseQuery(text) {
  const w = buildPhraseWindows(text);
  return w.length ? w.join(" OR ") : null;
}

export function isSupersededRegister(row) {
  return row?.coverage_tier === "superseded" || /-superseded-/.test(String(row?.register_id ?? ""));
}

// Snapshot ids from phrase hits: snapshots containing more of the passage's windows first
// (a document with all three beats newer ones sharing one generic window), then current-register
// hits before superseded, then newest retrieval. A row's `window` says which window matched;
// rows without one count as a single window.
export function orderPhraseSnapshots(rows) {
  const best = new Map();
  const windows = new Map();
  for (const r of rows ?? []) {
    if (!r.snapshot_id) continue;
    if (!windows.has(r.snapshot_id)) windows.set(r.snapshot_id, new Set());
    windows.get(r.snapshot_id).add(r.window ?? "any");
    const key = [isSupersededRegister(r) ? 1 : 0, String(r.fetched_at ?? "")];
    const prev = best.get(r.snapshot_id);
    if (!prev || key[0] < prev[0] || (key[0] === prev[0] && key[1] > prev[1])) best.set(r.snapshot_id, key);
  }
  return [...best.entries()]
    .sort((a, b) => windows.get(b[0]).size - windows.get(a[0]).size
      || a[1][0] - b[1][0] || (a[1][1] < b[1][1] ? 1 : a[1][1] > b[1][1] ? -1 : 0))
    .map(([id]) => id);
}

const NOTES = {
  exact: "The text appears contiguously in the regulator's source.",
  normalized: "The text appears contiguously in the source after typography folding (quotes, dashes, whitespace).",
  composed: "Every word is traceable to the source, but assembled from non-contiguous pieces " +
    "(including any elisions the quoter marked with an ellipsis). Review `omissions`: a short " +
    "skipped phrase (for example 'not') can change the meaning.",
  not_found: "No source support found. Do not present this text as regulator language.",
};

// matched_version: is the matched snapshot CURRENT text or a SUPERSEDED version?
// A snapshot is superseded when every register citing it is superseded (coverage_tier
// 'superseded', or an id with "-superseded-", e.g. reg-b-1002-6-superseded-2026), or, when
// register_id is given, when each of that register's obligations citing it has a same-section
// obligation in the register on a newer snapshot (a re-sourced paragraph). One aggregate
// query on idx_obl_snapshot for a current match (two with register_id); the details query
// runs only on a superseded match. Returns undefined when the snapshot has no registers.
const SUPERSEDED_SQL = "(coverage_tier = 'superseded' OR register_id LIKE '%-superseded-%')";
// An FHA dual-version section's two obligations (src/versions.js) cite different snapshots
// for the same section, which is exactly the shape of a re-sourced paragraph -- but neither
// supersedes the other: the in-force text governs by default and the Update 18 revision is
// optional until its mandatory date. Revision rows are therefore left out of the shadow
// test on every side (by id, so it holds before the versions table exists).
const NOT_REVISION = (a) => `${a}.obligation_id NOT LIKE '%${VERSION_SUFFIX}'`;
const VERSION_SQL = `
  SELECT SUM(CASE WHEN ${SUPERSEDED_SQL} THEN 0 ELSE 1 END) AS current_regs,
         MIN(CASE WHEN ${SUPERSEDED_SQL} THEN register_id END) AS superseded_register
  FROM registers
  WHERE register_id IN (SELECT DISTINCT register_id FROM obligations WHERE snapshot_id = ?1)`;
const PRIOR_SQL = `
  SELECT r.effective_date AS prior_effective, c.register_id AS current_id,
         c.effective_date AS current_effective
  FROM registers r
  LEFT JOIN registers c ON c.register_id = COALESCE(
    (SELECT register_id FROM registers WHERE register_id = r.superseded_by), ?2)
  WHERE r.register_id = ?1`;
const SHADOW_SQL = `
  SELECT COUNT(*) AS n,
         SUM(CASE WHEN EXISTS (
           SELECT 1 FROM obligations o2
           WHERE o2.register_id = o.register_id AND o2.section = o.section AND ${NOT_REVISION("o2")}
             AND o2.snapshot_id <> o.snapshot_id AND o2.fetched_at > o.fetched_at) THEN 1 ELSE 0 END) AS shadowed,
         (SELECT o3.snapshot_id FROM obligations o3
          WHERE o3.register_id = ?1 AND o3.snapshot_id <> ?2 AND ${NOT_REVISION("o3")}
            AND o3.section IN (SELECT section FROM obligations WHERE register_id = ?1 AND snapshot_id = ?2)
          ORDER BY o3.fetched_at DESC LIMIT 1) AS current_snapshot
  FROM obligations o
  WHERE o.register_id = ?1 AND o.snapshot_id = ?2 AND ${NOT_REVISION("o")}`;

async function matchedVersion(env, snapshot_id, register_id) {
  const agg = await env.CORPUS.prepare(VERSION_SQL).bind(snapshot_id).first();
  if (!agg || (agg.current_regs == null && !agg.superseded_register)) return undefined;
  if (!agg.current_regs && agg.superseded_register) {
    const sup = agg.superseded_register;
    const base = sup.replace(/-superseded-.*$/, "");
    const d = await env.CORPUS.prepare(PRIOR_SQL).bind(sup, base === sup ? null : base).first();
    return {
      matched_version: "superseded",
      superseded_register_id: sup,
      ...(d?.current_id ? { superseded_by: d.current_id } : {}),
      ...(d?.prior_effective ? { prior_effective_date: d.prior_effective } : {}),
      ...(d?.current_effective ? { superseded_on: d.current_effective } : {}),
    };
  }
  if (register_id) {
    const s = await env.CORPUS.prepare(SHADOW_SQL).bind(register_id, snapshot_id).first();
    if (s && s.n > 0 && s.shadowed === s.n) {
      return {
        matched_version: "superseded", superseded_register_id: register_id, superseded_by: register_id,
        superseded_snapshot: snapshot_id,
        ...(s.current_snapshot ? { current_snapshot: s.current_snapshot } : {}),
      };
    }
  }
  return { matched_version: "current" };
}

// stress6 C02: matched_version was inferred from the SNAPSHOT. The pre-SEL-2026-06 B3-5.3-09
// sentence sits on the May Selling Guide snapshot, which also backs current registers, so it
// read "current"; old M26-7 Ch.12 radon text shares snapshot 824171a914866a59 with other
// superseded topics and was attributed to the first of them (MIN(register_id)). Now the
// obligations on the matched snapshot whose stored text contains the passage decide: any in a
// current register -> current; all in superseded registers -> superseded, attributed to that
// obligation's register and its superseded_by. The match is reported as matched_register_id /
// matched_obligation_id. A passage in no stored obligation (composed, or snapshot text outside
// every obligation) falls back to the snapshot-level test.
const CONTAINS_SQL = `
  SELECT o.obligation_id, o.register_id, o.fetched_at, r.coverage_tier, r.superseded_by
  FROM obligations o JOIN registers r ON r.register_id = o.register_id
  WHERE o.snapshot_id = ?1 AND instr(o.verbatim_norm, ?2) > 0
  LIMIT 25`;

export async function containingObligations(env, snapshotId, text) {
  for (const n of needles(text)) {
    try {
      const { results } = await env.CORPUS.prepare(CONTAINS_SQL).bind(snapshotId, n).all();
      if (results?.length) return results;
    } catch {
      return [];
    }
  }
  return [];
}

async function resolveVersion(env, snapshotId, register_id, text) {
  const hits = text == null ? [] : await containingObligations(env, snapshotId, text);
  if (!hits.length) return matchedVersion(env, snapshotId, register_id);
  const inReg = register_id ? hits.filter((h) => h.register_id === register_id) : [];
  const cur = hits.filter((h) => !isSupersededRegister(h));
  const where = (h) => ({ matched_register_id: h.register_id, matched_obligation_id: h.obligation_id });
  if (cur.length) {
    const h = inReg.find((x) => !isSupersededRegister(x)) ??
      cur.find((x) => !String(x.obligation_id).endsWith(VERSION_SUFFIX)) ?? cur[0];
    if (register_id && h.register_id === register_id) {
      const v = await matchedVersion(env, snapshotId, register_id);
      if (v?.superseded_snapshot) return { ...v, ...where(h) };
    }
    return { matched_version: "current", ...where(h) };
  }
  const h = inReg[0] ?? hits[0];
  const sup = h.register_id;
  const base = sup.replace(/-superseded-.*$/, "");
  let d = null;
  try {
    d = await env.CORPUS.prepare(PRIOR_SQL).bind(sup, base === sup ? null : base).first();
  } catch {
    d = null;
  }
  const by = d?.current_id ?? h.superseded_by ?? null;
  return {
    matched_version: "superseded",
    superseded_register_id: sup,
    ...(by ? { superseded_by: by } : {}),
    ...(d?.prior_effective ? { prior_effective_date: d.prior_effective } : {}),
    ...(d?.current_effective ? { superseded_on: d.current_effective } : {}),
    ...where(h),
  };
}

// The current issuances an obligation_currency row on `obligationId` links (other than the
// obligation's own register), whose source holds the passage contiguously: { id, r,
// register_id } or null. Snapshots already checked are skipped.
const LINKED_SQL = `
  SELECT oc.register_id AS own, oc.links_json FROM obligation_currency oc
  WHERE oc.obligation_id = ?1`;
async function linkedIssuanceMatch(env, obligationId, text, checked) {
  let rows = [];
  try {
    ({ results: rows } = await env.CORPUS.prepare(LINKED_SQL).bind(obligationId).all());
  } catch {
    return null;
  }
  const regs = [...new Set((rows ?? []).flatMap((r) => linksOf(r.links_json)
    .map((l) => l.register_id).filter((id) => id && id !== r.own)))];
  for (const reg of regs) {
    let snaps = [];
    try {
      ({ results: snaps } = await env.CORPUS.prepare(
        "SELECT DISTINCT o.snapshot_id, r.coverage_tier, r.register_id FROM obligations o " +
        "JOIN registers r ON r.register_id = o.register_id WHERE o.register_id = ?1").bind(reg).all());
    } catch {
      continue;
    }
    for (const sn of snaps ?? []) {
      if (isSupersededRegister(sn) || checked.includes(sn.snapshot_id)) continue;
      const snapshot = await loadSnapshot(env, sn.snapshot_id);
      if (!snapshot) continue;
      const r = classifyListAware(text, snapshot);
      if (r.outcome === "exact" || r.outcome === "normalized") return { id: sn.snapshot_id, r, register_id: reg };
    }
  }
  return null;
}

// Editorial warning prepended to `note` on a superseded match.
function supersededNote(v) {
  const dates = [v.prior_effective_date && `in force from ${v.prior_effective_date}`,
                 v.superseded_on && `superseded effective ${v.superseded_on}`].filter(Boolean).join(", ");
  const where = v.superseded_snapshot
    ? `an older source snapshot (${v.superseded_snapshot}) of register ${v.superseded_register_id}` +
      (v.current_snapshot ? `, which now cites ${v.current_snapshot} for that section` : "")
    : `register ${v.superseded_register_id}`;
  let current = "";
  if (v.superseded_by && v.superseded_by !== v.superseded_register_id) {
    current = ` The current rule is register ${v.superseded_by}; check it with ` +
      `verify_quote(register_id="${v.superseded_by}") or get_reg.`;
  } else if (!v.superseded_by) {
    current = " No current register is linked; confirm the current rule before relying on this text.";
  }
  return `SUPERSEDED: this text matched a PRIOR version of the rule, ${where}` +
    (dates ? ` (${dates})` : "") + ". Present it only as the prior version, with those dates, " +
    "never as the current requirement." + current;
}

// Dual-version sections (src/versions.js): which version's text does a contiguous match lie
// in? The version rows whose normalized text contains the candidate, on the matched
// snapshot. A missing versions table reads as "no rows" (the Worker may ship first).
const VERSION_MATCH_SQL = `
  SELECT v.obligation_id, v.register_id, v.version, v.pair_id, v.effective_date,
         v.mandatory_date, o.snapshot_id
  FROM obligation_versions v JOIN obligations o ON o.obligation_id = v.obligation_id
  WHERE (?2 = '' OR v.register_id = ?2) AND instr(o.verbatim_norm, ?1) > 0`;

// The normalized forms classify() may have matched (as written, edge punctuation trimmed,
// first letter's case flipped), most literal first.
function needles(text) {
  const raw = String(text ?? "");
  const trimmed = raw.replace(EDGE_LEAD, "").replace(EDGE_TRAIL, "");
  return [...new Set([raw, trimmed, flipFirstLetter(raw), flipFirstLetter(trimmed)]
    .map(normalizeForMatch).filter(Boolean))];
}

async function versionHits(env, text, register_id) {
  for (const n of needles(text)) {
    try {
      const { results } = await env.CORPUS.prepare(VERSION_MATCH_SQL).bind(n, register_id ?? "").all();
      if (results?.length) return results;
    } catch {
      return [];
    }
  }
  return [];
}

// From the version rows containing a quote (matched snapshot only): the revision's text
// only -> "update-18-optional"; the in-force text only -> current, labeled in-force with
// the revision's id; both texts of one section -> current, unchanged by Update 18.
export function versionVerdict(hits, snapshotId) {
  const on = (hits ?? []).filter((h) => h.snapshot_id === snapshotId);
  const ids = new Set((hits ?? []).map((h) => h.obligation_id));
  const both = on.find((h) => ids.has(h.pair_id));
  if (both) {
    return { version: "both", note: "This passage is identical in the in-force text and in " +
      "HUD's Update 18 revision of the section: it applies either way." };
  }
  const rev = on.filter((h) => h.version === UPDATE_18);
  const cur = on.filter((h) => h.version === IN_FORCE);
  if (rev.length && !cur.length) {
    const h = rev[0];
    return {
      matched_version: UPDATE_18,
      obligation_id: h.obligation_id,
      in_force_obligation_id: h.pair_id,
      ...(h.mandatory_date ? { mandatory_date: h.mandatory_date } : {}),
      note: "UPDATE 18 REVISION: this text matched HUD Handbook 4000.1 Update 18's revised " +
        `version of the section (obligation ${h.obligation_id}), which a Mortgagee may ` +
        `implement now and must implement by ${h.mandatory_date}. It is NOT the text in force ` +
        `by default (obligation ${h.pair_id}): present it as the Update 18 version, which ` +
        "governs only a Mortgagee that has adopted Update 18 until that date.",
    };
  }
  if (cur.length && !rev.length) {
    const h = cur[0];
    return {
      version: IN_FORCE,
      obligation_id: h.obligation_id,
      update_18_obligation_id: h.pair_id,
      note: "This passage is from the text in force by default. HUD's Update 18 revision of " +
        `the section (obligation ${h.pair_id}; optional now, mandatory on its date) does not ` +
        "contain it verbatim: check what the revision says before relying on it for a " +
        "Mortgagee that has adopted Update 18.",
    };
  }
  return undefined;
}

// ---- exact vs normalized typography (C4C-18, owner's live test 2026-09-26) ----
// Snapshots are stored NORMALIZED (curly quotes and dashes folded), so a straight
// "borrower's" matched the source's curly "borrower’s" at the `exact` stage -- the
// description promises `normalized` whenever typography had to be folded. When the quote
// carries a quote mark or dash, the ORIGINAL text of the obligations on the matched
// snapshot decides: the quote as written (whitespace runs aside) -> exact; otherwise
// normalized. A match outside every stored obligation cannot be checked character for
// character and stays `normalized`. The same check promotes a `normalized` match that
// differed only in line breaks/whitespace runs (PDF line wraps) to `exact`.
const TYPO_CHARS = /['"‘’‚‛′“”„‟″\-‐-―−]/;
const TYPO_SQL = `
  SELECT verbatim FROM obligations
  WHERE snapshot_id = ?1 AND instr(verbatim_norm, ?2) > 0 LIMIT 5`;

export async function typographyExact(env, snapshotId, text) {
  const raw = String(text ?? "").trim();
  const needle = normalizeForMatch(raw);
  if (!snapshotId || !needle) return false;
  let rows = [];
  try {
    ({ results: rows } = await env.CORPUS.prepare(TYPO_SQL).bind(snapshotId, needle).all());
  } catch {
    return false;
  }
  const words = raw.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(words.join("\\s+"), "u");
  if ((rows ?? []).some((r) => re.test(String(r.verbatim ?? "")))) return true;
  // Batch 11 (stress6 C21 N10): exact but for list glyphs between words ("• the trust ..."
  // quoted without the "•") -> "glyphs": the caller labels it list_markers_ignored.
  const g = new RegExp(words.join(`\\s+(?:${LIST_GLYPH}\\s+)?`), "u");
  return (rows ?? []).some((r) => g.test(String(r.verbatim ?? ""))) ? "glyphs" : false;
}
const LIST_GLYPH = "[\\u2022\\u2023\\u2043\\u25a0\\u25aa\\u25cf\\u25e6\\u26ac\\u00b7\\uf0a7\\uf0b7o*-]";

// ---- Obligation-level currency on a match (Round 4 follow-up) ----
// verify_quote never read `obligation_currency`, so the sentence ML 2026-07 rescinded from
// 4000.1 II.A.1.a ("The Mortgagee must provide the Borrower with a copy of form HUD-92900-B
// ...") verified `exact` / `current` with no warning. After a match, the obligations on the
// checked snapshots that contain the quote are looked up in obligation_currency; their rows
// come back as `obligation_currency`. When a row's detail itself quotes the passage (the
// corpus quotes the text a letter removes) -- or the quote is inside the text the row says a
// letter superseded -- the result carries `rescinded: true` and `rescinded_by` (the issuing
// registers from the row's links), and the note says so first. matched_version is unchanged:
// the snapshot is current; the SENTENCE is not. With register_id the lookup is that register's
// obligations on the checked snapshots; without it, every obligation carrying such a row (a
// small table) -- the quote may have matched a Mortgagee Letter that quotes the removed text,
// while the user means the handbook.
const OC_SQL = `
  SELECT oc.obligation_id, oc.register_id, oc.kind, oc.headline, oc.detail, oc.effective_date,
         oc.mandatory_date, oc.links_json
  FROM obligation_currency oc JOIN obligations o ON o.obligation_id = oc.obligation_id
  WHERE (?2 = '' OR (oc.register_id = ?2 AND o.snapshot_id IN (SELECT value FROM json_each(?1))))
    AND instr(o.verbatim_norm, ?3) > 0`;
const RESCIND_KINDS = new Set(["superseded-in-part", "modified-by", "superseded"]);
const WINDOW_WORDS = 8;

function linksOf(json) {
  try { const v = JSON.parse(json ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

// Does `detail` quote (part of) the passage? Whole passage, or any WINDOW_WORDS-word run of it.
export function detailQuotes(detail, text) {
  const d = qfold(normalizeForMatch(detail)).replace(/\s+/g, " ");
  const q = qfold(normalizeForMatch(text)).replace(EDGE_LEAD, "").replace(EDGE_TRAIL, "");
  if (!d || !q) return false;
  if (d.includes(q)) return true;
  const w = q.split(" ");
  for (let i = 0; i + WINDOW_WORDS <= w.length; i++) {
    if (d.includes(w.slice(i, i + WINDOW_WORDS).join(" "))) return true;
  }
  return false;
}

export async function obligationCurrencyFor(env, snapshotIds, text, register_id) {
  if (!snapshotIds?.length) return [];
  const words = normalizeForMatch(text).replace(EDGE_LEAD, "").replace(EDGE_TRAIL, "").split(" ");
  // The whole quote, then its first run of words (a composed quote is not contiguous).
  const needles = [...new Set([words.join(" "), words.slice(0, WINDOW_WORDS).join(" ")])]
    .filter((n) => n.length >= 12);
  const seen = new Map();
  for (const n of needles) {
    try {
      const { results } = await env.CORPUS.prepare(OC_SQL)
        .bind(JSON.stringify(snapshotIds), register_id ?? "", n).all();
      for (const r of results ?? []) if (!seen.has(r.obligation_id)) seen.set(r.obligation_id, r);
    } catch {
      return []; // a Worker ahead of the table degrades to "no obligation currency"
    }
    if (seen.size) break;
  }
  return [...seen.values()];
}

export function withObligationCurrencyFlags(out, rows, text) {
  if (!rows.length) return out;
  const brief = rows.map((r) => ({
    obligation_id: r.obligation_id, register_id: r.register_id, kind: r.kind, headline: r.headline,
    ...(r.effective_date ? { effective_date: r.effective_date } : {}),
    ...(r.mandatory_date ? { mandatory_date: r.mandatory_date } : {}),
  }));
  const hit = rows.filter((r) => RESCIND_KINDS.has(r.kind) && detailQuotes(r.detail, text));
  const res = { ...out, obligation_currency: brief };
  if (hit.length) {
    const by = [...new Set(hit.flatMap((r) => linksOf(r.links_json).map((l) => l.register_id)
      .filter((id) => id && id !== r.register_id)))];
    res.rescinded = true;
    if (by.length) res.rescinded_by = by;
    // Batch 11 (stress6 C21 R18): `rescinded: true` beside matched_version "current" read as
    // a contradiction. The sentence is a prior version of the rule: label it so, with the
    // snapshot-level verdict kept as snapshot_version.
    if (out.matched_version && out.matched_version !== "superseded") res.snapshot_version = out.matched_version;
    res.matched_version = "superseded";
    if (by.length && !out.superseded_by) res.superseded_by = by[0];
    res.note = `SUPERSEDED TEXT: this passage is in the handbook text, but ${hit[0].headline}. ` +
      `The corpus records that ${by.length ? by.join(", ") : "a later issuance"} removed or ` +
      "replaced exactly this text: do NOT present it as a current requirement; quote the " +
      `superseding document instead. ${out.note}`;
  } else {
    res.note = `${out.note} Note: the obligation holding this text carries an obligation-level ` +
      `warning (${brief.map((b) => b.kind).join(", ")}): ${brief[0].headline}. Check that ` +
      "the passage is not among the provisions it names.";
  }
  return res;
}

// Tool body, separated from registration so it can be tested with a fake D1.
// A register id never contains "::"; an obligation id passed as register_id (possibly a
// retired one, obligation_aliases) is checked against the register holding its text now.
export async function verifyQuote(env, { text, register_id }) {
  const resolved = register_id ? await registerOfObligation(env, register_id) : null;
  const extra = resolved
    ? { register_id: resolved.register_id, obligation_id: resolved.obligation_id,
        ...(resolved.from ? { resolved_from_alias: resolved.from } : {}) }
    : {};
  if (resolved) register_id = resolved.register_id;
  const out = await verifyQuoteCore(env, { text, register_id });
  if (!out || out.outcome === "not_found" || out.outcome === "not_checked" || out.error) {
    return out && resolved ? { ...out, ...extra } : out;
  }
  const rows = await obligationCurrencyFor(env, out.checked_snapshot_ids, text, register_id);
  let res = withObligationCurrencyFlags(out, rows, text);
  if (rows.some((r) => r.kind === "pending")) {
    const holders = [];
    for (const sid of out.checked_snapshot_ids ?? []) holders.push(...await containingObligations(env, sid, text));
    res = withPendingVersion(res, rows, holders, register_id);
  }
  res = withRegisterNote(res, await registerNoteFor(env, res.matched_register_id ?? register_id));
  return resolved ? { ...res, ...extra } : res;
}

// Batch 11: currency kind "note" (batch 10; e.g. va-m26-7-ch13-t08 "Note on condition 15
// (Radon Gas): Chapter 12 Topic 34 removed the radon requirement", va-m26-7-ch03-t04 Table 3)
// is an editorial note on a CURRENT register -- not a supersession, never a demotion
// (src/currency.js STALE_KINDS) -- but a passage verified in that register must not read as
// unqualified: the note's headline and links travel with the match as `register_note`.
const NOTE_SQL = "SELECT kind, headline, links_json FROM currency WHERE register_id = ?1 AND kind = 'note'";
export async function registerNoteFor(env, registerId) {
  if (!registerId) return null;
  try {
    return await env.CORPUS.prepare(NOTE_SQL).bind(registerId).first();
  } catch {
    return null;
  }
}

export function withRegisterNote(out, row) {
  if (!row?.headline) return out;
  const links = linksOf(row.links_json).filter((l) => l.register_id && l.register_id !== out.matched_register_id);
  return {
    ...out,
    register_note: { kind: "note", headline: row.headline,
      ...(links.length ? { see: links.map((l) => l.register_id) } : {}) },
    note: `${out.note} Editorial note on this register (not a supersession of the whole text): ` +
      `${row.headline}.${links.length ? ` See ${links.map((l) => l.register_id).join(", ")}.` : ""}`,
  };
}

// Batch 11 (stress6 C16 R25/R16): a Freddie Mac section holds the text in force AND pending
// versions ("PENDING VERSION, takes effect 2026-11-02"), all on one snapshot. A passage found
// ONLY in pending versions read matched_version "current"; a passage in the in-force text AND
// the pending versions got a note attributing it to the pending ones. `holders` are the
// obligations whose stored text contains the passage (containingObligations); `rows` the
// obligation_currency rows. Only-pending -> matched_version "pending", the earliest pending
// obligation and its date; in-force too -> the in-force obligation named, "applies now".
export function withPendingVersion(out, rows, holders, register_id) {
  const hs = (holders ?? []).filter((h) => !register_id || h.register_id === register_id);
  if (!hs.length) return out;
  const pend = new Map(rows.filter((r) => r.kind === "pending").map((r) => [r.obligation_id, r]));
  const pendHolders = hs.filter((h) => pend.has(h.obligation_id));
  if (!pendHolders.length) return out;
  const inForce = hs.filter((h) => !pend.has(h.obligation_id) && !isSupersededRegister(h));
  const dated = pendHolders.map((h) => pend.get(h.obligation_id))
    .sort((a, b) => String(a.effective_date ?? "").localeCompare(String(b.effective_date ?? "")));
  const first = dated[0];
  // The verdict's own note, without the generic obligation-level warning appended above.
  const base0 = String(out.note ?? "").split(" Note: the obligation holding this text")[0];
  const when = first.effective_date ?? first.mandatory_date;
  if (!inForce.length) {
    const base = String(first.obligation_id).split("::")[0];
    return {
      ...out,
      matched_version: "pending",
      matched_obligation_id: first.obligation_id,
      ...(when ? { pending_effective_date: when } : {}),
      note: `PENDING VERSION: this text is found only in a published version that is not in ` +
        `force until ${when ?? "its effective date"} (obligation ${first.obligation_id}` +
        `${dated.length > 1 ? `; also ${dated.slice(1).map((r) => r.obligation_id).join(", ")}` : ""}). ` +
        `It is NOT the text in force today (register ${base}): present it as the pending ` +
        `version, with that date. ${base0}`,
    };
  }
  const cur = inForce[0];
  return {
    ...out,
    matched_obligation_id: cur.obligation_id,
    note: `${base0} It is in the text in force ` +
      `today (obligation ${cur.obligation_id}) and also in the pending version(s) ` +
      `${dated.map((r) => `${r.obligation_id} (from ${r.effective_date ?? r.mandatory_date})`).join(", ")}: ` +
      "it applies now and is unchanged by them.",
  };
}

// verify_quote given an obligation id where a register id belongs: { register_id,
// obligation_id, from } of the obligation holding that text -- `from` is set when the id was
// a retired one resolved through obligation_aliases (src/aliases.js). null when the id is
// neither an obligation nor an alias (fails open: a missing alias table is "no alias").
export async function registerOfObligation(env, id) {
  if (!String(id).includes("::")) return null;
  const direct = async (oid) => {
    try {
      return await env.CORPUS
        .prepare("SELECT obligation_id, register_id FROM obligations WHERE obligation_id = ?1")
        .bind(oid).first();
    } catch {
      return null;
    }
  };
  const row = await direct(id);
  if (row?.register_id) return { register_id: row.register_id, obligation_id: row.obligation_id, from: null };
  let cur = id;
  for (let hop = 0; hop < 3; hop++) {
    const next = await resolveObligationAlias(env, cur);
    if (!next || next === cur) return null;
    cur = next;
    const hit = await direct(cur);
    if (hit?.register_id) return { register_id: hit.register_id, obligation_id: hit.obligation_id, from: id };
  }
  return null;
}

async function verifyQuoteCore(env, { text, register_id }) {
  const nc = normalizeForMatch(text);
  const words = nc ? nc.split(" ").length : 0;
  if (words > MAX_WORDS) {
    return {
      outcome: "not_checked", reason: "too_long", words, limit: MAX_WORDS,
      note: `Split the passage into pieces of at most ${MAX_WORDS} words and verify each.`,
    };
  }

  let ids;
  if (register_id) {
    const { results } = await env.CORPUS
      .prepare("SELECT DISTINCT snapshot_id FROM obligations WHERE register_id = ?1")
      .bind(register_id).all();
    if (!results || results.length === 0) {
      // Refusal contract: no suggestions.
      return {
        error: "not_found", register_id,
        hint: "Use search_regs or lookup_citation to find a valid register_id, or omit it.",
      };
    }
    ids = results.map((r) => r.snapshot_id);
  } else {
    // One phrase query per window, so each hit records which windows its document contains.
    const phraseRows = [];
    for (const [window, phrase] of buildPhraseWindows(nc).entries()) {
      try {
        const { results } = await env.CORPUS.prepare(PHRASE_SQL).bind(phrase).all();
        for (const r of results ?? []) phraseRows.push({ ...r, window });
      } catch {
        // A malformed FTS phrase skips this window; the others and the OR query still run.
      }
    }
    const phraseIds = orderPhraseSnapshots(phraseRows);
    const match = buildOrQuery(nc.split(" ").slice(0, CANDIDATE_WORDS).join(" "));
    const { results } = match
      ? await env.CORPUS.prepare(FTS_SQL).bind(match).all()
      : { results: [] };
    ids = [...phraseIds, ...(results ?? []).map((r) => r.snapshot_id)];
  }
  ids = [...new Set(ids.filter(Boolean))];
  if (!register_id) ids = ids.slice(0, MAX_CANDIDATE_SNAPSHOTS);

  const checked = [];
  const results = [];   // [{ id, r }] per checked snapshot, for the current-over-superseded tie-break
  let best = null, bestId = null, bestVersion, bestSnapshot = null;
  for (const id of ids) {
    const snapshot = await loadSnapshot(env, id);
    if (!snapshot) continue;
    checked.push(id);
    const r = classifyListAware(text, snapshot);
    results.push({ id, r });
    if (!best || better(r, best)) { best = r; bestId = id; bestVersion = undefined; bestSnapshot = snapshot; }
    if (r.outcome === "exact") {
      // Stop at the first exact match unless it is prior text: a later snapshot may hold
      // the same words as CURRENT text (a sentence the amendment left alone).
      bestVersion = await resolveVersion(env, bestId, register_id, text);
      if (bestVersion?.matched_version !== "superseded") break;
    }
  }
  if (!best) best = { outcome: "not_found", coverage: 0, unsupported: [] };
  // Batch 11 (stress6 C21 N8): a running head the snapshot carries mid-list ("30 Days; II.
  // ORIGINATION THROUGH POST-CLOSING/ENDORSEMENT ... Handbook 4000.1 211 Last Revised:
  // 8/12/2026 one or more late payments") made a quote contiguous in the SERVED text read
  // `composed` (the owner's probe blamed the double space before the bullet). When a stored
  // obligation on a checked snapshot holds the quote contiguously, the match is normalized
  // with furniture_ignored -- the served text is the source minus its page furniture.
  if ((best.outcome === "composed" || best.outcome === "not_found") && !best.segments_out_of_order) {
    for (const id of checked) {
      const hits = [...await containingObligations(env, id, text),
        ...(stripListMarkers(text) !== text ? await containingObligations(env, id, stripListMarkers(text)) : [])];
      const h = hits.find((x) => !register_id || x.register_id === register_id);
      if (h) {
        best = { outcome: "normalized", coverage: 1, furniture_ignored: true, stored_text_match: true };
        bestId = id; bestVersion = undefined;
        break;
      }
    }
  }
  if (best.outcome === "normalized" || (best.outcome === "exact" && TYPO_CHARS.test(String(text)))) {
    const exact = await typographyExact(env, bestId, text);
    // Batch 11 (stress6 C21 N10): the only difference is list glyphs the quote left out.
    if (exact === "glyphs") {
      best = { ...best, outcome: "normalized", list_markers_ignored: true };
      delete best.typography_folded;
    } else {
      // Batch 8 (stress6 C21): a match that ignored furniture, spacing or list markers stays
      // "normalized" -- the flags say the text is not character-for-character the source.
      const folded = best.furniture_ignored || best.spacing_ignored || best.list_markers_ignored;
      if (exact && best.outcome === "normalized" && !folded) best = { ...best, outcome: "exact" };
      else if (!exact && best.outcome === "exact") best = { ...best, outcome: "normalized", typography_folded: true };
    }
  }
  const checkedOut = await checkedFields(env, checked);
  // `omissions` / `unsupported` are verbatim text; `note` is editorial. Separate fields.
  const out = { ...best, ...checkedOut, note: NOTES[best.outcome] };
  if (bestId && best.outcome !== "not_found") out.matched_against = checkedOut.checked_against[checked.indexOf(bestId)];
  if (best.segments_out_of_order) {
    out.note += " Every segment between the ellipses IS in the source, but not in the order " +
      "given (segments found out of order): `source_order` lists the segment numbers in source " +
      "order. Reorder them and check again.";
  }
  if (best.furniture_ignored) {
    out.note += " A page footer or running head in the source (e.g. \"Published May 6, 2026 " +
      "444\") was ignored: the served text does not carry it.";
  }
  if (best.list_markers_ignored) {
    out.note += " List markers at line starts (\"- \", \"1. \", \"(a) \") are not in the " +
      "source and were ignored: the regulator runs this list into the sentence. Quote it " +
      "without the markers, or say the list layout is yours.";
  }
  if (best.spacing_ignored) {
    out.note += " Only spacing differs: the stored source splits or joins words here (an " +
      "extraction artifact such as \"holi days\" or \"mustsubmit\"); letters, digits, " +
      "punctuation and case match exactly.";
  }
  if (best.outcome === "not_found" && bestSnapshot) {
    const differences = tokenDiff(text, bestSnapshot);
    if (differences && (differences.missing_from_quote.length || differences.extra_in_quote.length)) {
      out.differences = differences;
      out.note = `${out.note} It is close to a source passage (\`differences.closest_source\`) ` +
        "but not the same: `missing_from_quote` lists source words the text lacks and " +
        "`extra_in_quote` words it adds. A dropped or added word (for example 'not') can " +
        "reverse the meaning.";
    }
  }
  if (best.outcome === "not_found" || !bestId) return out;

  if (bestVersion === undefined) {
    bestVersion = await resolveVersion(env, bestId, register_id,
      best.outcome === "exact" || best.outcome === "normalized" ? text : null);
  }
  // stress6 C03/C20 (R19): a Mortgagee Letter's condition that the Update 18 revision also
  // carries matched only the handbook (the letter's obligations are split and do not hold
  // the whole list), and was labeled update-18-optional. Without register_id, when the
  // matched obligation carries an obligation_currency row linking a current issuance that
  // amended it, that issuance's source is checked too; a contiguous match there wins.
  if (!register_id && bestVersion?.matched_version !== "superseded" && bestVersion?.matched_obligation_id &&
      (best.outcome === "exact" || best.outcome === "normalized")) {
    const alt = await linkedIssuanceMatch(env, bestVersion.matched_obligation_id, text, checked);
    if (alt) {
      checked.push(alt.id);
      const co = await checkedFields(env, checked);
      return { ...alt.r, ...co, matched_against: co.checked_against[checked.length - 1],
        matched_version: "current", matched_register_id: alt.register_id,
        also_in_obligation_id: bestVersion.matched_obligation_id,
        note: `${NOTES[alt.r.outcome]} Matched in ${alt.register_id}, which amended the section ` +
          `(obligation ${bestVersion.matched_obligation_id}) that also carries this text.` };
    }
  }
  if (bestVersion?.matched_version !== "superseded" &&
      (best.outcome === "exact" || best.outcome === "normalized")) {
    const verdict = versionVerdict(await versionHits(env, text, register_id), bestId);
    if (verdict) {
      const { note, ...fields } = verdict;
      return { ...out, ...bestVersion, ...fields, note: `${note} ${out.note}` };
    }
  }
  if (bestVersion?.matched_version === "superseded") {
    // The same outcome from a current snapshot wins: the text is current as well.
    for (const { id, r } of results) {
      if (id === bestId || RANK[r.outcome] !== RANK[best.outcome]) continue;
      const v = await resolveVersion(env, id, register_id,
        r.outcome === "exact" || r.outcome === "normalized" ? text : null);
      if (v?.matched_version === "current") {
        return { ...r, ...checkedOut, matched_against: checkedOut.checked_against[checked.indexOf(id)],
          note: NOTES[r.outcome], ...v };
      }
    }
    return { ...out, ...bestVersion, note: `${supersededNote(bestVersion)} ${out.note}` };
  }
  return bestVersion ? { ...out, ...bestVersion } : out;
}

export function registerVerifyTools(server, env) {
  server.registerTool(
    "verify_quote",
    {
      description:
        "Checks whether a passage appears in a regulator's source document; accepts text " +
        "from any source. Inputs: `text` (up to 5,000 words); optional `register_id` (without " +
        "it, up to 3 candidate documents are located by search). `outcome` is one of: exact " +
        "(contiguous in the source, quote marks and dashes as the source writes them; a line " +
        "break counts as a space); normalized (matches after folding quote and dash " +
        "typography, `typography_folded`; ignoring page footers or running heads, " +
        "`furniture_ignored`; spacing where the stored source splits or joins words, " +
        "`spacing_ignored`; or added list markers, `list_markers_ignored`); composed (every " +
        "word is in the source, in source order, but from non-contiguous pieces, as with an " +
        "overview or an ellipsis; `omissions` lists the short source phrases skipped between " +
        "pieces); not_found (no source support; `unsupported` lists the unsupported spans, and " +
        "on a near miss `differences` gives the closest source text, the source words the " +
        "text lacks and the words it adds); not_checked (over 5,000 words). `coverage` is the " +
        "share of words found. `checked_against` names the documents checked (document, " +
        "edition, retrieval date; ids in `checked_snapshot_ids`); `matched_against` names the " +
        "one matched, `matched_register_id` / `matched_obligation_id` the stored text " +
        "containing the passage. `matched_version` is " +
        "current; superseded (the text is a prior version of the rule; `superseded_by` is " +
        "the current register); or update-18-optional (HUD's Update 18 revision of an FHA " +
        "4000.1 section, optional until `mandatory_date`; `in_force_obligation_id` is the " +
        "text in force by default). `obligation_currency` lists currency signals on the " +
        "obligation holding the text (e.g. superseded-in-part). `rescinded: true` (with " +
        "`rescinded_by`) means the passage is text a later issuance removed or replaced.",
      inputSchema: { text: z.string().min(1), register_id: z.string().optional() },
    },
    async ({ text, register_id }) => ({
      content: [{ type: "text", text: JSON.stringify(await withMatchedSourceUrl(env, await verifyQuote(env, { text, register_id }))) }],
    }),
  );
}
