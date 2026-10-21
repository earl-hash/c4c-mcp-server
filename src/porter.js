// The Porter (1980) stemmer, the algorithm FTS5's `porter` tokenizer applies to the
// corpus (obligations_fts: tokenize = 'porter unicode61').
//
// Why here: search.js ranks by how well a SECTION'S OWN TITLE fits the query (titlefit.js).
// That comparison runs in JS on titles already fetched, and it must stem the way FTS5 does
// or "eligibility" (FTS: "elig") would not meet "eligible" (FTS: "elig") while the body-text
// match did. subject.js keeps its own cruder stemmer for its SQL LIKE prefilter, where a
// stem must stay a prefix of the word.
//
// Lower-case ASCII words only; anything else (digits, non-ASCII) is returned unchanged.

const isCons = (w, i) => {
  const c = w[i];
  if ("aeiou".includes(c)) return false;
  if (c === "y") return i === 0 ? true : !isCons(w, i - 1);
  return true;
};

// m(): the number of VC sequences in w[0..j].
function measure(w) {
  let n = 0;
  let i = 0;
  const len = w.length;
  while (i < len && isCons(w, i)) i++;
  while (i < len) {
    while (i < len && !isCons(w, i)) i++;
    if (i >= len) break;
    n++;
    while (i < len && isCons(w, i)) i++;
  }
  return n;
}

const hasVowel = (w) => {
  for (let i = 0; i < w.length; i++) if (!isCons(w, i)) return true;
  return false;
};

const doubleCons = (w) => w.length >= 2 && w[w.length - 1] === w[w.length - 2] && isCons(w, w.length - 1);

// cvc: consonant-vowel-consonant ending, the last not w, x or y.
const cvc = (w) => {
  const n = w.length;
  if (n < 3) return false;
  if (!isCons(w, n - 1) || isCons(w, n - 2) || !isCons(w, n - 3)) return false;
  return !"wxy".includes(w[n - 1]);
};

function replaceIf(w, suffix, repl, cond) {
  if (!w.endsWith(suffix)) return null;
  const stem = w.slice(0, w.length - suffix.length);
  return cond(stem) ? stem + repl : w;
}

const STEP2 = [
  ["ational", "ate"], ["tional", "tion"], ["enci", "ence"], ["anci", "ance"], ["izer", "ize"],
  ["bli", "ble"], ["alli", "al"], ["entli", "ent"], ["eli", "e"], ["ousli", "ous"],
  ["ization", "ize"], ["ation", "ate"], ["ator", "ate"], ["alism", "al"], ["iveness", "ive"],
  ["fulness", "ful"], ["ousness", "ous"], ["aliti", "al"], ["iviti", "ive"], ["biliti", "ble"],
  ["logi", "log"],
];
const STEP3 = [
  ["icate", "ic"], ["ative", ""], ["alize", "al"], ["iciti", "ic"], ["ical", "ic"], ["ful", ""],
  ["ness", ""],
];
const STEP4 = [
  "al", "ance", "ence", "er", "ic", "able", "ible", "ant", "ement", "ment", "ent", "ion", "ou",
  "ism", "ate", "iti", "ous", "ive", "ize",
];

export function porter(word) {
  let w = String(word ?? "").toLowerCase();
  if (w.length <= 2 || !/^[a-z]+$/.test(w)) return w;

  // Step 1a
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies")) w = w.slice(0, -2);
  else if (w.endsWith("ss")) { /* keep */ } else if (w.endsWith("s")) w = w.slice(0, -1);

  // Step 1b
  let extra = false;
  if (w.endsWith("eed")) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
  } else if (w.endsWith("ed") && hasVowel(w.slice(0, -2))) {
    w = w.slice(0, -2); extra = true;
  } else if (w.endsWith("ing") && hasVowel(w.slice(0, -3))) {
    w = w.slice(0, -3); extra = true;
  }
  if (extra) {
    if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) w += "e";
    else if (doubleCons(w) && !"lsz".includes(w[w.length - 1])) w = w.slice(0, -1);
    else if (measure(w) === 1 && cvc(w)) w += "e";
  }

  // Step 1c
  if (w.endsWith("y") && hasVowel(w.slice(0, -1))) w = w.slice(0, -1) + "i";

  // Step 2
  for (const [suf, rep] of STEP2) {
    if (w.endsWith(suf)) {
      w = replaceIf(w, suf, rep, (s) => measure(s) > 0);
      break;
    }
  }
  // Step 3
  for (const [suf, rep] of STEP3) {
    if (w.endsWith(suf)) {
      w = replaceIf(w, suf, rep, (s) => measure(s) > 0);
      break;
    }
  }
  // Step 4 (longest matching suffix)
  for (const suf of [...STEP4].sort((a, b) => b.length - a.length)) {
    if (!w.endsWith(suf)) continue;
    const s = w.slice(0, -suf.length);
    if (measure(s) > 1 && (suf !== "ion" || /[st]$/.test(s))) w = s;
    break;
  }
  // Step 5a
  if (w.endsWith("e")) {
    const s = w.slice(0, -1);
    const m = measure(s);
    if (m > 1 || (m === 1 && !cvc(s))) w = s;
  }
  // Step 5b
  if (measure(w) > 1 && doubleCons(w) && w.endsWith("l")) w = w.slice(0, -1);
  return w;
}
