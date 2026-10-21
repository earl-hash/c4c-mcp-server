import { z } from "zod";
import { pageUrl } from "../sourceurl.js";
import { groupTokens, bindStructure } from "../vocab.js";
import { extractAgencies, familyFilterSql } from "../agency.js";
import {
  CURRENCY_COLUMNS_BRIEF, currencyJoin, currencyOf, withoutCurrency,
  fetchObligationCurrency, withObligationCurrency, isStale, CURRENCY_KINDS,
} from "../currency.js";
import { collapseCopies } from "../aliases.js";
import { companionTargets, refObligationId } from "../statutes.js";
import { isGenericQuery, listByCurrency } from "../currency-list.js";
import { dualVersionIds, fetchVersions, versionBrief, VERSION_SUFFIX } from "../versions.js";
import { subjectPrefilter, titleCoverage, unnamedProgram } from "../subject.js";
import { canonicalCitation } from "../canonical.js";
import { shortTitle, titleCoverage2, titleFit, parentHeading, TITLE_IGNORE } from "../titlefit.js";
import { parseHandbook } from "../citation.js";
import { porter } from "../porter.js";
import { stripScaffold, SCAFFOLD_WORDS, FORGIVE_MIN_SHARE, FORGIVE_MIN_GROUPS, FORGIVE_POOL,
  mustHold, groupWeights, coverageSql, weightedShare, popcount, sectionMaskSql, sectionPairs,
  FORGIVE_PAIR_POOL } from "../forgiving.js";
import { VOCAB } from "../vocab.js";
import { resolveCitation, handbookOverview } from "./get.js";
import { withInlineText, withSearchDigest, INLINE_NOTE } from "../inline.js";

// bm25() in SQLite returns a NEGATIVE number where more negative is a better
// match, so we negate it. MIN_SCORE is the refusal threshold from spec 5.4.
//
// Calibrated in Task 9b (2026-09-25, local D1, 8,263 obligations) under the
// adopted query (AND over content terms, below). There is NO clean score
// separation, so the threshold is set to keep recall and the refusal work is
// done by AND semantics instead:
//   - 50 panel questions: top scores 10.8 .. 40.2 (49 answered, 1 no_match).
//   - 17 off-corpus questions: 14 return ZERO FTS rows (refused as no_match);
//     3 leak with top scores 2.9 (Medicare Part D penalty), 7.9 (student loan
//     forgiveness) and 20.6 (federal income tax return -- the corpus does cover
//     tax-return documentation). Leak rate 3/17 = 18% at any MIN_SCORE <= 2.9.
//   - Short legitimate queries score BELOW the panel range because bm25 sums
//     per term: "mortgage insurance" 3.6, "appraisal" 4.1, "escrow" 5.6,
//     "flood insurance" 9.1. A threshold that refused the 7.9 leak (~9) would
//     refuse these, so it would not generalize past the 3+-term panel.
//   - The only sub-1 score seen was a lone ultra-common word ("loan" 0.1).
// 0.5 therefore stays: it drops degenerate single-common-word matches and
// nothing else observed. bm25 is not comparable across queries of different
// lengths; do not raise this from one query's number.
export const MIN_SCORE = 0.5;

// FTS5 MATCH syntax characters. A user query is DATA, never syntax -- every
// token is wrapped in double quotes so operators cannot leak through.
//
// A metacharacter is replaced by a SPACE, splitting the token. It is never deleted
// in place: deletion fused words the corpus does not contain ("debt-to-income" ->
// "debttoincome", "5307.1(b)" -> "5307.1b") and was 5 of 6 zero-result panel
// questions in Task 9. Tokens with no letter or digit are dropped (a quoted "/"
// is an empty phrase). "." is kept inside a token: the tokenizer already splits
// it, and quoting keeps "5307.1" an adjacent phrase rather than two loose words.
// Leading/trailing punctuation is trimmed ("requirements?" must still hit the
// stopword list; the tokenizer would discard it anyway).
// Control characters too (security review 2026-10-12: a NUL survived and surfaced a raw
// SQLite "unterminated string" error to the client).
const FTS_META = /["*^\-:()+{},\u0000-\u001f]/g;
const EDGE_PUNCT = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

// A possessive "'s" is dropped: the tokenizer would split "borrower's" into the phrase
// "borrower s", which matches only the possessive and failed "co-borrower's income".
const POSSESSIVE = /['\u2019]s$/i;

// A thousands separator joins its number into ONE token (Round 4, stress3 RANK-06:
// "more than $10,000" became the loose words "10" and "000"). "10,000" -> "10_000": the
// underscore is not FTS syntax, and inside the quoted token FTS5 reads "10_000" as the
// adjacent phrase "10 000" -- exactly how the tokenizer indexed "$10,000".
const THOUSANDS = /(\d),(?=\d{3}(?!\d))/g;

// Caps (security review 2026-10-12): every token can cost an FTS5 query, and one giant
// dotted token ("4.a.4.a....") is matched as a phrase whose cost grows faster than its length.
// No real question has 48 words or a 64-character word.
export const MAX_FTS_TOKENS = 48;
export const MAX_FTS_TOKEN_CHARS = 64;

export function ftsTokens(query) {
  return String(query ?? "")
    .replace(THOUSANDS, "$1_")
    .replace(FTS_META, " ")
    .split(/\s+/)
    .map((t) => t.replace(EDGE_PUNCT, "").replace(POSSESSIVE, "").replace(EDGE_PUNCT, ""))
    .filter(Boolean)
    .slice(0, MAX_FTS_TOKENS)
    .map((t) => (t.length > MAX_FTS_TOKEN_CHARS ? t.slice(0, MAX_FTS_TOKEN_CHARS) : t));
}

export function escapeFts(query) {
  return ftsTokens(query).map((t) => `"${t}"`).join(" ");
}

// Words that carry no retrieval signal: generic English plus question filler.
// Under AND every query word must appear, so "what are the ... requirements for"
// favoured giant overview pages that happen to contain all of them. Domain terms
// (FHA, VA, LTV, gift, income, loan ...) are deliberately NOT here. Compared
// lower-case; porter stemming means "requirement"/"requirements" are listed
// together only for readability.
export const STOPWORDS = new Set(`
  a an the and or but nor of for to in on at by with from as into onto over under
  about than then so if is are was were be been being am do does did done doing
  what which who whom whose when where why how this that these those there here
  it its i me my we us our you your he she his her they them their
  can could should would will shall may might must also any all some such each
  other more most very just only not no yes vs versus per via etc
  has have had having get gets getting got know tell explain please regarding
  require requires required requirement requirements rule rules guideline
  guidelines guidance need needs needed
  someone somebody anyone anybody use using want wants
`.split(/\s+/).filter(Boolean));

// "how long / how much / how many / how soon / how often": the second word is question
// filler only after "how" -- "long-term debt" keeps "long".
const AFTER_HOW = new Set(["long", "much", "many", "soon", "often"]);

// Query tokens minus stopwords, lower-cased (FTS5 unicode61 folds case anyway)
// and de-duplicated, in query order.
// Batch 13 (eval B15/G18): "QRPC definition", "qualified mortgage definition", "what does
// successor in interest mean" -- the definition words say WHAT KIND of answer is wanted, not
// a word the text must hold ("definition" failed the AND for QRPC; it pulled Reg X/P
// "Definitions" sections over 12 CFR 1026.43(e)). Dropped when other content words remain.
export const DEFINE_WORDS = new Set(["definition", "definitions", "define", "defined", "defines",
  "defining", "meaning", "means", "mean", "meant"]);
export function contentTokens(query) {
  const toks = contentTokensRaw(query);
  const rest = toks.filter((t) => !DEFINE_WORDS.has(t));
  return rest.length ? rest : toks;
}
function contentTokensRaw(query) {
  const all = ftsTokens(query).map((t) => t.toLowerCase());
  // Batch 8 (stress6 C09 N13): "25 percent" is "25%" in the text, which the tokenizer indexes as
  // "25" -- a "percent" after a number is the number's unit, not a word to require.
  const toks = all.filter(
    // Batch 18: "no credit score" is a borrower kind (src/vocab.js: nontraditional credit).
    (t, i) => (!STOPWORDS.has(t) || (t === "no" && all[i + 1] === "credit" && /^scores?$/.test(all[i + 2] ?? ""))) &&
      !(i > 0 && all[i - 1] === "how" && AFTER_HOW.has(t)) &&
      !(i > 0 && /^(?:percent|pct)$/.test(t) && /^\d+(?:\.\d+)?$/.test(all[i - 1])),
  );
  return [...new Set(toks)];
}

// search_regs: every CONTENT term must appear (implicit AND), each quoted.
// Adopted in Task 9b over OR and AND->OR fallback: best golden-set accuracy
// (34/50 EXACT vs 33 OR, 26 AND->OR, 24 plain AND) and the only form that
// still refuses off-corpus questions, because OR matches some obligation for
// almost any English sentence (16/17 off-corpus questions returned rows).
export function buildAndQuery(query) {
  return contentTokens(query).map((t) => `"${t}"`).join(" ");
}

// A fixed phrase (a vocab alternative) as one quoted FTS phrase, escaped exactly like
// user input: metacharacters split, nothing survives as syntax.
export function quotePhrase(text) {
  const toks = ftsTokens(text);
  return toks.length ? `"${toks.join(" ")}"` : "";
}

// One vocab group as FTS: the user's own terms ANDed (or, for a PHRASES entry such as
// "w 2", one adjacent phrase), OR each regulator phrase.
// Batch 10 (stress6 C06 R22): a multi-word VOCABULARY key names one concept ("appraisal
// independence"), so its words must stand within KEY_NEAR tokens of each other, not anywhere in
// a 4,900-character text: 12 CFR 1026.42(f), the fee rule, matched "appraisal ... independent
// third parties" and ranked 8x over the rest of the section.
export const KEY_NEAR = 3;
function renderGroup({ tokens, alts, phrase }) {
  const own = phrase ? [quotePhrase(tokens.join(" "))] : tokens.map((t) => `"${t}"`);
  const phrases = alts.map(quotePhrase).filter(Boolean);
  const near = !phrase && own.length > 1 && phrases.length ? `NEAR(${own.join(" ")}, ${KEY_NEAR})` : null;
  if (!phrases.length) return own.length > 1 ? `(${own.join(" AND ")})` : own[0];
  const mine = near ?? (own.length > 1 ? `(${own.join(" AND ")})` : own[0]);
  return `(${[mine, ...phrases].join(" OR ")})`;
}

// search_regs MATCH: AND over content terms, each vocab-mapped term an OR group
// (src/vocab.js). Explicit AND: FTS5 rejects implicit AND next to a parenthesis.
export function buildMatch(tokens) {
  return groupTokens(tokens).map(renderGroup).join(" AND ");
}

// OR over the content terms. For candidate lookup (verify_quote), where a long
// passage must find its source even if a word or two differs; bm25 rewards
// documents matching more and rarer terms, so full coverage still ranks first.
export function buildOrQuery(query) {
  return contentTokens(query).map((t) => `"${t}"`).join(" OR ");
}

export function applyThreshold(rows, minScore = MIN_SCORE) {
  return (rows ?? []).filter((r) => (r.score ?? 0) >= minScore);
}

// bm25 column weights, in obligations_fts column order: section (the regulator's own
// title), authority, verbatim. At 100 a title match decides the order and body text
// only breaks ties: a query for "debt-to-income ratios" should rank B3-6-02
// "Debt-to-Income Ratios" over a special-program page that mentions a DTI cap in its
// text. The regulator's title is the most reliable statement of what a section is
// about. Measured 2026-09-25 on the query replay + golden set, sweeping 1..100 x
// section: top-5 rose at every step with no query lost; top-10 is flat above 10
// (the weight reorders the top ten, it does not change membership). MIN_SCORE above
// was calibrated at 1/1/1 -- weights >= 1 only raise scores, so it refuses no more.
export const BM25_WEIGHTS = [100, 1, 1];

// AMENDED 2026-09-24 after Task 2 shipped `obligations_fts` as an EXTERNAL-CONTENT
// FTS5 table (content='obligations'). The original query in this plan used an `f`
// alias and joined on `f.obligation_id`; verified live, that fails with
// `no such column: f.obligation_id [code: 7500]` -- an external-content table exposes
// no such column. Join on rowid instead, and note the snippet() column index shifts
// from 3 to 2 because `verbatim` is now column 2. This SQL was run against the live
// database and returns correct ids and bracketed snippets.
//
// `excerpt` (was the bracketed `why`): the regulator's text around the best match,
// VERBATIM -- no highlight markup, "..." only where the fragment is cut. It is the
// regulator's words, so it must never carry anything of ours (envelope rule 1).
//
// canonical_id + text_key (2026-09-26) let collapseCopies (src/aliases.js) drop same-text
// copies of one section: without them the three identical II.A.8.d registers took three
// result slots. text_key is the normalized text's length plus its first 200 chars, which
// tells a canonical register's several obligations apart. chars_total is the served
// text's length (see envelope.js buildEnvelope), not the build-time count.
// COVERAGE (2026-09-26): each candidate also carries two bitmasks over the query's groups
// -- cov_mask (bit i set: group i matches anywhere in the obligation) and title_mask (group
// i matches the section title) -- computed by FTS5 itself (same tokenizer, same stemming)
// on the top candidates only, so a partial row names exactly which terms it lacks and the
// ranking can reward a title that states the question. Binds: ?1 MATCH, ?2 family,
// ?3 limit, then one per group (body), then the same groups filtered to the section title.
export const MAX_COVERAGE_GROUPS = 10;
// Step 6 exemption: an all-terms row this short, for a query of at least this many groups,
// is a real match even when its title names no query word.
export const DENSE_MAX_CHARS = 1500;
export const DENSE_MIN_GROUPS = 3;

// Optional filters (2026-09-26), bound after the coverage groups:
//   currencyKind  C4C-11: only rows whose register OR obligation currency is this kind
//                 ("any": any currency signal). An over-match (register-level kind replaced
//                 by an obligation-level one) is removed after obligation currency is read.
//   registers     only these register ids (the subject-register fetch, src/subject.js).
// r.authority (the REGISTER title) is selected as register_title: a statute's obligations
// are titled by citation only, its subject lives there (src/subject.js).
//   phrase        Round 4: one more MATCH (the query's content words as ONE adjacent phrase),
//                 selected as phrase_hit -- "fnma cash remittance system" should prefer the
//                 section that says "Cash Remittance System" over one with the three words
//                 scattered. Bound after the filters above.
// Round 4 also selects r.superseded_by (superseded text ranks below its replacement) and,
// for short obligations only, the text itself as stub_text (a "Section 6302.39 is deleted."
// stub is recognized and ranked last; see deletedStub).
// Batch 5: the first LEAD_CHARS of each candidate's text -- a CFR paragraph's own heading
// (paragraphTitle) and a Fannie topic's list of subheadings (subheadList).
export const LEAD_CHARS = 700;

export function searchSql(nGroups, { currencyKind = false, registers = false, phrase = false, guards = [] } = {}) {
  const n = Math.min(nGroups, MAX_COVERAGE_GROUPS);
  // Uncorrelated IN: SQLite materializes each group's rowid set once, instead of re-running
  // the MATCH per candidate row (measured locally: median search 212 ms -> see commit).
  const bit = (param, i) =>
    `(hits.rid IN (SELECT rowid FROM obligations_fts WHERE obligations_fts MATCH ?${param})) ` +
    `* ${2 ** i}`;
  const body = Array.from({ length: n }, (_, i) => bit(4 + i, i)).join(" + ") || "0";
  const title = Array.from({ length: n }, (_, i) => bit(4 + n + i, i)).join(" + ") || "0";
  let next = 4 + 2 * n;
  const extra = [];
  if (currencyKind) {
    const k = next++;
    extra.push(`AND (CASE WHEN ?${k} = 'any' THEN (c.kind IS NOT NULL OR o.obligation_id IN ` +
      "(SELECT obligation_id FROM obligation_currency)) ELSE (c.kind = ?" + k +
      ` OR o.obligation_id IN (SELECT obligation_id FROM obligation_currency WHERE kind = ?${k})) END)`);
  }
  if (registers) extra.push(`AND o.register_id IN (SELECT value FROM json_each(?${next++}))`);
  const phraseCol = phrase
    ? `, (hits.rid IN (SELECT rowid FROM obligations_fts WHERE obligations_fts MATCH ?${next++})) AS phrase_hit`
    : "";
  // Batch 8 (C09): one literal check per guarded group (literalGuards), each variant a GLOB.
  const guardCols = guards.map(({ i, variants }) => {
    const ors = variants.map(() => `t.txt GLOB ?${next++}`).join(" OR ");
    return `, (SELECT ${ors} FROM (SELECT ' ' || lower(o2.section || ' ' || o2.verbatim) || ' ' AS txt ` +
      `FROM obligations o2 WHERE o2.rowid = hits.rid) t) AS lit_${i}`;
  }).join("");
  return `
  WITH hits AS (
    SELECT o.rowid AS rid, o.obligation_id, o.register_id, o.section, o.authority, o.source_url,
           r.family, length(o.verbatim) AS chars_total,
           -bm25(obligations_fts, ${BM25_WEIGHTS.join(", ")}) AS score,
           snippet(obligations_fts, 2, '', '', '...', 48) AS excerpt, ${CURRENCY_COLUMNS_BRIEF},
           COALESCE(al.canonical_id, o.register_id) AS canonical_id,
           length(o.verbatim_norm) || ':' || substr(o.verbatim_norm, 1, 200) AS text_key,
           r.authority AS register_title, r.superseded_by AS superseded_by, r.coverage_tier AS coverage_tier,
           CASE WHEN length(o.verbatim) < ${STUB_MAX_CHARS} THEN o.verbatim END AS stub_text,
           substr(o.verbatim, 1, ${LEAD_CHARS}) AS lead_text
    FROM obligations_fts
    JOIN obligations o ON o.rowid = obligations_fts.rowid
    JOIN registers  r ON r.register_id = o.register_id
    ${currencyJoin("o.register_id")}
    LEFT JOIN aliases al ON al.register_id = o.register_id
    WHERE obligations_fts MATCH ?1 AND ${familyFilterSql(2)} ${extra.join(" ")}
    ORDER BY score DESC LIMIT ?3)
  SELECT hits.*, ${body} AS cov_mask, ${title} AS title_mask${phraseCol}${guardCols}
  FROM hits ORDER BY score DESC`;
}

// DELETED STUBS (Round 4, stress3 RANK-02): Freddie keeps a numbered section after deleting
// it, as one sentence -- "Effective October 15, 2018, Section 6302.39 is deleted." Fifty
// characters that repeat the query's title words top any bm25 ranking, so "special servicing
// requirements" returned five of them. A stub is recognized by that sentence in a short
// obligation; it ranks x DELETED_FACTOR and carries `section_status` ("deleted", or
// "deletion-pending" while its effective date is in the future).
export const STUB_MAX_CHARS = 400;
export const DELETED_FACTOR = 0.1;
const DELETED_RE = /\b(?:Section|Chapter|this section|this chapter)\s*(?:\d[\d.]*\s+)?is deleted\b/i;
const EFFECTIVE_RE = new RegExp(
  `\\bEffective\\s+(?:for[^,]*?on or after\\s+)?((?:${"January|February|March|April|May|June|July|August|September|October|November|December"})\\s+\\d{1,2},\\s*\\d{4})`,
  "i",
);

export function deletedStub(text, today = new Date()) {
  const t = String(text ?? "");
  if (!t || t.length >= STUB_MAX_CHARS || !DELETED_RE.test(t)) return null;
  const m = t.match(EFFECTIVE_RE);
  const when = m ? new Date(`${m[1]} UTC`) : null;
  const date = when && !Number.isNaN(when.getTime()) ? when.toISOString().slice(0, 10) : null;
  const pending = date && date > today.toISOString().slice(0, 10);
  return { section_status: pending ? "deletion-pending" : "deleted", ...(date ? { section_status_date: date } : {}) };
}

// Extra rows fetched so that dropping same-text copies still leaves `limit` results.
const COPY_SLACK = 5;
// Both queries fetch this many candidates per result slot: enough that a partial match
// with a better combined score than the last strict row -- or a current row below a
// demoted stale one -- is seen.
const RELAXED_FACTOR = 3;
// search_regs' largest `limit` (inputSchema max): the candidate pool is sized for it always.
export const MAX_LIMIT = 25;

// No-match guidance (C4C-03, 2026-09-26). The old text ("The corpus does not address
// this") turned a vocabulary miss into a confident wrong answer: "RSU income" came back
// empty and the model told the user Fannie Mae does not address RSU income. The guidance
// now asks for one retry in the regulator's own words first, naming any unexpanded
// shorthand in the query, and only then for the "not addressed" answer.
function refusalGuidance(query, groups) {
  const expanded = new Set(groups.filter((g) => g.alts.length).flatMap((g) => g.tokens));
  const shorthand = [...new Set(ftsTokens(query)
    .filter((t) => /^[A-Z][A-Z0-9&/]{1,6}s?$/.test(t) && !expanded.has(t.toLowerCase()))
    .filter((t) => !extractAgencies([t.toLowerCase()]).families.size))];
  const what = shorthand.length
    ? `the regulator's term for ${shorthand.map((t) => `"${t}"`).join(", ")} (spelled out)`
    : "the regulator's term for the concept (e.g. \"debt-to-income ratio\", \"restricted stock units\")";
  return `No section matched these words. Try ${what}; if a search in the regulator's own ` +
    "words is still empty, say the corpus does not address it rather than answering from memory.";
}

// filters: { currencyKind, registers } -- see searchSql.
async function runMatch(env, match, family, limit, groupMatches = [], filters = {}) {
  if (!match) return [];
  const g = groupMatches.slice(0, MAX_COVERAGE_GROUPS);
  const titles = g.map((m) => `section : (${m})`);
  const extra = [];
  if (filters.currencyKind) extra.push(filters.currencyKind);
  if (filters.registers) extra.push(JSON.stringify(filters.registers));
  if (filters.phrase) extra.push(filters.phrase);
  const guards = filters.guards ?? [];
  for (const { variants } of guards) extra.push(...variants.map(globFor));
  const sql = searchSql(g.length, {
    currencyKind: Boolean(filters.currencyKind), registers: Boolean(filters.registers),
    phrase: Boolean(filters.phrase), guards,
  });
  const { results } = await env.CORPUS.prepare(sql)
    .bind(match, family ?? "", limit, ...g, ...titles, ...extra).all();
  return applyGuards(results ?? [], guards);
}

// LITERAL GUARDS (batch 8, stress6 C09): FTS5's porter stemmer folds a short acronym's final "s"
// ("CRS" -> "cr", "IRS" -> "ir"), so "fnma CRS" matched "Confirmed CR BK" in B3-5.3-09. A
// query token that is an acronym the stemmer changes -- typed in capitals, or a vocabulary key --
// must appear LITERALLY (as a word) or through one of its vocabulary phrases; a row that matched
// it only through the stem loses that group's coverage bit (and so its all-terms status).
export function literalGuards(query, groups) {
  const caps = new Set(ftsTokens(query).filter((t) => /^[A-Z]{2,5}$/.test(t)).map((t) => t.toLowerCase()));
  const out = [];
  groups.slice(0, MAX_COVERAGE_GROUPS).forEach((g, i) => {
    if (g.tokens.length !== 1) return;
    const t = g.tokens[0];
    // Only a stem of two letters or fewer: "arms" -> "arm" is a plural, "crs" -> "cr" a collision.
    if (!/^[a-z]{2,5}$/.test(t) || porter(t) === t || porter(t).length > 2) return;
    if (!caps.has(t) && !Object.hasOwn(VOCAB, t)) return;
    out.push({ i, variants: [t, ...g.alts.map((a) => ftsTokens(a).join(" ").toLowerCase()).filter(Boolean)] });
  });
  return out;
}

function globFor(phrase) {
  const esc = String(phrase).replace(/[*?[\]]/g, "");
  return `*[^a-z0-9]${esc}[^a-z0-9]*`;
}

function applyGuards(rows, guards) {
  if (!guards.length) return rows;
  return rows.map((r) => {
    let cov = Number(r.cov_mask ?? 0);
    let title = Number(r.title_mask ?? 0);
    let failed = false;
    for (const { i } of guards) {
      if (Number(r[`lit_${i}`]) === 1) continue;
      cov &= ~(2 ** i);
      title &= ~(2 ** i);
      failed = true;
    }
    return failed ? { ...r, cov_mask: cov, title_mask: title, guard_fail: true } : r;
  });
}

// SUBJECT REGISTERS (C4C-04; src/subject.js): registers whose TITLE names every query
// group, within the family filter. More than SUBJECT_MAX means the words are too generic
// to name a subject ("income" in the Selling Guide) -- no injection then. A failed lookup
// is no subject, never an error: this only adds candidates.
export const SUBJECT_MAX = 30;
const SUBJECT_MAX_GROUPS = 4;

async function subjectRegisters(env, groups, family) {
  if (!groups.length || groups.length > SUBJECT_MAX_GROUPS) return [];
  const pre = subjectPrefilter(groups);
  if (!pre) return [];
  try {
    const { results } = await env.CORPUS.prepare(pre.sql).bind(family ?? "", ...pre.params).all();
    const ids = (results ?? [])
      // Round 4: the register's own short title (src/titlefit.js), not the whole string --
      // a VA topic register's chapter name made every Chapter 12 topic a "subject".
      .filter((r) => r?.register_id &&
        titleCoverage2(shortTitle(r.authority), groups).length === groups.length)
      .map((r) => r.register_id);
    return ids.length <= SUBJECT_MAX ? [...new Set(ids)] : [];
  } catch {
    return [];
  }
}

// Agency names become the family filter and leave the AND (src/agency.js). Only when
// the query names exactly one agency, and the caller's family (if any) agrees; a
// query that is nothing but an agency name keeps its words.
export function resolveAgency(tokens, family) {
  const { tokens: rest, families } = extractAgencies(tokens);
  if (families.size !== 1 || rest.length === 0) return { tokens, family };
  const named = [...families][0];
  if (family && family !== named) return { tokens, family };
  return { tokens: rest, family: named };
}

// RANKING (2026-09-26). The owner's live test: every all-terms row was placed before
// every partial row, so Freddie 5303.3 "Income while on temporary leave" (score 18.3)
// ranked last under weaker all-terms rows, and Fannie B4-2.2-01 "Limited Review Process"
// fell out of the top five. Strict and relaxed candidates are now merged and ranked by
//
//   combined = bm25 (title-weighted, BM25_WEIGHTS) x coverage^COVERAGE_POWER
//              x (1 + TITLE_BOOST x title coverage) x (STALE_FACTOR if stale)
//
// coverage = the share of query groups the row matches; title coverage = the share its
// section title matches. bm25 is comparable between the strict and relaxed queries: both
// are built from the same phrases, and a phrase a row lacks contributes nothing.
// Stale = currency says the text is not the rule in force today (src/currency.js isStale):
// it is demoted, never dropped -- the warning travels with it.
export const COVERAGE_POWER = 2;
export const TITLE_BOOST = 1;
export const STALE_FACTOR = 0.2;

// Batch 9: official commentary ranks directly below the rule it interprets. A per-section
// Supplement I register (reg-z-1026-supplement-i-42 interprets reg-z-1026-42) quotes the
// rule's own words plus the everyday ones ("appraiser"), so it out-scored 12 CFR 1026.42
// itself for "valuation independence appraiser coercion Regulation Z". When both are in the
// results and the query does not ask for the commentary, each commentary row that outranks
// the rule's best row is placed just below it. Mutates `scored` ([{r, s}]).
const COMMENTARY_RE = /^(.+)-supplement-i-(\d+[a-z]?)$/;
const ASKS_COMMENTARY_RE = /\b(comment(?:ary|s)?|interpretations?|supplement|staff|official)\b/i;
// The rule register a commentary row interprets: a per-section Supplement I register names it
// in its id; a multi-section one (reg-z-1026-supplement-i-nontrid, -trid) in each row's section
// string, "Supplement I — Comment 20(c)-2: §1026.20(c) ..." (batch 10, stress6 R8: Comment
// 20(c)-2 ranked above 12 CFR 1026.20(c) for "interest rate resets rate change notices").
const MULTI_COMMENTARY_RE = /^(.+)-supplement-i-[a-z]+$/;
const COMMENT_SECTION_RE = /\bComment\s+(\d+[a-z]?)\(/;
export function commentaryRuleId(r) {
  const id = r?.register_id || "";
  const m = COMMENTARY_RE.exec(id);
  if (m) return `${m[1]}-${m[2]}`;
  const multi = MULTI_COMMENTARY_RE.exec(id);
  const sec = multi && COMMENT_SECTION_RE.exec(r.section || "");
  return sec ? `${multi[1]}-${sec[1]}` : null;
}
export function commentaryBelowRule(scored, query) {
  if (ASKS_COMMENTARY_RE.test(query || "")) return scored;
  const best = new Map();
  for (const x of scored) {
    const s = best.get(x.r.register_id);
    if (s === undefined || x.s > s) best.set(x.r.register_id, x.s);
  }
  for (const x of scored) {
    const ruleId = commentaryRuleId(x.r);
    if (!ruleId) continue;
    const rule = best.get(ruleId);
    if (rule !== undefined && x.s >= rule) x.s = rule - 0.01;
  }
  return scored;
}
// Batch 10 (stress6 C06 R17/R23): lettered paragraphs of ONE section that match the query the
// same way (same terms, same strictness) and score within OUTLINE_TIE of each other are a tie
// the bm25 noise decides -- "civil liability for willful noncompliance FCRA" put 1681n(d)
// (108) and (b) (105) over the operative (a) (98); "currency transaction report filing
// deadline" put 1010.306(b) over (a) by 31.33 to 31.29. Such a tie is read in outline order:
// the rows keep their scores as a set, reassigned so the earlier paragraph gets the higher one.
// Not when the query names a paragraph ("1681n(d)"). Mutates `scored` ([{r, s}]).
export const OUTLINE_TIE = 1.15;
const PARA_ID_RE = /[.-]([a-z])$/;
export function outlineTies(scored, query) {
  if (/\([a-z]\)/i.test(query || "")) return scored;
  const groups = new Map();
  for (const x of scored) {
    const m = PARA_ID_RE.exec(x.r.obligation_id || "");
    if (!m || !x.r.register_id) continue;
    const key = `${x.r.register_id}|${x.r.strict ? 1 : 0}|${x.r.cov_mask ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ x, letter: m[1] });
  }
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const top = Math.max(...rows.map((e) => e.x.s));
    const tied = rows.filter((e) => e.x.s > 0 && top / e.x.s <= OUTLINE_TIE);
    if (tied.length < 2) continue;
    const scores = tied.map((e) => e.x.s).sort((a, b) => b - a);
    tied.sort((a, b) => a.letter.localeCompare(b.letter)).forEach((e, i) => { e.x.s = scores[i]; });
  }
  return scored;
}
// Batch 3 (2026-09-26), see src/subject.js:
//   SUBJECT_BOOST  a row whose title (section OR register title) names EVERY query group is
//                  about exactly the question: x (1 + SUBJECT_BOOST). "VA IRRRL requirements"
//                  -> 38 U.S.C. 3709 "Refinancing of housing loans", 38 CFR 36.4307
//                  "Interest rate reduction refinancing loan", M26-7 Ch. 6 Topic 1.
//   PROGRAM_FACTOR a special program's section (Home Possible, HomeReady, 203(k), HECM ...)
//                  the query does not name: x PROGRAM_FACTOR (C4C-14).
export const SUBJECT_BOOST = 3;
export const PROGRAM_FACTOR = 0.5;
// Round 4 (2026-09-26, stress tests #2/#3: best section at rank 1 on 33/50 and 30/50):
//   Title coverage above is now measured on the section's OWN short title (src/titlefit.js),
//   not the whole section string -- the publication name ("Seller/Servicer Guide") and a VA
//   topic's chapter name no longer count as title words.
//   FIT_BOOST      x (1 + FIT_BOOST x fit), fit = how exactly the short title states the query
//                  (measured 2026-09-26 over golden + replay + stress sets: 1 < 2 < 3 >= 4 on
//                  rank-1; 4 lost an owner-list top-5 hit)
//                  (Jaccard, titlefit.js): "Rental income" 5306.1 over a longer title holding
//                  both words; "Requirements for Credit Reports" over four other credit-report
//                  titles; "Occupancy Types" over "... Non-Occupant Borrowers".
//   LENGTH_FLOOR   bm25 favours short documents without limit: a 113-character editorial
//                  fragment ("Asset verification report 12-month minimum ...") topped
//                  "fannie mae other income". Below LENGTH_FLOOR characters a row is scaled by
//                  sqrt(chars / LENGTH_FLOOR) -- a 343-character real section ("Impact of
//                  Contaminated Sites") loses 7%, a 113-character fragment 47%.
//   PHRASE_BOOST   the query's words as one adjacent phrase in the row ("Cash Remittance
//                  System"): x (1 + PHRASE_BOOST).
//   DELETED_FACTOR a "Section N is deleted." stub (deletedStub): x DELETED_FACTOR.
//   ORDER RULES applied after scoring (orderRules): superseded text never outranks its
//   replacement; an Update 18 revision ranks directly below its in-force text (unless the
//   query asks about Update 18); a register the query CITES ranks first (citedFirst).
export const FIT_BOOST = 3;
export const LENGTH_FLOOR = 400;
export const PHRASE_BOOST = 0.5;
// Round 4 integration (2026-09-26): obligations that are not rule text rank below it --
//   NOTE_FACTOR   a statute's source-credit / editorial notes, split into their own
//                 obligation "<section>-notes" (type: note, scripts/resegment-cfr.py) -- unless
//                 the query asks about notes or history (NOTES_QUERY);
//   INDEX_FACTOR  a Freddie Mac chapter register's heading, "<chapter>-chapter" (type: index,
//                 scripts/gse-register-fixes.py --chapters: the requirements are in its
//                 sections) -- unless the query asks for the chapter or its contents.
// Both are recognized from the obligation id (the served tables carry no type column; the
// suffixes are exactly the 204 note and 5 index obligations in the corpus, 2026-09-26).
export const NOTE_FACTOR = 0.2;
export const INDEX_FACTOR = 0.2;
const NOTES_QUERY = /\b(?:notes?|history|historical|source credits?|amendments?|amended|enact(?:ed|ment)|codifi(?:ed|cation)|editorial|short title)\b/i;
const INDEX_QUERY = /\b(?:chapters?|contents|index|outline)\b/i;

// "note" | "index" | null for an obligation id (see NOTE_FACTOR).
export function obligationType(obligationId) {
  const id = String(obligationId ?? "");
  if (/::[^:]*-notes$/.test(id)) return "note";
  if (/^fhlmc-\d+::fhlmc-\d+-chapter$/.test(id)) return "index";
  // Batch 5 (stress4 S4-07): VA chapter registers ("va-m26-7-ch04::va-m26-7-ch04-chapter")
  // and topic redirect stubs ("...-t06-index") are indexes too.
  if (/::[^:]*-(?:chapter|index)$/.test(id)) return "index";
  return null;
}

// The factor a note / index obligation ranks by for this query (1 when it is neither, or the
// query asks for it).
export function typeFactor(obligationId, query) {
  const t = obligationType(obligationId);
  if (t === "note") return NOTES_QUERY.test(String(query ?? "")) ? 1 : NOTE_FACTOR;
  if (t === "index") return INDEX_QUERY.test(String(query ?? "")) ? 1 : INDEX_FACTOR;
  return 1;
}

function bits(mask, n) {
  const out = [];
  for (let i = 0; i < n; i++) if (Number(mask) & (2 ** i)) out.push(i);
  return out;
}

// Coverage of one candidate: { matched: [group index], inTitle: [group index] }, or null
// when the row carries no masks (then strict rows count as full, relaxed rows as unknown).
// inTitle is r.title_cov (short-title coverage, computed by searchRegs' annotate) when set;
// otherwise the union of the section-title mask (FTS5) and the register title's coverage.
function coverageOf(r, n) {
  if (r.cov_mask === undefined || r.cov_mask === null) return null;
  const k = Math.min(n, MAX_COVERAGE_GROUPS);
  const matched = bits(r.cov_mask, k);
  // Groups past the coverage cap are not measured: a strict row matched them by definition.
  for (let i = k; i < n; i++) if (r.strict) matched.push(i);
  const inTitle = r.title_cov
    ? new Set(r.title_cov)
    : new Set([...bits(r.title_mask ?? 0, k), ...(r.reg_title_cov ?? [])]);
  return { matched, inTitle: [...inTitle].sort((a, b) => a - b) };
}

// FEDERAL LAW FIRST (batch 15, eval H1/H5/H11/H13/H24): a question that names no agency or
// program about a federal statute or regulation (SCRA, flood insurance, Reg X early
// intervention, QM points and fees) ranked agency guides that restate the rule above the rule
// itself -- 50 U.S.C. 3937 was #5 behind Freddie and Ginnie pages. With no agency cue, a
// statute (U.S.C.) or regulation (CFR) row ranks x LAW_BOOST.
export const LAW_BOOST = 1.6;
const LAW_ID = /(?:^reg-[a-z]{1,2}-\d|-\d+(?:usc|cfr)-)/;
export function isFederalLaw(registerId) {
  return LAW_ID.test(String(registerId ?? "")) && !/superseded/.test(String(registerId));
}

// THRESHOLD YEARS (batch 15): "HOEPA points and fees threshold 2026", "QM points and fees limit
// 2026" -- the year's indexed dollar figures are in the Reg Z Supplement I comments
// (32(a)(1)(ii)-3, 43(e)(3)(ii)-1, 35(c)(2)(ii)-3, 3(b)-1). With a year and a threshold word in
// the query, a Supplement I row whose text names that year ranks x YEAR_COMMENT_BOOST.
export const YEAR_COMMENT_BOOST = 3;
const THRESHOLD_WORD = /\b(?:thresholds?|limits?|exemptions?|exempt|points\s+and\s+fees|adjusted|indexed|dollar\s+amounts?)\b/i;
export function thresholdYear(query) {
  const q = String(query ?? "");
  const m = q.match(/\b(20\d{2})\b/);
  return m && THRESHOLD_WORD.test(q) ? m[1] : null;
}
export function yearComment(r, year) {
  if (!/^reg-z-1026-supplement-i/.test(String(r.register_id ?? ""))) return false;
  return String(r.lead_text ?? "").includes(year) || String(r.excerpt ?? "").includes(year);
}

export function combinedScore(r, n) {
  const cov = coverageOf(r, n);
  const share = r.strict ? 1 : r.wshare ?? (cov ? cov.matched.length / n : 0.5);
  const title = cov ? cov.inTitle.length / n : 0;
  const stale = (isStale(r) || r.legacy) && !r.stale_exempt ? STALE_FACTOR : 1;
  const subject = cov && n > 0 && cov.inTitle.length === n ? 1 + SUBJECT_BOOST : 1;
  const program = r.program ? PROGRAM_FACTOR : 1;
  const fit = 1 + FIT_BOOST * (r.fit ?? 0);
  const len = r.chars_total > 0 ? Math.sqrt(Math.min(1, r.chars_total / LENGTH_FLOOR)) : 1;
  const phrase = r.phrase_hit ? 1 + PHRASE_BOOST : 1;
  const deleted = r.section_status ? DELETED_FACTOR : 1;
  const type = r.type_factor ?? 1;
  const b5 = (r.segment_factor ?? 1) * (r.servicing_factor ?? 1) * (r.quote_factor ?? 1) * (r.law_factor ?? 1);
  // Batch 5: a Fannie subheading run that names every query word counts as such a title.
  const titled = r.subhead ? 1 : title;
  const subjectB = r.subhead ? 1 + SUBJECT_BOOST : subject;
  return (r.score ?? 0) * share ** COVERAGE_POWER * (1 + TITLE_BOOST * titled) * subjectB *
    stale * program * fit * len * phrase * deleted * type * b5;
}

// The relaxed gate for a query whose strict AND found nothing. OR alone matches some
// obligation for almost any English sentence (Task 9b: 16/17 off-corpus questions), so a
// relaxed row must match at least half the query's groups (and at least two), and:
//   - with a family filter / agency name, nothing more: the caller has put the question in
//     the corpus's domain (statute sections are titled by citation only -- "38 U.S.C.
//     3709(c)" -- so no title condition);
//   - without one, the row's title must match all but one of the query's groups (the
//     pre-2026-09-26 drop-one rule), OR (Round 4, stress3 RANK-06) a long query (4+ groups)
//     may drop ONE word anywhere when the row's title still names two of them: "advertising
//     triggering terms additional disclosures closed-end credit" lacked only "end" in 12 CFR
//     1026.24 "Advertising (closed-end credit)" and came back empty. A vocabulary key is not
//     a domain signal on its own: lay words are keys ("car"), and "how do I change a car
//     tire" found "change" and "auto" in a VA handbook section.
function acceptRelaxed(r, groups, family) {
  const n = groups.length;
  if (n < 2) return false;
  const cov = coverageOf(r, n);
  if (!cov || cov.matched.length < Math.max(2, Math.ceil(n / 2))) return false;
  if (family) return true;
  if (cov.inTitle.length >= n - 1) return true;
  return n >= 4 && cov.matched.length >= n - 1 && cov.inTitle.length >= 2;
}

// Long-query fallback (batch 5), see searchRegs.
export const LONG_QUERY_GROUPS = 5;
// The title groups are the row's OWN title's (section or paragraph heading), not its register's:
// "California real estate license exam requirements" must not pass on 12 CFR Part 34's "Real
// Estate Lending ... licensed appraiser".
export function longQueryFallback(r, n) {
  const cov = coverageOf(r, n);
  // Own-title groups: the short-title coverage, or the FTS section-title mask (same tokenizer as
  // the text: "Co-op" is the two groups "co" "op" there).
  const own = Math.max(r.own_title_cov?.length ?? 0, bits(r.title_mask ?? 0, Math.min(n, MAX_COVERAGE_GROUPS)).length);
  return Boolean(cov) && own >= Math.max(3, Math.ceil(n / 3)) && cov.matched.length >= Math.ceil(n / 2);
}

// PDF running footers that FTS5's snippet() can cut into the start or end of an excerpt:
// the Selling Guide's "Published May 6, 2026 318" (date + page number). Only the EDGES
// of an excerpt are touched -- mid-text furniture is a corpus defect, fixed upstream --
// and only in the shapes a cut footer takes: at the start, a ", YYYY NNN" tail (a date in
// prose is not followed by a bare page number); at the end, "Published <Month>...".
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const FOOTER_HEAD = new RegExp(
  `^(\\.\\.\\.)?\\s*(?:Published\\s+)?(?:(?:${MONTHS})\\s+)?(?:\\d{1,2})?,\\s*(?:19|20)\\d{2}\\s+\\d{1,4}\\s+`,
);
const FOOTER_TAIL = new RegExp(
  `\\s*Published\\s+(?:${MONTHS})(?:\\s+\\d{1,2}(?:,\\s*(?:(?:19|20)\\d{2}(?:\\s+\\d{1,4})?)?)?)?\\s*(\\.\\.\\.)?$`,
);

export function cleanExcerpt(excerpt) {
  if (!excerpt) return excerpt;
  return String(excerpt)
    .replace(FOOTER_HEAD, (_, dots) => dots ?? "")
    .replace(FOOTER_TAIL, (_, dots) => dots ?? "");
}

// YEAR TOKENS (Round 4, stress2 Q40): "fha variable income guidelines 2026" required "2026"
// in the text, which only Update 18 revisions carry (their titles are stamped "(11/10/2026)"),
// so the in-force text never reached the top ten. With the domain known (a family or an
// agency named) a bare year is dropped from the match; it is kept when it is part of a
// document number ("ML 2026-08", "Bulletin 2026-5", "LL-2026-04"), when it is the only
// word, when the query states a calendar date, or with no family (it may be what keeps an
// off-corpus question off the corpus).
const DOC_NUMBER_BEFORE = /(?:\b(?:ml|ll|letter|letters|bulletin|announcement|circular|notice|apm|sel|svc|lender)\s*-?\s*)$/i;

const MONTH_WORD = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d/i;

export function dropYears(tokens, query, family) {
  if (!family) return tokens;
  const q = String(query ?? "");
  // A calendar date ("effective October 1 2026") is content: the notice that says it is the
  // answer (stress3 RANK-05).
  if (MONTH_WORD.test(q)) return tokens;
  const keep = (t) => {
    if (!/^(?:19|20)\d{2}$/.test(t)) return true;
    const at = q.search(new RegExp(`(?<![\\d])${t}(?![\\d])`));
    if (at === -1) return true;
    if (/^\s*[-‐‑–]\s*\d/.test(q.slice(at + 4))) return true;
    return DOC_NUMBER_BEFORE.test(q.slice(0, at));
  };
  const out = tokens.filter(keep);
  return out.length ? out : tokens;
}

// The query's words for title FIT (src/titlefit.js): its content groups plus the words the
// search stopwords drop but a title can state ("other", "requirements", "new"), without
// agency names and function words. Grouped like the search groups, so "DTI" still fits
// "Debt-to-Income Ratios" through its vocab alternative.
export function titleFitGroups(query, groups) {
  const raw = ftsTokens(query).map((t) => t.toLowerCase())
    .filter((t) => !TITLE_IGNORE.has(t));
  const words = extractAgencies(raw).tokens.filter((t) => !/^(?:19|20)\d{2}$/.test(t));
  const covered = new Set(groups.flatMap((g) => g.tokens));
  const extra = [...new Set(words.filter((t) => !covered.has(t)))];
  return [...groups, ...groupTokens(extra)];
}

// CITATION ROUTING (Round 4, stress2 P1-4 / Q3, Q13, Q27): "38 u.s.c. § 3737" ranked VA
// Circular 26-26-2 (167) over the statute itself (31) because the circular's title cites it;
// "va pamphlet 26-7 chapter 4" returned Topic 4 of eight other chapters. A query that parses
// as a citation (src/citation.js) is resolved exactly as lookup_citation resolves it, and
// the cited register's own rows rank first (orderRules). citationOnly = nothing but the cite
// (and words like "handbook" / "chapter"): then the section is listed in document order,
// fetched directly when no row matched the words. A bare handbook name ("hud 4000.1") adds
// `handbook`, an overview of the handbook's parts (tools/get.js handbookOverview).
const CITE_FILLER = new Set(`
  handbook handbooks guide guides section sec chapter chap ch topic part subpart pamphlet usc
  u.s.c cfr title selling servicing seller servicer lenders lender manual sop notice appendix
  app paragraph para mbs reg regulation policy single family housing information procedural
  statute code us u.s c.f.r
`.split(/\s+/).filter(Boolean));

export async function citedRegisters(env, query) {
  const none = { ids: [], citationOnly: false };
  try {
    const q = String(query ?? "");
    const words = extractAgencies(contentTokens(q)).tokens
      .filter((t) => !CITE_FILLER.has(t) && !/\d/.test(t) && !/^[a-z]$/.test(t));
    const citationOnly = words.length === 0;
    const hb = parseHandbook(q);
    if (hb && citationOnly) {
      const overview = await handbookOverview(env, hb);
      return overview ? { ...none, overview } : none;
    }
    const res = await resolveCitation(env, q);
    if (!res?.parsed) return none;
    const ids = [
      ...(res.register_id ? [res.register_id] : []),
      ...(res.candidates ?? []),
      ...(res.topics ?? []).map((t) => t.register_id),
    ];
    // Citation-anchored search (2026-09-30): the obligation a pinpoint resolves to
    // ("2605(e)(3)" -> the (e) obligation) leads the cited register's rows.
    return ids.length
      ? { ids: [...new Set(ids)], citationOnly, canonical: res.parsed.canonical,
        ...(res.obligation_id ? { obligationIds: [res.obligation_id] } : {}) }
      : none;
  } catch {
    return none;
  }
}

// The first rows of registers, in document order, for a bare citation whose words matched
// no text (a statute cited as "38 u.s.c. § 3737" whose rows say "§3737(a)"). Shaped like a
// search row with no text score; orderRules places them.
async function registerRows(env, ids, limit, column = "register_id") {
  const { results } = await env.CORPUS.prepare(`
    SELECT o.rowid AS rid, o.obligation_id, o.register_id, o.section, o.authority, o.source_url, r.family,
           length(o.verbatim) AS chars_total, 0 AS score, substr(o.verbatim, 1, 300) AS excerpt,
           ${CURRENCY_COLUMNS_BRIEF}, COALESCE(al.canonical_id, o.register_id) AS canonical_id,
           length(o.verbatim_norm) || ':' || substr(o.verbatim_norm, 1, 200) AS text_key,
           r.authority AS register_title, r.superseded_by AS superseded_by
    FROM obligations o JOIN registers r ON r.register_id = o.register_id
    ${currencyJoin("o.register_id")}
    LEFT JOIN aliases al ON al.register_id = o.register_id
    WHERE o.${column === "obligation_id" ? "obligation_id" : "register_id"} IN (SELECT value FROM json_each(?1))
    ORDER BY o.rowid LIMIT ?2`).bind(JSON.stringify(ids), limit).all();
  return (results ?? []).map((r) => ({ ...r, cov_mask: 0, title_mask: 0 }));
}

const obligationRows = (env, ids) => registerRows(env, ids, ids.length, "obligation_id");

// Batch 13 (eval G7/G10): statute companions. Each is the statute obligation a regulation row
// implements (src/statutes.js IMPLEMENTS), inserted directly after that row with
// match "related" and related_to = the regulation row's obligation_id; its rank_score sits
// between its neighbours so the list stays ordered. Fails open (no companion) on any error.
async function listedByCurrency(env, { query, callerFamily, limit, currency_kind }) {
  const { families } = extractAgencies(contentTokens(String(query ?? "")));
  const family = callerFamily ?? (families.size === 1 ? [...families][0] : undefined);
  const lim = Math.min(limit ?? 10, MAX_LIMIT);
  const { rows, total } = await listByCurrency(env, { family, currency_kind, limit: lim });
  if (!rows.length) {
    return { results: [], reason: "no_match",
      guidance: `No section${family ? ` in family "${family}"` : ""} carries currency kind "${currency_kind}".` };
  }
  const oc = await fetchObligationCurrency(env, rows.map((r) => r.obligation_id));
  const kept = rows.map((r) => ({ ...withObligationCurrency(r, oc), match: "listed" }));
  const versions = await fetchVersions(env, dualVersionIds(kept));
  return {
    results: kept.map((r) => shapeResult(r, versions)),
    listing: {
      currency_kind, ...(family ? { family } : {}), total, returned: kept.length,
      order: "newest currency date first, one row per register",
      note: "The query named no topic, so every section with this currency kind is listed " +
        "(match \"listed\"); add topic words to rank by relevance instead.",
    },
  };
}

export async function withCompanions(env, kept) {
  try {
    const targets = companionTargets(kept);
    if (!targets.length) return kept;
    const out = [...kept];
    for (const { after, ref } of targets) {
      const oid = refObligationId(ref);
      let rows = oid ? await obligationRows(env, [oid]) : [];
      if (!rows.length) rows = await registerRows(env, [ref.split("#")[0]], 1);
      const row = rows[0];
      if (!row || out.some((r) => r.obligation_id === row.obligation_id)) continue;
      const i = out.findIndex((r) => r.obligation_id === after);
      if (i < 0) continue;
      const hi = Number(out[i].rank_score ?? 0);
      const lo = Number(out[i + 1]?.rank_score ?? 0);
      out.splice(i + 1, 0, {
        ...row, match: "related", related_to: after,
        relation: `Statute section implemented by ${out[i].section ?? after}`,
        rank_score: Math.round(((hi + lo) / 2) * 100) / 100,
      });
    }
    return out;
  } catch {
    return kept;
  }
}

// Tool body, separated from registration so it can be tested with a fake D1.
//   1. strict: AND over the content groups (vocab expansions inside each group)
//   2. relaxed: OR over the same groups, always -- its rows compete on the combined score
//   3. merge, rank (combinedScore), collapse same-text copies, cut to `limit`
//   4. when strict found nothing, only relaxed rows passing acceptRelaxed survive;
//      none left -> no_match (the corpus-gap log records the query)
// match: "all_terms" when the row matches every group, else "partial" with missing_terms.
//
// Batch 3 (2026-09-26) adds, in order:
//   5. subject registers (src/subject.js): their best obligations join the candidates even
//      when body-text rank left them out of the pool; a row whose section or register title
//      names every group is boosted (SUBJECT_BOOST)
//   6. INCIDENTAL all-terms rows: with no family filter and no agency named, when not one
//      strict row's title (section or register) names ANY query word, the words only
//      co-occur somewhere in long documents ("Schedule C home office deduction" in USDA's
//      9.11 "Education"; "capital gains tax rate on stock sales" in an S-corporation
//      returns section) -- the corpus does not address the question as asked. Those rows
//      are treated as relaxed, so the title gate below decides (usually no_match).
//   7. special-program demotion (PROGRAM_FACTOR) and the currency_kind filter
// Round 4 (2026-09-26) adds: structural binding ("chapter 4" is one phrase, never "Topic
// 4"; src/vocab.js bindStructure), year tokens dropped when a family is known (dropYears),
// the phrase column, short-title coverage/fit (src/titlefit.js), deleted stubs, the
// superseded register's replacement fetched and ranked above it, the Update-18 order, the
// pending exemption, and citation routing (citedRegisters).
// Every result carries `rank_score`, the combined score it was ordered by (C4C-13).
// Batch 10 (stress6 C09 N12): a capitalized name whose second word is a number word ("Capital
// One") is ONE name -- matched as the adjacent phrase, not as "capital" anywhere AND "one"
// anywhere (capital-gains sections came back all_terms). Merges the two single-token groups.
const NAME_NUMBER_RE = /\b([A-Z][a-z]+)\s+(One|Two|Three|First|Main)\b/g;
// Batch 13 (eval B23): typed in lower case ("capital one auto loan approval rates") the name is
// still a name -- unless the first word numbers a part of a document, a process or a property
// ("chapter one", "tier two", "step one", "two unit" is the other order).
const NAME_NUMBER_LC_RE = /\b([a-z]{3,})\s+(one|two|three)\b/g;
const NUMBERED_WORDS = new Set(("chapter part phase tier year day step section title level type class form page " +
  "week month round stage unit option article schedule appendix exhibit table figure line item rule " +
  "number all any the for and with than then only just more less over under least most every each " +
  "per about into from plus top lien loan loans borrower units family no").split(" "));
const COUNT_UNIT_RE = /^\s+(?:years?|months?|days?|business|weeks?|times|percent|consecutive|calendar|units?)\b/i;
export function properNames(query, groups) {
  let out = groups;
  const q = String(query ?? "");
  const hits = [...q.matchAll(NAME_NUMBER_RE),
    ...[...q.matchAll(NAME_NUMBER_LC_RE)].filter((m) => !NUMBERED_WORDS.has(m[1]) &&
      // Batch 15: a number before a unit counts it ("continue three years", "three business days").
      !COUNT_UNIT_RE.test(q.slice(m.index + m[0].length)))];
  for (const m of hits) {
    const a = m[1].toLowerCase();
    const b = m[2].toLowerCase();
    const i = out.findIndex((g, k) => g.tokens.length === 1 && g.tokens[0] === a && !g.alts.length &&
      out[k + 1]?.tokens.length === 1 && out[k + 1].tokens[0] === b && !out[k + 1].alts.length);
    if (i >= 0) out = [...out.slice(0, i), { tokens: [a, b], alts: [], phrase: true, proper: true }, ...out.slice(i + 2)];
  }
  return out;
}

// Batch 10 (stress6 C09 R21): with no all-terms row and nothing through the relaxed gate, a
// query of RELAXED_MIN_GROUPS+ groups returns the rows that match every group but one, as
// partial matches (match "partial", missing_terms names the one). "cramdown principal residence
// Chapter 13" came back no_match while Freddie 9401.2(e) holds all but "principal" ("Primary
// Residence").
export const RELAXED_MIN_GROUPS = 4;
// A longer sentence matches all but one of its words in some long text by chance (stress6 N12).
export const RELAXED_MAX_GROUPS = 5;
export function allButOne(r, n) {
  const cov = coverageOf(r, n);
  return n >= RELAXED_MIN_GROUPS && n <= RELAXED_MAX_GROUPS && Boolean(cov) && cov.matched.length >= n - 1 &&
    cov.inTitle.length >= 1;
}

// DIVERSITY (batch 15, eval): one register's paragraphs filled the results -- "Mortgagee
// Letter" listed 4 letters, "VA circular 2026" 2. A register's rows past the first
// MAX_PER_REGISTER move below every other register's rows (kept, in order, if room remains).
export const MAX_PER_REGISTER = 3;
export const DEEP_POOL_MIN_REGISTERS = 8;
export const DEEP_POOL_FACTOR = 5;
// Batch 18: a short query that names a KIND of document ("Mortgagee Letter", "VA circular") --
// its words are in the titles of at least LISTING_MIN_TITLED registers -- is a listing: one
// row per register before any register's second.
export const LISTING_MIN_TITLED = 5;
export function listingCap(rows, tokens) {
  const toks = (tokens ?? []).map((t) => String(t).toLowerCase()).filter((t) => /[a-z]/.test(t));
  if (!toks.length || toks.length > 3) return MAX_PER_REGISTER;
  const titled = new Set();
  for (const r of rows) {
    const title = ` ${String(r.register_title ?? r.authority ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
    if (toks.every((t) => title.includes(` ${t}`))) titled.add(r.register_id);
  }
  return titled.size >= LISTING_MIN_TITLED ? 1 : MAX_PER_REGISTER;
}
export function capPerRegister(rows, cap = MAX_PER_REGISTER) {
  const seen = new Map();
  const head = [];
  const tail = [];
  for (const r of rows) {
    const k = seen.get(r.register_id) ?? 0;
    seen.set(r.register_id, k + 1);
    (k < cap ? head : tail).push(r);
  }
  return head.concat(tail);
}

// Batch 15: the forgiving "most terms" match (src/forgiving.js) -- { rows, groups } or null.
// The query's terms minus question scaffolding, each group weighted by its rarity; the rows
// that hold the most weight are fetched directly (not as the top of an OR's bm25 order, which
// a long query fills with long texts holding its common words), then gated on their weighted
// share. A proper name the query carries ("Capital One") must still be held.
const SECTION_PAIRS_MAX = 3;
async function forgivingRows(env, args) {
  try {
    return await forgivingRowsRaw(env, args);
  } catch {
    return null;
  }
}
async function forgivingRowsRaw(env, { query, callerFamily, cited }) {
  const fq = stripScaffold(query);
  const raw = contentTokens(fq).filter((t) => !SCAFFOLD_WORDS.has(t));
  const resolved = resolveAgency(raw, callerFamily);
  const family = resolved.family;
  const tokens = dropYears(resolved.tokens, fq, family);
  // No bindStructure: a structure pair ("continue three") is one rare phrase here, not two terms.
  let groups = properNames(fq, groupTokens(tokens)).flatMap((g) => (g.alts.length || g.proper || g.tokens.length < 2
    ? [g] : g.tokens.map((t) => ({ tokens: [t], alts: [] }))));
  if (groups.length < FORGIVE_MIN_GROUPS) return null;
  let gm = groups.map(renderGroup);
  let { weights, dfs, n: corpusSize } = await groupWeights(env, gm);
  if (!corpusSize) return null;
  if (groups.length > MAX_COVERAGE_GROUPS) {
    const keep = new Set(weights.map((w, i) => [w, i]).sort((a, b) => b[0] - a[0])
      .slice(0, MAX_COVERAGE_GROUPS).map(([, i]) => i));
    groups = groups.filter((_, i) => keep.has(i));
    gm = gm.filter((_, i) => keep.has(i));
    weights = weights.filter((_, i) => keep.has(i));
    dfs = dfs.filter((_, i) => keep.has(i));
  }
  const must = mustHold(weights, dfs);
  const k = groups.length;
  const sql = coverageSql(k, familyFilterSql(2 * k + 1));
  const binds = gm.flatMap((m, i) => [m, weights[i]]);
  const { results: cand } = await env.CORPUS.prepare(sql)
    .bind(...binds, family ?? "", FORGIVE_POOL).all().catch(() => ({ results: [] }));
  const total = weights.reduce((a, b) => a + b, 0);
  const rids = new Set((cand ?? []).filter((c) => total && c.wsum / total >= FORGIVE_MIN_SHARE).map((c) => c.rid));
  const names = groups.map((g, i) => (g.proper ? i : -1)).filter((i) => i >= 0);
  // Batch 21: section level -- two paragraphs of one register that together hold the query
  // (src/forgiving.js sectionPairs) are returned, each row a partial match with its own
  // missing_terms, ranked by the pair's share.
  const pairShare = new Map();
  if (k >= 3) {
    const { results: masks } = await env.CORPUS.prepare(sectionMaskSql(k, familyFilterSql(2 * k + 1)))
      .bind(...gm.flatMap((m, i) => [m, 2 ** i]), family ?? "", FORGIVE_PAIR_POOL).all()
      .catch(() => ({ results: [] }));
    for (const p of sectionPairs(masks ?? [], weights, [...new Set([...must, ...names])]).slice(0, SECTION_PAIRS_MAX)) {
      for (const rid of p.rids) pairShare.set(rid, Math.max(pairShare.get(rid) ?? 0, p.share));
    }
  }
  if (!rids.size && !pairShare.size) return null;
  const regs = await env.CORPUS
    .prepare(`SELECT DISTINCT register_id FROM obligations WHERE rowid IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify([...rids, ...pairShare.keys()])).all();
  const registers = (regs.results ?? []).map((r) => r.register_id);
  const fetched = applyThreshold(await runMatch(env, gm.join(" OR "), family, 10 * FORGIVE_POOL, gm, { registers }))
    .filter((r) => rids.has(r.rid) || pairShare.has(r.rid));
  const ok = fetched.filter((r) => {
    if (popcount(r.cov_mask) < FORGIVE_MIN_GROUPS) return false;
    if (pairShare.has(r.rid)) return true;
    if (weightedShare(r.cov_mask, weights) < FORGIVE_MIN_SHARE) return false;
    if (!must.every((i) => Number(r.cov_mask) & (2 ** i))) return false;
    return cited.has(r.register_id) || names.every((i) => Number(r.cov_mask) & (2 ** i));
  });
  if (!ok.length) return null;
  const annotate = annotator(fq, groups, titleFitGroups(fq, groups), ok, tokens);
  return { groups, rows: ok.map((r) => ({ ...annotate(r),
    wshare: Math.max(weightedShare(r.cov_mask, weights), pairShare.get(r.rid) ?? 0) })) };
}

// Batch 20 (gpt-4o neutral retest B2): one-call models fill the optional currency_kind with
// "any" (read as "no filter") or another kind, and a topical query then came back empty
// ("fhlmc bonus income", "fhlmc homebuyer education") or anchored on the only sections that
// carry a signal (the UAD 3.6 supplement for "fannie mae disability income"). When the filter
// empties a topical search, or -- for "any" -- drops the best-matching section, the closest
// sections without the filter are returned, labelled, so the model has something to open.
// Only when the unfiltered search has a section matching every term: an off-topic query
// stays a no_match.
export async function searchRegs(env, args) {
  const res = await searchRegsCore(env, args);
  const { query, currency_kind } = args;
  if (!currency_kind || isGenericQuery(query) || !Array.isArray(res.results)) return res;
  const filtered = res.results;
  if (filtered.length > 0 && currency_kind !== "any") return res;
  const open = await searchRegsCore(env, { ...args, currency_kind: undefined });
  const top = (open.results ?? []).find((r) => r.match === "all_terms");
  if (!top) return res;
  if (filtered.length > 0 && filtered.some((r) => r.register_id === top.register_id)) return res;
  const { reason: _r, guidance: _g, ...rest } = open;
  return {
    ...rest,
    currency_filter: { kind: currency_kind, applied: false, matched: filtered.length },
    note: (filtered.length === 0
      ? `No exact match: no section with currency kind "${currency_kind}" matched these words. `
      : `Currency kind "${currency_kind}" matched only sections off this topic. `) +
      "Closest sections without the currency filter follow; a section that carries a currency " +
      "signal shows it in `currency`.",
  };
}

async function searchRegsCore(env, { query, family: callerFamily, limit, currency_kind }) {
  // Batch 13: a currency_kind filter with no topic word lists by currency date (src/currency-list.js).
  if (currency_kind && isGenericQuery(query)) {
    return listedByCurrency(env, { query, callerFamily, limit, currency_kind });
  }
  const resolved = resolveAgency(contentTokens(query), callerFamily);
  const family = resolved.family;
  const tokens = dropYears(resolved.tokens, query, family);
  const groups = properNames(query, bindStructure(groupTokens(tokens)));
  const groupMatches = groups.map(renderGroup);
  const match = groupMatches.join(" AND ");
  if (!match) return { results: [], reason: "empty_query" };
  const lim = limit ?? 10;
  const n = groups.length;
  const phrase = tokens.length >= 2 && tokens.length <= 5 ? quotePhrase(tokens.join(" ")) : "";
  const guards = literalGuards(query, groups);
  const filters = {
    ...(currency_kind ? { currencyKind: currency_kind } : {}),
    ...(phrase ? { phrase } : {}),
    ...(guards.length ? { guards } : {}),
  };
  const fitGroups = titleFitGroups(query, groups);

  // The strict pool is as deep as the relaxed one: demotion (STALE_FACTOR) and the title
  // boost can only reorder rows that were fetched.
  // Batch 8 (stress6 C08): the pool no longer depends on `limit`. "pension income" at limit 5
  // fetched too few rows to see FHA's in-force texts, so their Update 18 revisions led; the
  // same candidates are now scored for every limit and only the cut differs.
  const pool = MAX_LIMIT * RELAXED_FACTOR + COPY_SLACK;
  let rows = await runMatch(env, match, family, pool, groupMatches, filters);
  // Batch 18: a full pool from only a few registers ("Mortgagee Letter": the paragraphs of four
  // letters) -- fetch deeper, so capPerRegister has other registers to bring up.
  if (rows.length >= pool && new Set(rows.map((r) => r.register_id)).size < DEEP_POOL_MIN_REGISTERS) {
    rows = await runMatch(env, match, family, pool * DEEP_POOL_FACTOR, groupMatches, filters);
  }
  // A strict row that failed a literal guard is a partial match (relaxed), or no match at all
  // for a one-group query.
  const guardFailed = applyThreshold(rows).filter((r) => r.guard_fail);
  let strict = applyThreshold(rows).filter((r) => !r.guard_fail).map((r) => ({ ...r, strict: true }));
  const seen = new Set(strict.map((r) => r.obligation_id));
  let relaxed = [];
  if (n >= 2) {
    relaxed = applyThreshold(await runMatch(
      env, groupMatches.join(" OR "), family, pool, groupMatches, filters,
    )).filter((r) => !seen.has(r.obligation_id));
    for (const r of relaxed) seen.add(r.obligation_id);
  }
  for (const r of guardFailed) seen.add(r.obligation_id);
  const inject = async (registers) => {
    if (!registers.length) return;
    const injected = applyThreshold(await runMatch(
      env, n >= 2 ? groupMatches.join(" OR ") : match, family, pool, groupMatches,
      { ...filters, registers },
    )).filter((r) => !seen.has(r.obligation_id));
    for (const r of injected) {
      seen.add(r.obligation_id);
      const full = Number(r.cov_mask) === 2 ** Math.min(n, MAX_COVERAGE_GROUPS) - 1;
      (full ? strict : relaxed).push(full ? { ...r, strict: true } : r);
    }
  };

  // 5. Subject registers' own obligations (full coverage counts as strict).
  await inject(await subjectRegisters(env, groups, family));

  // Round 4: a superseded register's replacement competes even when its text ranked below
  // the pool (stress2 Q46: the current M26-4 Chapter 5 was #8 under six superseded rows).
  const present = new Set([...strict, ...relaxed].map((r) => r.register_id));
  await inject([...new Set([...strict, ...relaxed].map((r) => r.superseded_by)
    .filter((id) => id && !present.has(id)))]);

  // Citation routing: a query that cites a section ranks that section's own text first.
  const cited = await citedRegisters(env, query);
  if (cited.ids.length) {
    await inject(cited.ids);
    // The pinpoint obligation competes even when it holds none of the query's words.
    const pin = (cited.obligationIds ?? []).filter((id) => !seen.has(id));
    for (const r of pin.length ? await obligationRows(env, pin) : []) {
      seen.add(r.obligation_id);
      relaxed.push(r);
    }
    if (cited.citationOnly) {
      const have = new Set([...strict, ...relaxed].map((r) => r.register_id));
      const missing = cited.ids.filter((id) => !have.has(id));
      for (const r of missing.length ? await registerRows(env, missing, pool) : []) {
        if (seen.has(r.obligation_id)) continue;
        seen.add(r.obligation_id);
        relaxed.push(r);
      }
    }
  }

  const annotate = annotator(query, groups, fitGroups, [...strict, ...relaxed], tokens);
  strict = strict.map(annotate);
  relaxed = relaxed.map(annotate);

  // 6. Incidental all-terms rows (no domain signal: no family, no agency named).
  // A SHORT obligation that holds every one of 3+ query words is not an incidental
  // co-occurrence (stress5 I04: "willfully fails to comply consumer punitive damages" is the
  // 828-character text of 15 U.S.C. 1681n(a), whose title names none of those words).
  let incidental = false;
  let relaxedPool = 0;
  if (!family && !cited.ids.length && n >= 2 && strict.length &&
      strict.every((r) => {
        const c = coverageOf(r, n);
        return c && c.inTitle.length === 0 && !(n >= DENSE_MIN_GROUPS && Number(r.chars_total) <= DENSE_MAX_CHARS);
      })) {
    relaxed = strict.map((r) => ({ ...r, strict: false })).concat(relaxed);
    strict = [];
    incidental = true;
  }
  const citedSet = new Set(cited.ids);
  // Batch 5: a long query with no all-terms row also fetches the rows whose TITLE matches its
  // words best (the OR pool ranks long documents that hold many of the words first).
  if (!strict.length && n >= LONG_QUERY_GROUPS) {
    const byTitle = applyThreshold(await runMatch(env, `section : (${groupMatches.join(" OR ")})`,
      family, pool, groupMatches, filters)).filter((r) => !seen.has(r.obligation_id));
    for (const r of byTitle) seen.add(r.obligation_id);
    relaxed = relaxed.concat(byTitle.map(annotate));
  }
  if (!strict.length) {
    const gated = relaxed.filter((r) => citedSet.has(r.register_id) || acceptRelaxed(r, groups, family));
    // Batch 5 (stress4 S4-11): a long natural-language query ("lenders choosing reliable
    // providers co-op project eligibility checks") fails the all-but-one title rule on its
    // filler words and came back no_match while "Co-op Project Eligibility" sat in the pool.
    // With nothing else left, a row whose TITLE names at least a third of the query's groups
    // (and three or more) and whose text holds half of them is returned as a partial match.
    const pooled = relaxed;
    relaxed = gated.length || n < LONG_QUERY_GROUPS
      ? gated : relaxed.filter((r) => longQueryFallback(r, n));
    if (!relaxed.length && !incidental) relaxed = pooled.filter((r) => allButOne(r, n));
    relaxedPool = pooled.filter((r) => n >= RELAXED_MIN_GROUPS && (coverageOf(r, n)?.matched.length ?? 0) >= n - 1).length;
    // Batch 13 (eval B23): a partial match that lacks the query's proper name ("Capital One")
    // is about something else -- "capital one auto loan approval rates" returned three FHA
    // sections as partial matches. No row naming the entity: no_match, not a near miss.
    const names = groups.map((g, i) => (g.proper ? i : -1)).filter((i) => i >= 0 && i < MAX_COVERAGE_GROUPS);
    if (names.length) {
      const named = (r) => citedSet.has(r.register_id) ||
        names.every((i) => bits(r.cov_mask ?? 0, Math.min(n, MAX_COVERAGE_GROUPS)).includes(i));
      relaxed = relaxed.filter(named);
      if (!pooled.some(named)) relaxedPool = 0;
    }
  }

  const rankAll = async (strictRows, relaxedRows, grp) => {
  const n = grp.length;
  let candidates = strictRows.concat(relaxedRows);
  const oc = await fetchObligationCurrency(env, candidates.map((r) => r.obligation_id));
  candidates = candidates.map((r) => withLegacy(withPendingExemption(withObligationCurrency(r, oc), query, grp), query));
  if (!family) candidates = candidates.map((r) => (isFederalLaw(r.register_id) ? { ...r, law_factor: LAW_BOOST } : r));
  const ty = thresholdYear(query);
  if (ty) candidates = candidates.map((r) => (yearComment(r, ty) ? { ...r, law_factor: (r.law_factor ?? 1) * YEAR_COMMENT_BOOST } : r));
  if (currency_kind) {
    candidates = candidates.filter((r) => (currency_kind === "any"
      ? Boolean(r.currency_kind) : r.currency_kind === currency_kind));
  }
  const scored = batch5Rules(orderRules(
    candidates.map((r) => ({ r, s: combinedScore(r, n) })),
    { query, cited: citedSet, citationOnly: cited.citationOnly, pinned: new Set(cited.obligationIds ?? []) },
  ), { query, cited: citedSet, tokens });
  // Batch 8 (C07): no later rule may lift superseded text over its replacement, or an Update 18
  // revision over its in-force text.
  orderVersions(clampSuperseded(scored), query);
  commentaryBelowRule(scored, query);
  outlineTies(scored, query);
  sinkSuperseded(scored, lim, query);
  const ranked = scored
    .sort((a, b) => b.s - a.s)
    .map(({ r, s }) => labelMatch({ ...r, rank_score: Math.round(s * 100) / 100 }, grp));
  // Batch 8 (stress6 C09 R11/N16): a currency_kind filter returns only rows that match every
  // term -- partial matches that happen to carry the signal read as an answer to the filter.
  return capPerRegister(collapseVersions(collapseCopies(currency_kind ? ranked.filter((r) => r.match === "all_terms") : ranked), query),
    listingCap(ranked, tokens)).slice(0, lim);
  };
  let kept = await rankAll(strict, relaxed, groups);
  // Batch 15: nothing through any gate -- the ranked "most terms" match (src/forgiving.js).
  // Also when every row is a partial match: the relaxed gates admit rows by their titles, and
  // a long question's best-covered text may hold more of its weight than any of them.
  if (!currency_kind && !kept.some((r) => r.match === "all_terms")) {
    const forgiven = await forgivingRows(env, { query, callerFamily, cited: citedSet });
    if (forgiven) kept = await rankAll([], forgiven.rows, forgiven.groups);
  }

  if (kept.length === 0) {
    // No query text is stored (Earl, 2026-10-08): the spec 6.3 corpus-gap log (zero_results)
    // was the only place the server kept text a user sent. A refusal is still counted, without
    // text, as the daily metric tool:search_regs:zero (src/metrics.js outcomeOf).
    return {
      results: [],
      // Batch 10 (stress6 C09 R8): partial matches that fell below the relaxed gate are "below
      // threshold", not "no match" -- the words are in the corpus, not together.
      reason: (rows.length === 0 && !relaxedPool) || incidental ? "no_match" : "no_match_above_threshold",
      guidance: currency_kind
        ? `No section with currency kind "${currency_kind}" matched these words. Try broader ` +
          "terms or omit currency_kind; this is not evidence about the rule itself."
        : refusalGuidance(query, groups),
      ...(cited.overview ? { handbook: cited.overview } : {}),
    };
  }
  // Batch 13: the statute section a regulation row implements, right after it (src/statutes.js).
  // Not under a family filter other than "other" (statutes are family "other") or a
  // currency_kind filter (a companion carries no currency signal of its own).
  if (!currency_kind && (!family || family === "other")) {
    kept = (await withCompanions(env, kept)).slice(0, lim);
  }
  const versions = await fetchVersions(env, dualVersionIds(kept));
  // Batch 17: best-passage excerpts, and the confident top row's verbatim text inline (src/inline.js).
  const inline = await withInlineText(env, kept.map((r) => shapeResult(r, versions)), tokens,
    cited.canonical ? cited.ids : null);
  // Batch 18: a chapter / whole-document query gets the register's key-rules digest.
  return withSearchDigest(env, {
    results: inline.results,
    ...(inline.inlined ? { inline_note: INLINE_NOTE } : {}),
    ...(cited.canonical ? { cited: { citation: cited.canonical, register_ids: cited.ids } } : {}),
    ...(cited.overview ? { handbook: cited.overview } : {}),
  }, { cited, tokens });
}

// Per-row ranking facts, computed once: short-title coverage and fit (src/titlefit.js),
// the special program the query does not name, a deleted stub, and -- for a replacement
// register whose own titles are bare numbers ("M26-4 Chapter 5 — 5.02") -- the title of
// the superseded copy it replaces ("... Chapter 5 — Loss Mitigation (prior version)").
// PARAGRAPH TITLES (batch 5): a CFR paragraph's section string is a bare citation ("12 CFR
// §1026.20(c)"), so its own heading -- "(c) Rate adjustments with a corresponding change in
// payment." -- never counted as a title, and "rate change notices" could not find it. The
// heading at the start of such an obligation's text is read as its title: an outline marker,
// then a short capitalized phrase ending in "." or an em dash, with no verb of obligation.
// Top-level lettered paragraphs only: a numbered subparagraph's heading ("(4) Interest rate
// reduction refinancing loans" inside 38 CFR 36.4313(i), a fee rule) would otherwise outrank the
// section that governs the topic.
const PARA_TITLE = /^\s*\((?:[a-z]{1,2})\)\s+([A-Z][^.—–:;()]{2,90}?)\s*(?:\.(?=\s+[A-Z(“"])|—)/;
const SENTENCE_OPENER = /^(?:On|In|For|If|When|The|A|An|Each|Any|All|No|Except|Unless|Where|After|Before|Upon|With|To)\b/;
export function paragraphTitle(lead) {
  const m = String(lead ?? "").match(PARA_TITLE);
  if (!m) return "";
  const t = m[1].trim();
  if (SENTENCE_OPENER.test(t)) return "";
  if (/\b(?:shall|must|may|will|is|are)\b/.test(t) || t.split(/\s+/).length > 12) return "";
  return /^in general$/i.test(t) ? "" : t;
}

// Batch 10 (stress6 C06 R18): a letter's QUOTATION of the text it deletes -- HUD ML 2026-07's
// "Form HUD-92900-B, Important Notice to Homebuyers (deleted requirement, II.A.1.a.ii(A)(2))" --
// holds the removed requirement's own words, so it outscored the letter's Purpose for "HUD
// rescind Important Notice to Homebuyers". A row whose own title marks it "(deleted ...)" or
// "(removed ...)" ranks at DELETED_QUOTE_FACTOR unless the query asks for the old text.
export const DELETED_QUOTE_FACTOR = 0.3;
const DELETED_QUOTE_RE = /\((?:deleted|removed|rescinded)\b[^)]*\)/i;
const ASKS_OLD_RE = /\b(?:delet\w*|remov\w*|prior|former|old|original|previous\w*)\b/i;
export function deletedQuoteFactor(section, query) {
  return DELETED_QUOTE_RE.test(section || "") && !ASKS_OLD_RE.test(query || "") ? DELETED_QUOTE_FACTOR : 1;
}

function annotator(query, groups, fitGroups, rows, tokens = []) {
  const inherited = new Map();
  for (const r of rows) {
    if (r.superseded_by && !inherited.has(r.superseded_by)) {
      const t = shortTitle(r.register_title);
      if (t) inherited.set(r.superseded_by, t);
    }
  }
  return (r) => {
    // An excerpt row's section title is a digest line, not the regulator's heading (C19): it
    // earns no title coverage or fit of its own.
    const excerpt = isExcerpt(r);
    const paraTitle = shortTitle(r.section) || excerpt ? "" : paragraphTitle(r.lead_text);
    const rowTitle = excerpt ? "" : shortTitle(r.section) || paraTitle;
    const regTitle = shortTitle(r.register_title) || inherited.get(r.register_id) || "";
    const titled = Boolean(rowTitle || regTitle);
    const titleCov = titled
      ? [...new Set([...titleCoverage2(rowTitle, groups), ...titleCoverage2(regTitle, groups),
        ...titleCoverage2(parentHeading(r.register_title), groups)])]
      : null;
    const program = unnamedProgram(query, r.section, r.register_title) ?? hecmSection(query, r);
    // A "Section N is deleted." stub by its text, or a register the Guide deleted (currency
    // kind "deleted": source.status deleted, scripts/gse-register-fixes.py --deleted).
    const stub = deletedStub(r.stub_text) ??
      (r.currency_kind === "deleted" ? { section_status: "deleted" } : null);
    const typeF = typeFactor(r.obligation_id, query);
    const segF = gnmaSegmentFactor(r.register_id, query);
    const svcF = servicingFactor(r.register_id, query);
    const subhead = subheadHit(r.lead_text, tokens, r.register_id);
    const quoteF = deletedQuoteFactor(r.section, query);
    return {
      ...r,
      ...(typeF !== 1 ? { type_factor: typeF } : {}),
      ...(segF !== 1 ? { segment_factor: segF } : {}),
      ...(svcF !== 1 ? { servicing_factor: svcF } : {}),
      ...(subhead ? { subhead: true } : {}),
      ...(quoteF !== 1 ? { quote_factor: quoteF } : {}),
      reg_title_cov: titleCoverage(r.register_title, groups),
      own_title_cov: rowTitle ? titleCoverage2(rowTitle, groups) : [],
      ...(titleCov ? { title_cov: titleCov } : {}),
      fit: paraTitle
        ? Math.max(titleFit(paraTitle, fitGroups), titleFit(regTitle, fitGroups))
        : titleFit(rowTitle || regTitle, fitGroups),
      ...(program ? { program } : {}),
      ...(stub ?? {}),
    };
  };
}

// FHA 4000.1 Parts II.B and III.B are the HECM (reverse mortgage) sections (stress3 RANK-04:
// II.B.5.f "Residual Income Analysis" ranked 4th, untagged, for a forward-mortgage query).
// Many of their registers carry only "Handbook 4000.1, Part II" as a title, so the program is
// read from the derived citation.
function hecmSection(query, r) {
  if (!String(r.register_id ?? "").startsWith("hud-4000-1-")) return null;
  const cite = canonicalCitation({ register_id: r.register_id, register_title: r.register_title,
    section: r.section, authority: r.authority });
  if (!cite || !/^4000\.1 (?:II|III)\.B\./.test(cite)) return null;
  return unnamedProgram(query, "HECM") ? "HECM" : null;
}

// Stale text the query itself asks about keeps its rank (stress3 RANK-05: the pending x0.2
// buried SBA notices 5000-880695 / 5000-882227, which DEFINE when SOP 50 10 8.1 applies, under
// an unrelated row for "SOP 50 10 8.1 effective date"). A pending row is exempt when the query
// asks about effective dates / pending text, or names a version number ("8.1") that the row's
// title or matched text carries.
const PENDING_QUERY = new RegExp(
  String.raw`\beffective\s+(?:dates?|on|as\s+of|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b|` +
  String.raw`\bpending\b|\btakes?\s+effect\b|\bupcoming\b|\bnot yet in force\b|\bwhen does\b`,
  "i",
);
export function withPendingExemption(r, query, groups = []) {
  if (r.currency_kind !== "pending") return r;
  const q = String(query ?? "");
  if (PENDING_QUERY.test(q)) return { ...r, stale_exempt: true };
  const versions = q.match(/\b\d+\.\d+\b/g) ?? [];
  const title = `${r.register_title ?? ""} ${r.section ?? ""}`;
  const inTitle = versions.some((v) => new RegExp(`(?:^|[^\d.])${v.replace(".", "\.")}(?!\d)`).test(title));
  // ... or the row's own text states that version number (a notice that announces it).
  const matched = new Set(bits(r.cov_mask ?? 0, Math.min(groups.length, MAX_COVERAGE_GROUPS)));
  const inText = groups.some((g, i) => matched.has(i) && g.tokens.length === 1 && versions.includes(g.tokens[0]));
  return inTitle || inText ? { ...r, stale_exempt: true } : r;
}

// LEGACY (batch 13, eval G13): a register the index tiers "superseded" (coverage_tier) whose
// text no later register replaces one-for-one -- 12 CFR 1024.7, the pre-TRID Good Faith Estimate,
// "largely superseded by" 12 CFR 1026.19(e)/1026.37 -- ranks as stale text (x STALE_FACTOR), so
// "loan estimate tolerance" leads with the TRID rule. Exempt when the query asks for the old
// text or names the legacy instrument itself (the GFE still governs reverse mortgages).
export const ASKS_OLD_QUERY = new RegExp([
  String.raw`\b(?:superseded|prior|previous|former|old|older|legacy|historical|history|pre-?trid)\b`,
  String.raw`\bgfe\b|\bgood faith estimate\b|\bhud-?1a?\b|\breverse mortgages?\b|\bhecm\b`,
  String.raw`\bsettlement statement\b|\b(?:19|20)\d\d\b`,
].join("|"), "i");
export function withLegacy(r, query) {
  if (r.coverage_tier !== "superseded" || isStale(r)) return r;
  return ASKS_OLD_QUERY.test(String(query ?? "")) ? r : { ...r, legacy: true };
}

// SUPERSEDED BELOW CURRENT (batch 13, eval B21/B15): superseded or legacy text ranks below every
// current row that makes the cut -- it is kept (with its warning) only to fill the list. The
// clamp above holds it under its own replacement; this holds it under the other current answers
// too ("VA heating requirements": the 2019 Topic 23 was #2). Skipped when the query asks for old
// text. Mutates `scored` ([{r, s}]).
const SINK_KINDS = new Set(["superseded", "predates-statute", "incorporated"]);
export function sinkSuperseded(scored, lim = 10, query = "") {
  if (ASKS_OLD_QUERY.test(String(query ?? ""))) return scored;
  const old = (x) => (x.r.legacy || (SINK_KINDS.has(x.r.currency_kind) && !x.r.stale_exempt));
  const current = scored.filter((x) => !old(x) && x.s > 0).map((x) => x.s).sort((a, b) => b - a);
  if (!current.length) return scored;
  const floor = current[Math.min(lim, current.length) - 1];
  for (const x of scored) if (old(x) && x.s >= floor) x.s = floor * 0.99;
  return scored;
}

const UPDATE_18_QUERY = /\bupdate\s*-?\s*18\b|\bu-?18\b/i;
export const CITED_BOOST = 2;

// SUPERSEDED CLAMP: a row whose register was superseded by one present in the list scores at
// most STALE_FACTOR x that replacement's best row. Applied in orderRules and again after
// batch5Rules (batch 8, stress6 C07: the cross-reference lift raised superseded B3-3.8-01,
// B3-6-05 and B7-3-03 above their replacements), so the contract holds after every rule.
export function clampSuperseded(scored) {
  const best = new Map();
  for (const { r, s } of scored) {
    if (r.superseded_by) continue;
    best.set(r.register_id, Math.max(best.get(r.register_id) ?? 0, s));
  }
  for (const x of scored) {
    const repl = x.r.superseded_by && best.get(x.r.superseded_by);
    if (repl) x.s = Math.min(x.s, repl * STALE_FACTOR);
  }
  return scored;
}

// UPDATE 18 ORDER: an Update 18 revision (<id>::update-18) scores just below its in-force text;
// the reverse when the query names Update 18.
// VERSION COLLAPSE (batch 13, eval G1/G6): an FHA dual-version section's in-force text and its
// Update 18 revision took two of the result slots ("fha qualifying ratios": II.D final
// underwriting decision twice). One row per section: the in-force row stays (the revision
// when the query names Update 18) and names the other in `other_version`, as every
// dual-version hit already does (src/versions.js). `ranked` is in rank order.
export function collapseVersions(ranked, query = "") {
  // Only when the kept row matches at least as well: a revision that alone holds every query
  // word (new Update 18 text) stays beside an in-force row that matched in part.
  const wantU18 = UPDATE_18_QUERY.test(String(query));
  const byId = new Map(ranked.map((r) => [r.obligation_id, r]));
  const covers = (keep, drop) => keep && (keep.match === "all_terms" || drop.match !== "all_terms");
  return ranked.filter((r) => {
    const id = String(r.obligation_id ?? "");
    if (id.endsWith(VERSION_SUFFIX)) return wantU18 || !covers(byId.get(id.slice(0, -VERSION_SUFFIX.length)), r);
    return !wantU18 || !covers(byId.get(id + VERSION_SUFFIX), r);
  });
}

export function orderVersions(scored, query = "") {
  const byId = new Map(scored.map((x) => [x.r.obligation_id, x]));
  const wantU18 = UPDATE_18_QUERY.test(String(query));
  for (const x of scored) {
    const id = String(x.r.obligation_id ?? "");
    if (!id.endsWith(VERSION_SUFFIX)) continue;
    const inForce = byId.get(id.slice(0, -VERSION_SUFFIX.length));
    if (!inForce) continue;
    const [lower, upper] = wantU18 ? [inForce, x] : [x, inForce];
    if (lower.s >= upper.s) lower.s = upper.s * 0.99;
  }
  return scored;
}

// Order rules over scored candidates [{r, s}] (Round 4). Each only LOWERS a score (or, for a
// cited register, raises it to the top), so no rule can promote an unrelated row.
//   superseded     a row whose register was superseded by one present in the list scores at
//                  most STALE_FACTOR x that replacement's best row (stress2 Q46).
//   update 18      an Update 18 revision (<id>::update-18) scores just below its in-force
//                  text; the reverse when the query names Update 18 (stress3 RANK-01: the
//                  optional revision led every dual-version search by a hair).
//   cited          rows of a register the query cites rank above everything else, in their
//                  own order (document order for a bare citation).
export function orderRules(scored, { query = "", cited = new Set(), citationOnly = false, pinned = new Set() } = {}) {
  clampSuperseded(scored);
  orderVersions(scored, query);
  if (cited.size) {
    const top = Math.max(0, ...scored.filter((x) => !cited.has(x.r.register_id)).map((x) => x.s));
    const mine = scored.filter((x) => cited.has(x.r.register_id));
    if (citationOnly) mine.sort((a, b) => (a.r.rid ?? 0) - (b.r.rid ?? 0));
    else mine.sort((a, b) => b.s - a.s);
    // A pinpoint's own obligation first (citation-anchored search, 2026-09-30).
    if (pinned.size) mine.sort((a, b) => pinned.has(b.r.obligation_id) - pinned.has(a.r.obligation_id));
    mine.forEach((x, i) => { x.s = (top + 1) * CITED_BOOST * (1 - i / (mine.length + 1)); });
  }
  return scored;
}

// "all_terms" / "partial" (+ missing_terms: the user's own words for each group the row
// lacks) from the coverage mask; a strict row is all_terms by construction.
function labelMatch(r, groups) {
  if (r.strict) return { ...r, match: "all_terms" };
  const cov = coverageOf(r, groups.length);
  if (!cov) return { ...r, match: "partial" };
  if (cov.matched.length === groups.length) return { ...r, match: "all_terms" };
  const have = new Set(cov.matched);
  const missing = groups.map((g, i) => (have.has(i) ? null : g.tokens.join(" "))).filter(Boolean);
  return { ...r, match: "partial", ...(missing.length ? { missing_terms: missing } : {}) };
}

// Section title first so it is the first thing a model reads per hit. `currency` is the
// short form (kind, headline, dates) or null; get_obligation carries the full detail.
// `version` (src/versions.js): on a dual-version section's hit, "in-force" or
// "update-18-optional" and the other version's obligation_id -- a hit on revision text must
// never read as the rule in force by default.
export function shapeResult(r, versions) {
  const {
    section, register_id, obligation_id, excerpt, match, missing_terms,
    canonical_id: _canonical, text_key: _key, also_at, rid: _rid, cov_mask: _cov,
    title_mask: _title, strict: _strict, register_title: _rt, reg_title_cov: _rtc, program,
    superseded_by: _sb, stub_text: _stub, phrase_hit: _ph, fit: _fit, title_cov: _tc,
    stale_exempt: _se, coverage_tier: _ct, legacy: _lg, section_status, section_status_date, register_currency_kind: _rck,
    type_factor: _tf, lead_text: _lead, segment_factor: _sf, servicing_factor: _svf,
    subhead: _sh, own_title_cov: _otc, quote_factor: _qf, wshare: _ws, law_factor: _lf,
    ...rest
  } = withoutCurrency(r);
  const obligation_type = obligationType(obligation_id);
  return {
    section, register_id, obligation_id, ...versionBrief(obligation_id, versions),
    excerpt: cleanExcerpt(excerpt), match,
    canonical_citation: canonicalCitation({ register_id, register_title: _rt, section, authority: rest.authority }),
    // The section's page on claudeforcompliance.com (src/sourceurl.js).
    page_url: pageUrl(register_id, obligation_id),
    ...(missing_terms ? { missing_terms } : {}),
    // A special program's section the query did not name, ranked down (C4C-14).
    ...(program ? { special_program: program } : {}),
    // Same-text copies of this result that were dropped from the list (src/aliases.js).
    ...(also_at?.length ? { also_at } : {}),
    // A "Section N is deleted." stub (deletedStub), ranked last: not a rule.
    ...(section_status ? { section_status, ...(section_status_date ? { section_status_date } : {}) } : {}),
    // Not rule text: a statute's editorial notes, or a chapter heading (NOTE_FACTOR).
    ...(obligation_type ? { obligation_type } : {}),
    ...rest,
    currency: currencyOf(r),
  };
}

export function registerSearchTools(server, env) {
  server.registerTool(
    "search_regs",
    {
      description:
        "Full-text search of US mortgage regulator text (Fannie Mae, Freddie Mac, FHA, VA, " +
        "USDA, Ginnie Mae, SBA, CFPB). Inputs: `query`; optional `family` (one agency), " +
        "`limit` (1-25), `currency_kind` (only sections carrying that currency signal; " +
        "\"any\" = any signal). Common abbreviations (DTI, LTV, IRRRL, W-2, VOE, PITI, BK...) " +
        "are expanded to the regulator's terms. Each result is one section: title, " +
        "`obligation_id`, `canonical_citation` (the citation in the regulator's style, or " +
        "null) and `excerpt`, a verbatim fragment near the match, not the whole rule. `match` " +
        "is \"all_terms\" or \"partial\"; a partial result lists the query words it lacks in " +
        "`missing_terms`. Order: `rank_score`, highest first = text score (title-weighted) x " +
        "term coverage x title fit, with superseded, pending, incorporated or expired text " +
        "x0.2, a special program's section (`special_program`: " +
        "Home Possible, HomeReady, 203(k), HECM...) x0.5 unless the query names the program, " +
        "and `obligation_type` \"note\" (source-credit notes) or " +
        "\"index\" (a chapter heading) x0.2 unless the query asks for them. `section_status` " +
        "\"deleted\" marks a deleted-section stub, ranked last. A query that is a citation " +
        "returns the cited section first and sets " +
        "`cited`; a bare handbook name (\"HUD 4000.1\") adds `handbook`, an outline of its " +
        "parts. `currency` is null or a version/status signal whose kinds include " +
        "dual-version, pending, revision-pending, superseded, superseded-in-part (a Mortgagee " +
        "Letter replaced some provisions, named in `headline`), modified-by (a later issuance " +
        "changes it, optional until its mandatory date) and expired. `version` \"in-force\" or " +
        "\"update-18-optional\" marks the two texts of an FHA section HUD's Update 18 revises " +
        "(`mandatory_date` for the revision); `other_version` is the other text's " +
        "obligation_id. Empty results carry `reason` (empty_query, no_match, " +
        "no_match_above_threshold) and may carry `guidance` naming shorthand in the query.",
      inputSchema: {
        query: z.string().min(1),
        family: z.enum(["hud", "hudmf", "va", "fnma", "fhlmc", "gnma", "usda", "sba"]).optional()
          .describe("hud = HUD/FHA Single Family (Handbook 4000.1, Mortgagee Letters); hudmf = HUD/FHA " +
            "Multifamily (MAP Guide 4430.G, multifamily Mortgagee Letters); va; fnma = Fannie Mae; fhlmc = Freddie Mac; " +
            "gnma = Ginnie Mae; usda; sba."),
        limit: z.number().int().min(1).max(25).optional(),
        currency_kind: z.enum(CURRENCY_KINDS).optional()
          .describe("Restricts results to sections carrying this currency signal; \"any\" = any signal."),
      },
    },
    async ({ query, family, limit, currency_kind }) => ({
      content: [{ type: "text", text: JSON.stringify(
        await searchRegs(env, { query, family, limit, currency_kind }),
      ) }],
    }),
  );
}

// ---- Batch 5 ranking rules (2026-09-27; stress tests #4 and #5) ----
//
// SEGMENT_FACTOR   Ginnie Mae MBS Guide chapters 30-35 are special pool types (manufactured
//                  home, project, construction, initiatives, special assistance, HECM): x0.5
//                  unless the query names that segment (stress5 Q48: Ch. 33 topped "issuer
//                  eligibility requirements maintain approval", Ch. 3 at rank 5).
// SERVICING_FACTOR a Fannie Servicing Guide topic, when the query has no servicing words: x0.5,
//                  and x ORIGINATION_FACTOR when it also has origination words ("guidelines",
//                  "waiting period", "qualify" ...) -- "chapter 7 bankruptcy guidelines" is the
//                  underwriting waiting period (B3-5.3-07), not Servicing E-2.2-01 "Managing
//                  Chapter 7 Bankruptcies", unless the question is about servicing.
// SUBHEADINGS      every query word within one short run of a Fannie topic's list of
//                  subheadings ("This topic contains ..., including: ... Evaluating Large
//                  Deposits ... Bankruptcy (Chapter 7 or Chapter 11) ...") counts as a title
//                  that names the whole query (TITLE_BOOST and SUBJECT_BOOST in combinedScore):
//                  the subheadings say what a topic covers as plainly as its title does (stress2
//                  I-07: Depository Accounts under Earnest Money for "large deposit").
export const SEGMENT_FACTOR = 0.5;
export const SERVICING_FACTOR = 0.5;
export const ORIGINATION_FACTOR = 0.1;
export const SUBHEAD_WINDOW = 6;

const GNMA_SEGMENTS = {
  30: /\bmanufactured\b|\bmh\b/i,
  31: /\bprojects?\b|\bmultifamily\b|\bmulti-family\b/i,
  32: /\bconstruction\b|\bmultifamily\b|\bmulti-family\b/i,
  33: /\binitiatives?\b|\bspecial provisions?\b/i,
  34: /\bspecial assistance\b|\bassistance programs?\b/i,
  35: /\bhecm\b|\breverse\b|\bhome equity conversion\b/i,
};
export function gnmaSegmentFactor(registerId, query) {
  const m = String(registerId ?? "").match(/^gnma-mbs-ch(\d{2})$/);
  const re = m && GNMA_SEGMENTS[Number(m[1])];
  if (!re) return 1;
  const q = String(query ?? "");
  return re.test(q) || new RegExp(`\\bch(?:apter)?\\.?\\s*${Number(m[1])}\\b`, "i").test(q) ? 1 : SEGMENT_FACTOR;
}

const SERVICING_QUERY = new RegExp(String.raw`\b(?:servic\w*|loan administrat\w*|delinquen\w*|default\w*|loss mitigation|` +
  String.raw`forbearance|modification\w*|foreclos\w*|reo|remit\w*|investor report\w*|payoff\w*|` +
  String.raw`escrow\w*|claims?|conveyance|collections?|workout\w*|short sales?|deed in lieu|` +
  String.raw`preforeclosure|deferral|repayment plans?|assum\w*|transfer of ownership|` +
  String.raw`inspections?|property preservation|vacant|abandon\w*|drafting|late charges?|partial claims?)\b`, "i");
const ORIGINATION_QUERY = /\b(?:guidelines?|underwrit\w*|qualif\w*|eligib\w*|waiting periods?|seasoning|originat\w*|borrower get|get (?:a|another) (?:loan|mortgage))\b/i;
// Batch 8 (stress6 C06 N8): FHA 4000.1 Parts III (Servicing and Loss Mitigation) and IV
// (Claims) and the VA Servicer Handbook M26-4 yield too, but only to a query with origination
// words and no servicing words: "fha late payments guidelines" is the underwriting
// payment-history rule, not III.C "Late Charges".
const OTHER_SERVICING = /^(?:hud-4000-1-(?:iii|iv)-|va-m26-4-)/;
// Batch 11 (stress6 C06 R8): the mirror case. Reg Z 1026.37 / 1026.38 set the CONTENT of the
// Loan Estimate and Closing Disclosure (origination forms); their ARM tables name "interest
// rate", "adjustment" and "loan" in their titles, so a post-consummation question in servicing
// words ("loan administrators interest rate resets rollovers rate change notices") put
// 1026.37(j) above the servicer's notice rule 1026.20(c). A query with servicing or
// post-consummation words and nothing naming the forms or origination: x SERVICING_FACTOR.
const TRID_FORMS = /^reg-z-1026-3[78]$/;
const POST_CONSUMMATION_QUERY = /\b(?:resets?|rollovers?|(?:rate|payment) (?:change|adjustment) notices?|periodic statements?|post-?consummation|after (?:closing|consummation))\b/i;
const TRID_QUERY = /\b(?:loan estimates?|closing disclosures?|trid|le|cd|integrated disclosures?|applications?|consummation|closing costs?|projected payments?)\b/i;
const AFTER_CONSUMMATION = /\b(?:post-?consummation|after (?:closing|consummation))\b/gi;
export function tridFormsFactor(registerId, query) {
  if (!TRID_FORMS.test(String(registerId ?? ""))) return 1;
  const q = String(query ?? "");
  if (TRID_QUERY.test(q.replace(AFTER_CONSUMMATION, " ")) || ORIGINATION_QUERY.test(q)) return 1;
  return SERVICING_QUERY.test(q) || POST_CONSUMMATION_QUERY.test(q) ? SERVICING_FACTOR : 1;
}

export function servicingFactor(registerId, query) {
  const trid = tridFormsFactor(registerId, query);
  if (trid !== 1) return trid;
  const id = String(registerId ?? "");
  const fnma = /^fnma-svc-/.test(id);
  if (!fnma && !OTHER_SERVICING.test(id)) return 1;
  const q = String(query ?? "");
  if (SERVICING_QUERY.test(q)) return 1;
  if (ORIGINATION_QUERY.test(q)) return ORIGINATION_FACTOR;
  return fnma ? SERVICING_FACTOR : 1;
}

// The list of subheadings a Fannie topic opens with ("This topic contains ..., including: A B C
// <first heading>"), the intro sentence unbroken up to its colon.
export function subheadList(lead) {
  const m = String(lead ?? "").match(/\bThis topic contains [^:.]{0,300}?:\s*([^]{0,500})/);
  return m ? m[1] : "";
}
// Every query token (2-4 of them) within SUBHEAD_WINDOW consecutive words of the list, the
// run starting on one of them. A token matches a word it starts ("deposit" ~ "Deposits").
export function subheadHit(lead, tokens, registerId = "fnma-") {
  if (!/^fnma-/.test(String(registerId))) return false;
  const toks = (tokens ?? []).map((t) => String(t).toLowerCase()).filter(Boolean);
  if (toks.length < 2 || toks.length > 4) return false;
  const list = subheadList(lead);
  if (!list) return false;
  const words = list.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const hit = (w, t) => (/^\d/.test(t) ? w === t : w.startsWith(t.length > 5 ? t.slice(0, -1) : t));
  for (let i = 0; i < words.length; i++) {
    if (!toks.some((t) => hit(words[i], t))) continue;
    const win = words.slice(i, i + SUBHEAD_WINDOW);
    if (toks.every((t) => win.some((w) => hit(w, t)))) return true;
  }
  return false;
}

// Rules over the ordered candidates [{ r, s }] (after orderRules). Each only lowers a score,
// except CROSS-REFERENCE, which lifts a section just above the one that points to it.
//   CHUNKS          a Fannie/Freddie topic's chunk obligations ("<id>-3") collapse into the
//                   topic's full obligation ("<id>-full") when it is a candidate: the full row
//                   takes the best of their scores and the chunks leave the list (stress4 Q14:
//                   all six results for "ipc fannie mae" were B3-4.1-02). With no full row, a
//                   register keeps its best chunk only.
//   FRAGMENTS       a short obligation (< FRAGMENT_MAX_CHARS) ranks below a candidate at least
//                   twice as long that carries the same citation (stress5 I06: the 109-char
//                   fnma-svc-d2-1 fragment above the full D2-1-01).
//   INDEX           an index obligation (obligationType "index": a chapter register or redirect
//                   stub) never outranks a topic's text unless the query asks for the chapter.
//   CROSS-REFERENCE a section whose matched excerpt says "see / refer to <cite>" hands the rank
//                   to that cited section when it is a candidate: B3-3.4-09 "For additional
//                   information on short-term disability, see B3-3.3-09"; the Servicing Guide's
//                   "Refer to Selling Guide B7-3-03" -- when the pointer's sentence names a query
//                   word that the pointing section's own title does not.
export const FRAGMENT_MAX_CHARS = 400;
// EXCERPTS (batch 8, stress6 C19): the curated excerpt registers (fnma-svc-d2-2, fnma-svc-e-4,
// fnma-svc-c-2 ...) hold short passages of Guide topics under digest titles ("FNMA Servicing
// Guide D2-2-02 — Begin outbound contact by day 36 ..."), undated and often mid-sentence. When
// the topic's full text is a candidate, the excerpt row leaves the list (the full section
// carries the same words); with no full copy it stays, without title credit (annotator).
const EXCERPT_SECTION = /^(?:FNMA|FHLMC)\s/;
export function isExcerpt(r) {
  return EXCERPT_SECTION.test(String(r?.section ?? ""));
}
const CHUNK_ID = /-\d+$/;
const FULL_ID = /-full$/;
// Batch 13 (eval B15): "-full-2" is a later VERSION of the full text (Freddie future-effective
// sections), not a chunk of it -- folding it into "-full" lent the superseded text the in-force
// version's score ("QRPC": superseded 8404.1 ranked #1).
const VERSION_ID = /-full-\d+$/;
// Fannie cites only: the Freddie Guide cross-references on nearly every line ("as described
// in Section 5401.1"), so a Freddie pointer says little about which section answers.
const XREF = /\b(?:see|refer to|refers to)\b[^.;]{0,80}?\b([A-F]\d{0,2}-\d(?:\.\d{1,2})?-\d{2})\b/gi;

const UAD_DOC = /^(?:fnma-uad-3-6-policy-supplement|uad-3-6-(?:reference|implementation|report-style)-guide)$/;
export const isUadDoc = (id) => UAD_DOC.test(String(id ?? ""));
export const APPRAISAL_QUERY = /\b(?:apprais\w*|uad|urar|ucdp|valuation|comparables?|comps|condition rating|quality rating|c[1-6]|q[1-6]|gla|gross living area|square (?:feet|footage)|sketch|inspection|appendix [a-z]-\d|report field|property data|adu|accessory dwelling)\b/i;

function suffix(id) {
  const s = String(id ?? "");
  return s.slice(s.indexOf("::") + 2);
}

export function batch5Rules(scored, { query = "", cited = new Set(), tokens = [] } = {}) {
  let list = scored;
  const qtoks = (tokens ?? []).filter((t) => String(t).length >= 3).map((t) => String(t).toLowerCase());
  // CHUNKS
  const fullOf = new Map();
  for (const x of list) if (FULL_ID.test(suffix(x.r.obligation_id))) fullOf.set(x.r.register_id, x);
  const bestChunk = new Map();
  const drop = new Set();
  for (const x of list) {
    const suf = suffix(x.r.obligation_id);
    if (!CHUNK_ID.test(suf) || FULL_ID.test(suf) || VERSION_ID.test(suf) || cited.has(x.r.register_id)) continue;
    if (!/^(?:fnma|fhlmc)-/.test(String(x.r.register_id))) continue;
    const full = fullOf.get(x.r.register_id);
    if (full) { full.s = Math.max(full.s, x.s); drop.add(x); continue; }
    const b = bestChunk.get(x.r.register_id);
    if (!b) bestChunk.set(x.r.register_id, x);
    else if (x.s > b.s) { drop.add(b); bestChunk.set(x.r.register_id, x); } else drop.add(x);
  }
  list = list.filter((x) => !drop.has(x));
  // FRAGMENTS
  const cite = (r) => canonicalCitation({ register_id: r.register_id, register_title: r.register_title,
    section: r.section, authority: r.authority });
  const cites = list.map((x) => cite(x.r));
  list.forEach((x, i) => {
    const len = Number(x.r.chars_total) || 0;
    if (!cites[i] || len >= FRAGMENT_MAX_CHARS || cited.has(x.r.register_id)) return;
    for (let j = 0; j < list.length; j++) {
      const y = list[j];
      if (j !== i && cites[j] === cites[i] && (Number(y.r.chars_total) || 0) >= 2 * len && x.s >= y.s) {
        x.s = y.s * 0.99;
      }
    }
  });
  // EXCERPTS
  const fullCites = new Set(list.map((x, i) => (!isExcerpt(x.r) && cites[i] ? cites[i] : null)).filter(Boolean));
  const excerptDrop = new Set(list.filter((x, i) => isExcerpt(x.r) && cites[i] && fullCites.has(cites[i]) &&
    !cited.has(x.r.register_id)));
  if (excerptDrop.size) {
    const keep = list.map((x, i) => [x, cites[i]]).filter(([x]) => !excerptDrop.has(x));
    list = keep.map(([x]) => x);
    cites.splice(0, cites.length, ...keep.map(([, c]) => c));
  }
  // INDEX
  if (!INDEX_QUERY.test(String(query))) {
    const topic = list.filter((x) => obligationType(x.r.obligation_id) !== "index" && x.s > 0);
    const floor = topic.length ? Math.min(...topic.map((x) => x.s)) : 0;
    for (const x of list) {
      if (obligationType(x.r.obligation_id) === "index" && !cited.has(x.r.register_id) && floor > 0) {
        x.s = Math.min(x.s, floor * 0.99);
      }
    }
  }
  // UAD (batch 18): the UAD 3.6 appraisal documents -- the Selling Guide UAD 3.6 Policy
  // Supplement (its topics restate Guide policy on boarders, dividends, K-1s, leaseholds ...),
  // the URAR reference / implementation / style guides -- answer appraisal questions only. For
  // a query with no appraisal word they rank below every other candidate ("can a pastor's
  // housing allowance count as income" topped on the 800K-char URAR guide).
  if (!APPRAISAL_QUERY.test(String(query))) {
    const other = list.filter((x) => !isUadDoc(x.r.register_id) && x.s > 0);
    const floor = other.length ? Math.min(...other.map((x) => x.s)) : 0;
    for (const x of list) {
      if (isUadDoc(x.r.register_id) && !cited.has(x.r.register_id) && floor > 0) x.s = Math.min(x.s, floor * 0.98);
    }
  }
  // CROSS-REFERENCE (one hop, visiting rows best first)
  const byCite = new Map();
  // Batch 8 (C07): a cite names the CURRENT section -- a superseded or stale copy that shares
  // the citation is never the lift target.
  const current = (x) => !x.r.superseded_by && !isStale(x.r);
  list.forEach((x, i) => {
    if (!cites[i]) return;
    const had = byCite.get(cites[i]);
    if (!had || (current(x) && !current(had))) byCite.set(cites[i], x);
  });
  const ordered = [...list].sort((a, b) => b.s - a.s);
  const lifted = new Set();
  for (const x of ordered) {
    if (cited.has(x.r.register_id) || lifted.has(x)) continue;
    const ex = String(x.r.excerpt ?? "");
    for (const m of ex.matchAll(XREF)) {
      const y = byCite.get(m[1]);
      // The pointer must be about the question: its sentence (with the cited title after the
      // cite) names a query word -- "For additional information on short-term disability, see
      // B3-3.3-09" -- not an aside ("See B3-4.1-04, Virtual Currency").
      const from = Math.max(ex.lastIndexOf(".", m.index), ex.lastIndexOf(";", m.index)) + 1;
      const tail = ex.slice(m.index + m[0].length).search(/[.;]/);
      const sentence = ex.slice(from, tail === -1 ? ex.length : m.index + m[0].length + tail).toLowerCase();
      // ... and a word the pointing section's own title does not (short-term disability is not
      // what "Long-term Disability Income" covers; "disability income" is).
      const title = String(shortTitle(x.r.section) || "").toLowerCase();
      const has = (str, t) => str.includes(t.length > 5 ? t.slice(0, -1) : t);
      if (!qtoks.some((t) => has(sentence, t) && !has(title, t))) continue;
      if (!y || !current(y) || y === x || y.r.register_id === x.r.register_id || y.s >= x.s || lifted.has(y)) continue;
      y.s = x.s * 1.01;
      lifted.add(y);
      break;
    }
  }
  return list;
}
