// JS port of normalize_for_match() from
// broker-tools/marketplace/regulation_library/source_snapshot.py:360
//
// MATCHING ONLY — never for storage or display. Always keep the original
// verbatim text for those.
//
// Order matters and mirrors the Python exactly: NFKC, then the fold table,
// then whitespace collapse. NFKC already handles ligatures and non-breaking
// spaces, so the fold table only covers quotes, dashes and bullet glyphs.

const FOLD = new Map(Object.entries({
  "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'", "\u2032": "'",
  "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u201f": '"', "\u2033": '"',
  "\u2013": "-", "\u2014": "-", "\u2012": "-", "\u2011": "-", "\u2212": "-",
  "\u2022": " ", "\u2023": " ", "\u2043": " ", "\u25a0": " ", "\u25a1": " ",
  "\u25aa": " ", "\u25ab": " ", "\u25cf": " ", "\u25cb": " ", "\u25e6": " ",
  "\u00b7": " ",
}));

// Complete Python str.isspace() character set. This is the union of all codepoints where
// Python's \s matches AND NFKC leaves unchanged (i.e., they actually reach the collapse step).
// Includes: ASCII whitespace + Python-specific (\u001c-\u001f, \u0085) + Unicode spaces
// (\u00a0, \u1680, \u2000-\u200a, \u2028, \u2029, \u202f, \u205f, \u3000).
// Explicitly excludes \ufeff (BOM), which JS treats as whitespace but Python does not.
const WS = /[\t\n\v\f\r \u001c-\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;

export function normalizeForMatch(s) {
  if (s === null || s === undefined) return "";
  let out = String(s).normalize("NFKC");
  out = Array.from(out, (ch) => FOLD.get(ch) ?? ch).join("");
  out = out.replace(WS, " ");
  // Trim using the same whitespace class to preserve BOM (U+FEFF is not in WS)
  out = out.replace(/^[\t\n\v\f\r \u001c-\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/, "");
  out = out.replace(/[\t\n\v\f\r \u001c-\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/, "");
  return out;
}

export default normalizeForMatch;
