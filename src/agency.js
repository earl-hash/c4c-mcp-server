// Agency names in a query -> the family filter.
//
// A model writes "Fannie Mae DTI limit" and often ALSO passes family=fnma. Under AND,
// "fannie" and "mae" must then appear in the obligation text, which favours pages
// that happen to name the agency (overviews, special programs) over the rule itself --
// the Selling Guide's B3-6-02 does not say "Fannie Mae" near "debt-to-income". The
// agency is a filter, not a content term. Keys are content tokens (lower-case);
// a multi-token name is matched as a run. The family values are search_regs' enum
// (registers.family): fnma covers Selling AND Servicing Guide, hud covers FHA Single Family,
// hudmf covers HUD / FHA Multifamily (mf-1: its Mortgagee Letters keep hud-ml-* ids). The
// multifamily runs come before [["fha"]] / [["hud"]] (the first match wins). A bare
// "multifamily" is NOT an agency name: Ginnie Mae's MBS Guide has multifamily chapters.
export const AGENCY_NAMES = [
  [["fha", "multifamily"], "hudmf"],
  [["hud", "multifamily"], "hudmf"],
  [["map", "guide"], "hudmf"],
  [["fannie", "mae"], "fnma"],
  [["fannie"], "fnma"],
  [["fnma"], "fnma"],
  [["freddie", "mac"], "fhlmc"],
  [["freddie"], "fhlmc"],
  [["fhlmc"], "fhlmc"],
  [["ginnie", "mae"], "gnma"],
  [["ginnie"], "gnma"],
  [["gnma"], "gnma"],
  [["fha"], "hud"],
  [["hud"], "hud"],
  [["va"], "va"],
  [["usda"], "usda"],
  [["rural", "development"], "usda"],
  [["rd"], "usda"],
  [["sba"], "sba"],
];

// Split agency names out of the content tokens.
// Returns { tokens: remaining, families: Set of families named }.
export function extractAgencies(tokens) {
  const rest = [];
  const families = new Set();
  let i = 0;
  while (i < tokens.length) {
    const hit = AGENCY_NAMES.find(([name]) => name.every((w, k) => tokens[i + k] === w));
    if (hit) {
      families.add(hit[1]);
      i += hit[0].length;
    } else {
      rest.push(tokens[i]);
      i++;
    }
  }
  return { tokens: rest, families };
}

// JOINT GSE DOCUMENTS (batch 13, eval B12): the Uniform Mortgage Data Program's UAD 3.6 / URAR
// appendices (Reference Guide = URAR Appendix F-1, Implementation Guide = B-1, Report Style
// Guide = E) and the joint temporary policy exception are issued by Fannie Mae AND Freddie Mac
// together, so the index files them under family "other" -- and `family: "fnma"` hid the
// Fannie Mae Selling Guide's own Appendix F-1. A family filter of fnma or fhlmc includes them.
export const JOINT_GSE_PREFIXES = ["uad-3-6-"];
export const GSE_FAMILIES = ["fnma", "fhlmc"];
// SQL for "row r belongs to family ?N" (empty ?N = any family).
export function familyFilterSql(param, alias = "r") {
  const joint = JOINT_GSE_PREFIXES.map((p) => `${alias}.register_id LIKE '${p}%'`).join(" OR ");
  return `(?${param} = '' OR ${alias}.family = ?${param} OR ` +
    `(?${param} IN (${GSE_FAMILIES.map((f) => `'${f}'`).join(", ")}) AND (${joint})))`;
}
