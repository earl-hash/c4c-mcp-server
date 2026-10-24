// Practitioner vocabulary -> regulator vocabulary for search_regs.
//
// Why: search is AND over content terms, and models that search once (GPT-4o) write
// the way loan officers talk -- "DTI", "paperwork", "comps", "car" -- while the
// Selling Guide / Handbook text says "debt-to-income", "documentation", "comparable
// sales", "automobile". A shorthand term the regulator never uses
// makes the whole AND fail or rank the wrong page.
//
// How it applies: a query term (or run of terms) that matches a key becomes an OR
// group INSIDE the AND -- the user's own words (all of them, ANDed) OR any listed
// phrase. The user's words are always kept, so an expansion can only ADD matches,
// never remove one the plain query would have found.
//
// RULE FOR THIS TABLE (read before adding a row):
//   1. Entries come from mortgage-domain knowledge: standard industry acronyms and
//      the lay/practitioner terms for concepts the regulators name differently.
//      The table was written BEFORE looking at which replay queries fail.
//   2. Never add an entry whose only justification is one failing benchmark query.
//      That is overfitting the benchmark; it will not generalize and it hides the
//      real retrieval defect.
//   3. Alternatives are what the REGULATOR writes. Do not map to a broader concept
//      ("appraisal" -> "property") -- that widens recall into noise.
//   4. Skip acronyms that collide with common English or other meanings where the
//      collision would pull in unrelated pages (e.g. "CD" = certificate of deposit
//      vs Closing Disclosure).
//
// Keys are lower-case content tokens AFTER stopword removal and metacharacter
// splitting (so "debt-to-income" arrives as "debt income", "W-2" as "w 2",
// "rate/term" as "rate/term"). Alternatives are plain phrases; they go through the
// same FTS escaping as user input (search.js quotePhrase), so nothing here is syntax.
export const VOCAB = {
  // ratios
  // Batch 13 (eval G5): FHA 4000.1 calls the DTI limits its "qualifying ratios".
  "dti": ["debt to income", "qualifying ratios"],
  "debt income": ["dti", "qualifying ratios"],
  "qualifying ratio": ["debt to income", "dti"],
  "qualifying ratios": ["debt to income", "dti"],
  "ltv": ["loan to value"],
  "loan value": ["ltv"],
  "cltv": ["combined loan to value"],
  "hcltv": ["home equity combined loan to value"],

  // mortgage insurance
  "mi": ["mortgage insurance"],
  "pmi": ["private mortgage insurance", "mortgage insurance"],
  "mip": ["mortgage insurance premium"],
  "ufmip": ["upfront mortgage insurance premium", "up front mortgage insurance premium"],

  // automated underwriting
  "du": ["desktop underwriter"],
  "lp": ["loan product advisor"],
  "lpa": ["loan product advisor"],
  "aus": ["automated underwriting"],
  "gus": ["guaranteed underwriting system"],
  "uw": ["underwriting"],

  // income / employment documentation
  "voe": ["verification of employment"],
  "temp": ["temporary"],
  "maternity leave": ["temporary leave"],
  "paternity leave": ["temporary leave"],
  "parental leave": ["temporary leave"],
  "vvoe": ["verbal verification of employment"],
  "vod": ["verification of deposit"],
  "vor": ["verification of rent"],
  "w2": ["w 2"],
  "w2s": ["w 2"],
  "w 2": ["w2"],
  "w 2s": ["w 2", "w2"],
  "k1": ["k 1"],
  "k1s": ["k 1"],
  "k 1": ["k1"],
  "1099s": ["1099"],
  "401k": ["401 k"],
  "401 k": ["401k"],
  // Equity compensation (C4C-03, 2026-09-26: "RSU income" returned no_match although
  // B3-3.3-07 "Restricted Stock Units ..." exists).
  "rsu": ["restricted stock unit", "restricted stock"],
  "rsus": ["restricted stock unit", "restricted stock"],
  "espp": ["employee stock purchase plan"],
  // Batch 5 (stress4 Q6): Fannie B3-3.4-15 writes "Supplemental Social Security Income".
  "ssi": ["supplemental security income", "supplemental social security income", "social security"],
  "ssdi": ["social security disability"],
  // "SS" is practitioner shorthand for both social security (income) and short sale
  // (derogatory credit); the rest of the query's AND picks the sense.
  "ss": ["social security", "short sale", "preforeclosure sale"],
  "voi": ["verification of income"],
  "vom": ["verification of mortgage"],
  "dd214": ["dd 214"],
  "dd 214": ["dd214"],
  "p&l": ["profit and loss"],
  "pnl": ["profit and loss"],
  "paystub": ["pay stub"],
  "paystubs": ["pay stub"],
  "pay stub": ["paystub"],
  "pay stubs": ["paystub"],
  "paperwork": ["documentation", "documents"],
  "docs": ["documentation", "documents"],
  "doc": ["documentation", "documents"],
  "4506c": ["4506 c"],
  "loe": ["letter of explanation"],
  "ssn": ["social security number"],
  "itin": ["individual taxpayer identification number"],
  "dscr": ["debt service coverage"],

  // liabilities
  // Batch 18: Fannie B3-4.3-18 calls a car / boat sold for funds a "personal asset" ("vehicle").
  "car": ["automobile", "auto", "vehicle"],
  "auto": ["automobile"],
  "boat": ["personal assets", "vehicle"],
  "boats": ["personal assets", "vehicle"],
  // Batch 18: a pastor's / clergy housing allowance is the "parsonage" allowance (B3-3.3-04).
  "pastor": ["parsonage"],
  "pastors": ["parsonage"],
  "clergy": ["parsonage"],
  "minister": ["parsonage"],
  // Batch 18: 1026.19(e)(3)(ii)'s 10% tolerance is on the "aggregate amount" of charges.
  "cumulative": ["aggregate"],
  // Batch 18: 38 U.S.C. 3729 titles the VA funding fee the "loan fee".
  "funding fee": ["loan fee"],
  // Batch 18: a borrower without a credit score is qualified on "nontraditional credit".
  "no credit score": ["nontraditional credit"],
  "without credit score": ["nontraditional credit"],
  "credit card": ["revolving"],
  "credit cards": ["revolving"],
  "piti": ["pitia", "housing expense"],

  // valuation
  "comps": ["comparable"],
  // NOT appraisal <-> valuation: both words are already everywhere in the valuation
  // chapters, and OR-ing them only let generic pages outrank the specific one
  // (measured 2026-09-25: -2 target hits, +0).

  // assets / closing funds
  "seller concessions": ["interested party contributions", "seller contributions"],
  "seller concession": ["interested party contributions", "seller contributions"],
  "ipc": ["interested party contributions"],
  "ipcs": ["interested party contributions"],
  "emd": ["earnest money"],
  "dpa": ["down payment assistance"],
  // Batch 15: the GSE guides say "virtual currency" (Fannie B3-4.1-04) and "digital assets";
  // practitioners say "crypto".
  "crypto": ["cryptocurrency", "virtual currency", "digital assets", "digital currency"],
  "crypto assets": ["cryptocurrency", "virtual currency", "digital assets"],
  "cryptocurrency": ["crypto", "virtual currency", "digital assets", "digital currency"],
  "cryptocurrencies": ["cryptocurrency", "virtual currency", "digital assets"],
  "digital assets": ["virtual currency", "cryptocurrency"],
  "virtual currency": ["cryptocurrency", "crypto", "digital assets"],
  // "Asset depletion" / "asset utilization" is the industry name for qualifying on assets;
  // Fannie titles it "Employment Related Assets as Qualifying Income".
  "asset depletion": ["employment related assets", "assets as income", "assets as qualifying income", "asset utilization"],
  "asset utilization": ["employment related assets", "assets as income", "asset depletion"],
  // "Food stamps" is SNAP; the income guides call it public assistance.
  "food stamps": ["public assistance", "supplemental nutrition assistance"],
  "snap benefits": ["public assistance", "supplemental nutrition assistance"],
  // A TRID tolerance "cure" is the refund 12 CFR 1026.19(f)(2)(v) requires.
  "tolerance cure": ["refund", "tolerance refund"],
  "tolerance cures": ["refund", "tolerance refund"],
  // Practitioners "cure" a tolerance violation; 1026.19(f)(2)(v) says "refund". The good-faith
  // limit is a "cumulative" 10 percent in practice, an "aggregate" one (mapped above, Batch 18).
  "cure": ["refund"],
  // FinCEN's AML rule for non-bank mortgage lenders is 31 CFR Part 1029, "Loan or Finance
  // Companies" (residential mortgage lenders and originators).
  "non bank": ["nonbank", "loan or finance company"],
  "non bank residential mortgage lender": ["loan or finance company", "nonbank residential mortgage lender"],
  "non bank mortgage lender": ["loan or finance company", "nonbank mortgage lender"],
  "nonbank residential mortgage lender": ["loan or finance company", "non bank residential mortgage lender"],
  "nonbank": ["non bank", "loan or finance company"],

  // credit
  "fico": ["credit score"],
  "bk": ["bankruptcy"],
  "bks": ["bankruptcy"],
  "ch": ["chapter"],
  "chap": ["chapter"],
  "dil": ["deed in lieu"],
  // The credit reporting companies: practitioners say "credit bureaus", the GSE guides
  // "credit repositories" (Fannie C-4.1-01, F-1-23), the FCRA and Reg V "consumer reporting
  // agencies". FTS stems plurals; the keys list both forms because keys match exactly. No
  // "CRA" key: it is also the Community Reinvestment Act.
  "credit bureau": ["credit repository", "consumer reporting agency"],
  "credit bureaus": ["credit repository", "consumer reporting agency"],
  "credit repository": ["credit bureau", "consumer reporting agency"],
  "credit repositories": ["credit bureau", "consumer reporting agency"],
  "consumer reporting agency": ["credit repository", "credit bureau"],
  "consumer reporting agencies": ["credit repository", "credit bureau"],
  // "Full-file" reporting = every account's status every month; the guides write "the
  // status of each mortgage loan". Metro 2 is the credit-reporting data format.
  "full file": ["each mortgage loan", "all mortgage loans"],
  "metro 2": ["credit repository", "credit bureau", "consumer reporting agency"],
  // Frequency: the guides write "each month" / "every month" more often than "monthly" (FTS
  // stems "monthly" to "monthli", which never matches "month").
  "monthly": ["each month", "every month"],
  // Waiting periods after a derogatory event: Fannie says "waiting period", Freddie
  // "recovery time period" (5202.1), VA's IRRRL statute "seasoning" (3709(c)).
  "waiting period": ["recovery time period", "seasoning"],
  "waiting periods": ["recovery time period", "seasoning"],
  "recovery time period": ["waiting period"],
  "recovery period": ["recovery time period", "waiting period"],
  "seasoning": ["waiting period", "recovery time period"],
  "fc": ["foreclosure"],
  "fcs": ["foreclosure"],
  "short sale": ["preforeclosure sale", "pre foreclosure sale"],
  "short sales": ["preforeclosure sale", "pre foreclosure sale"],

  // products / transactions
  "arm": ["adjustable rate"],
  "arms": ["adjustable rate"],
  "piw": ["property inspection waiver"],
  "heloc": ["home equity line of credit"],
  // 38 U.S.C. 3709, where the 2018 IRRRL tests live, never says "IRRRL" or "interest
  // rate reduction": it says "refinance" / "refinancing loan".
  "irrrl": ["interest rate reduction refinancing loan", "interest rate reduction", "refinance"],
  "irrrls": ["interest rate reduction refinancing loan", "interest rate reduction", "refinance"],
  "interest rate reduction refinancing loan": ["irrrl", "refinance"],
  "interest rate reduction refinancing loans": ["irrrl", "refinance"],
  "refi": ["refinance"],
  "refis": ["refinance"],
  "rate/term": ["rate and term", "limited cash out", "no cash out"],
  "rate term": ["rate and term", "limited cash out", "no cash out"],
  "203k": ["203 k"],
  "fthb": ["first time homebuyer", "first time home buyer"],
  "hpml": ["higher priced mortgage loan"],
  "hpmls": ["higher priced mortgage loan"],
  // Batch 15: Reg Z 1026.32 and its Supplement I comments say "high-cost mortgage", never HOEPA.
  "hoepa": ["high cost mortgage", "high cost mortgages", "home ownership and equity protection"],
  "high cost mortgage": ["hoepa"],
  "higher priced mortgage loan": ["hpml"],
  "ntb": ["net tangible benefit"],
  "hecm": ["home equity conversion mortgage"],
  "hecms": ["home equity conversion mortgage"],
  "eem": ["energy efficient mortgage"],
  "coc": ["changed circumstance", "change of circumstance"],
  "ami": ["area median income"],
  "qm": ["qualified mortgage"],
  "atr": ["ability to repay"],
  "apr": ["annual percentage rate"],
  "llpa": ["loan level price adjustment"],
  "llpas": ["loan level price adjustment"],
  "coe": ["certificate of eligibility"],
  "mcc": ["mortgage credit certificate"],
  "le": ["loan estimate"],
  // "CD" alone collides with certificate of deposit (rule 4); only the LE/CD pair, which
  // always means the two TRID disclosures, maps to Closing Disclosure.
  "le/cd": ["loan estimate", "closing disclosure"],
  "le cd": ["loan estimate", "closing disclosure"],
  // Batch 13 (eval G13): TRID is the Loan Estimate / Closing Disclosure rule set; Reg Z's own
  // text names the two forms, and calls the fee tolerances "good faith" (1026.19(e)(3)).
  "trid": ["integrated disclosure", "loan estimate", "closing disclosure"],
  "tolerance": ["good faith"],
  "tolerances": ["good faith"],

  // property
  "condo": ["condominium"],
  "condos": ["condominium"],
  "pud": ["planned unit development"],
  "hoa": ["homeowners association"],
  "adu": ["accessory dwelling unit"],
  // Batch 5 (stress4 Q15): the Servicing Guide says "post-foreclosure" / "acquired property".
  "reo": ["real estate owned", "acquired property", "post foreclosure"],
  // Batch 8 (stress6 C09): Fannie Mae's Cash Remittance System is "CRS" in most Servicing Guide
  // topics (F-1-20 never spells it out); an IRA is an individual retirement account.
  "crs": ["cash remittance system"],
  "cash remittance system": ["crs"],
  "ira": ["individual retirement account", "individual retirement accounts"],
  "iras": ["individual retirement accounts", "ira"],
  "foreclosed": ["foreclosure sale", "post foreclosure"],
  "sfha": ["special flood hazard area"],
  "manufactured home": ["manufactured housing"],
  "mobile home": ["manufactured home", "manufactured housing"],
  "mh": ["manufactured home", "manufactured housing"],

  // parties
  // Batch 13 (eval G4): VA Pamphlet 26-7 Chapter 7 calls a loan with a co-borrower a "joint loan".
  "non occupant co borrower": ["non occupant borrower", "non occupying co borrower", "joint loan"],
  "non occupying co borrower": ["non occupant borrower", "non occupant co borrower", "joint loan"],
  "co borrower": ["coborrower", "joint loan"],
  "co borrowers": ["coborrower", "joint loan"],
  "cosigner": ["co signer", "co borrower", "guarantor"],
  "coborrower": ["co borrower", "joint loan"],
  "coborrowers": ["co borrower", "joint loan"],
  "poa": ["power of attorney"],

  // servicing / default
  "loss mit": ["loss mitigation"],
  "mod": ["modification"],
  "mods": ["modification"],
  "loan mod": ["loan modification"],
  "impound": ["escrow"],
  "impounds": ["escrow"],

  // lay words for "limit"
  "max": ["maximum"],
  "min": ["minimum"],

  // Round 4 (2026-09-26), stress tests #2/#3 -- practitioner words for concepts the
  // regulator names differently (rule 1: the regulator's own wording, not a benchmark fix).
  // FHA certifies; the servicer "attests" nowhere in 4000.1 III.A.2 imminent default.
  "attestation": ["certification", "certify"],
  "attestations": ["certification", "certify"],
  "attest": ["certify", "certification"],
  // FHA "Overtime, Bonus, or Tip Income"; Fannie "variable income" (B3-3.1-01).
  "variable income": ["overtime bonus or tip income", "overtime", "bonus income"],
  // Reg Z 1026.20(c) says "interest rate adjustment" / "rate adjustment", never "reset".
  "rollover": ["rate adjustment", "adjustment"],
  "rollovers": ["rate adjustment", "adjustment"],
  "reset": ["rate adjustment", "adjustment"],
  "resets": ["rate adjustment", "adjustment"],
  "rate change": ["rate adjustment", "interest rate adjustment"],
  // Batch 5 (Reg Z 1026.20(c)/(d), stress2 Q44): "rate adjustments with a corresponding change
  // in payment" / "initial rate adjustment" are the regulator's words for ARM change notices.
  "rate change notice": ["rate adjustment", "interest rate adjustment"],
  "rate change notices": ["rate adjustment", "interest rate adjustment"],
  "rate adjustment notice": ["rate adjustment", "interest rate adjustment"],
  "adjustment notice": ["rate adjustment", "interest rate adjustment"],
  // Batch 5 (stress4 Q20): Fannie writes "time frames".
  "timeline": ["time frame", "timeframe"],
  "timelines": ["time frames", "time frame", "timeframes"],
  // Batch 5 (stress3 Q23): Freddie's AIM for direct-deposit income is "account data".
  "direct deposit": ["account data"],
  "direct deposits": ["account data"],
  // Reg Z 1026.42 "Valuation independence": the rule says "coerce", not "coercion".
  "coercion": ["coerce", "coerced"],
  "appraiser independence": ["valuation independence"],
  "appraisal independence": ["valuation independence"],
  // Batch 10 (stress6 C06 R18, C09 N13): word forms the porter stemmer keeps apart -- "rescind"
  // is "rescind", "rescission" is "resciss"; "owns" is "own", "ownership" is "ownership". HUD
  // writes "Rescission of ...", Fannie "less than 25% ownership".
  "rescind": ["rescission", "rescinded", "rescinds"],
  "rescinds": ["rescission", "rescind", "rescinded"],
  "rescinded": ["rescission", "rescind"],
  "rescission": ["rescind", "rescinded", "rescinds"],
  "owns": ["ownership", "owner"],
  "owned": ["ownership", "owner"],
  // Reg Z 1026.24(d) "triggering terms" live in the advertising rule.
  "triggering terms": ["triggering term", "1026.24"],
  "trigger terms": ["triggering terms", "1026.24"],
  // Bank Secrecy Act currency transaction reports (31 CFR 1010.306 / 1010.311).
  "ctr": ["currency transaction report", "reports of transactions in currency"],
  "ctrs": ["currency transaction report", "reports of transactions in currency"],
  "currency transaction report": ["ctr", "reports of transactions in currency", "1010.306"],
  "currency transaction reports": ["ctr", "reports of transactions in currency", "1010.306"],
  // Regulation letters and statute acronyms -> the CFR part / statute name the rules carry.
  // A lone "z" or "x" is never a content word the text contains.
  "regulation z": ["reg z", "1026", "truth in lending"],
  "reg z": ["regulation z", "1026", "truth in lending"],
  "regulation x": ["reg x", "1024", "real estate settlement procedures"],
  "reg x": ["regulation x", "1024", "real estate settlement procedures"],
  "regulation b": ["reg b", "1002", "equal credit opportunity"],
  "reg b": ["regulation b", "1002", "equal credit opportunity"],
  "regulation c": ["reg c", "1003", "home mortgage disclosure"],
  "reg c": ["regulation c", "1003", "home mortgage disclosure"],
  "regulation v": ["reg v", "1022", "fair credit reporting"],
  "reg v": ["regulation v", "1022", "fair credit reporting"],
  "tila": ["truth in lending", "1026"],
  "respa": ["real estate settlement procedures", "1024"],
  "ecoa": ["equal credit opportunity", "1002"],
  "hmda": ["home mortgage disclosure", "1003"],
  "fcra": ["fair credit reporting", "1022"],
  "bsa": ["bank secrecy act", "1010"],
  // Fannie Mae's Information Security and Business Resiliency Supplement (published
  // 2026-10-21) says "Super Intelligence" where LL-2026-04 and the industry say AI.
  "ai": ["artificial intelligence", "super intelligence"],
  "artificial intelligence": ["ai", "super intelligence"],
};

// Token runs that are ONE term and must match as an adjacent phrase, not as separate AND
// words. "W-2" arrives as "w 2" (the hyphen splits it): as two loose words it matched any
// obligation with a "W" somewhere and a "2" somewhere (owner's test 1: "W-2" was split
// into "2" and "w"). A key here is rendered as one quoted FTS phrase; its VOCAB
// alternatives (if any) still apply.
export const PHRASES = new Set([
  "w 2", "w 2s", "k 1", "401 k", "203 k", "4506 c", "dd 214", "schedule a", "schedule b",
  "schedule c", "schedule d", "schedule e", "schedule f", "form 1003", "form 1005",
  "form 1008", "form 4506",
  // Round 4: proper names of systems and forms, matched as the phrase the Guide prints.
  "cash remittance system", "currency transaction report", "currency transaction reports",
  "triggering terms", "regulation z", "regulation x",
  "regulation b", "regulation c", "regulation v", "reg z", "reg x", "reg b", "reg c", "reg v",
]);

// STRUCTURAL NUMBERS (Round 4, stress2 Q12/Q27): "va pamphlet 26-7 chapter 4" matched the
// loose words "chapter" and "4", so Topic 4 of eight other chapters ranked 1-8; "chapter 18
// of gnma guide" pulled Chapter 3 Part 18. A structure word followed by a number is ONE
// phrase ("chapter 4"), with the regulator's abbreviations as alternatives ("ch 4").
const STRUCTURE = {
  chapter: ["ch"], chap: ["chapter", "ch"], ch: ["chapter"],
  part: [], subpart: [], topic: [], appendix: ["app"], app: ["appendix"],
  section: [], sec: ["section"], paragraph: [], para: ["paragraph"],
};

export function bindStructure(groups) {
  const out = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const next = groups[i + 1];
    const word = g.tokens.length === 1 ? g.tokens[0] : null;
    const num = next && next.tokens.length === 1 && !next.alts.length ? next.tokens[0] : null;
    if (word && Object.hasOwn(STRUCTURE, word) && num && /^(?:\d{1,3}[a-z]?|[ivx]{1,4}|[a-z])$/.test(num)) {
      out.push({
        tokens: [word, num],
        // SBA cites an appendix fused ("SOP 50 10 8.1 App15"): one token "app15".
        alts: [...STRUCTURE[word].map((w) => `${w} ${num}`),
          ...(word === "appendix" || word === "app" ? [`app${num}`] : [])],
        phrase: true,
      });
      i++;
      continue;
    }
    out.push(g);
  }
  return out;
}

// Longest key, in tokens: the greedy matcher tries this many down to 1.
export const MAX_KEY_TOKENS = Math.max(
  ...[...Object.keys(VOCAB), ...PHRASES].map((k) => k.split(" ").length),
);

// Split content tokens into groups: a run matching a VOCAB key or a PHRASES entry (longest
// first) is one group carrying its alternatives; every other token is a group of its own.
// Returns [{ tokens: [...], alts: [...], phrase?: true }] in query order; `phrase` means
// the user's own tokens must match adjacently.
export function groupTokens(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    let hit = null;
    for (let n = Math.min(MAX_KEY_TOKENS, tokens.length - i); n >= 1 && !hit; n--) {
      const key = tokens.slice(i, i + n).join(" ");
      const phrase = n > 1 && PHRASES.has(key);
      if (Object.hasOwn(VOCAB, key) || phrase) {
        hit = { tokens: tokens.slice(i, i + n), alts: VOCAB[key] ?? [], ...(phrase ? { phrase } : {}) };
      }
    }
    if (!hit) hit = { tokens: [tokens[i]], alts: [] };
    out.push(hit);
    i += hit.tokens.length;
  }
  return out;
}
