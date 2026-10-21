// STATUTE COMPANIONS (batch 13, eval G7/G10/G24). Topic searches ranked only the regulation's
// paragraphs -- Reg X 1024.17 for escrow, 1024.37 for force-placed insurance -- and never the
// statute section the regulation implements (RESPA section 10, 12 U.S.C. 2609; section 6(k),
// 12 U.S.C. 2605(k)), although the corpus holds it: a user who does not already know the cite
// never saw the statute layer. When a regulation section in the results implements a held
// statute section, that statute section is added to the same results array directly after
// the regulation's first row (match "related", related_to = the regulation row it belongs to).
//
// The pairs are the implementing-authority links the regulations themselves state (each CFR
// section's authority / the CFPB's section-by-section analysis), kept to the well-known
// one-to-one mappings. Values: statute register id, optionally "#<subsection>" for the
// pinpoint obligation (<register>::<register>-<subsection>); without one, the register's first
// obligation. Ordered: the first listed is the primary statute.
export const IMPLEMENTS = {
  // Regulation X (RESPA, 12 U.S.C. 2601 et seq.)
  "reg-x-1024-6": ["respa-12usc-2604"],
  "reg-x-1024-8": ["respa-12usc-2603"],
  "reg-x-1024-10": ["respa-12usc-2603"],
  "reg-x-1024-14": ["respa-12usc-2607"],
  "reg-x-1024-15": ["respa-12usc-2607"],
  "reg-x-1024-16": ["respa-12usc-2608"],
  "reg-x-1024-17": ["respa-12usc-2609", "respa-12usc-2605#g"],
  "reg-x-1024-20": ["respa-12usc-2604"],
  "reg-x-1024-33": ["respa-12usc-2605#a"],
  "reg-x-1024-34": ["respa-12usc-2605#g"],
  "reg-x-1024-35": ["respa-12usc-2605#e", "respa-12usc-2605#k"],
  "reg-x-1024-36": ["respa-12usc-2605#e", "respa-12usc-2605#k"],
  "reg-x-1024-37": ["respa-12usc-2605#k", "respa-12usc-2605#l"],
  "reg-x-1024-38": ["respa-12usc-2605#k"],
  "reg-x-1024-39": ["respa-12usc-2605#k"],
  "reg-x-1024-40": ["respa-12usc-2605#k"],
  "reg-x-1024-41": ["respa-12usc-2605#k"],
  // Regulation Z (TILA, 15 U.S.C. 1601 et seq.)
  "reg-z-1026-18": ["tila-15usc-1638"],
  "reg-z-1026-19": ["tila-15usc-1638"],
  "reg-z-1026-37": ["tila-15usc-1638"],
  "reg-z-1026-38": ["tila-15usc-1638"],
  "reg-z-1026-23": ["tila-12usc-1635"],
  "reg-z-1026-32": ["tila-12usc-1639"],
  "reg-z-1026-34": ["tila-12usc-1639"],
  "reg-z-1026-35": ["tila-15usc-1639d", "tila-15usc-1639h"],
  "reg-z-1026-36": ["tila-15usc-1639b"],
  "reg-z-1026-39": ["tila-15usc-1641"],
  "reg-z-1026-41": ["tila-15usc-1638"],
  "reg-z-1026-42": ["tila-15usc-1639e"],
  "reg-z-1026-43": ["tila-15usc-1639c"],
  // Regulation V (FCRA, 15 U.S.C. 1681 et seq.)
  "reg-v-1022-42": ["fcra-15usc-1681s-2"],
  "reg-v-1022-43": ["fcra-15usc-1681s-2"],
  "reg-v-1022-70": ["fcra-15usc-1681m"],
  "reg-v-1022-71": ["fcra-15usc-1681m"],
  "reg-v-1022-72": ["fcra-15usc-1681m"],
  "reg-v-1022-73": ["fcra-15usc-1681m"],
  "reg-v-1022-74": ["fcra-15usc-1681m"],
  // Regulation B (ECOA, 15 U.S.C. 1691 et seq.)
  "reg-b-1002-2": ["ecoa-15usc-1691a"],
  "reg-b-1002-4": ["ecoa-15usc-1691"],
  "reg-b-1002-6": ["ecoa-15usc-1691"],
  "reg-b-1002-9": ["ecoa-15usc-1691#d"],
  "reg-b-1002-14": ["ecoa-15usc-1691#e"],
  // SAFE Act (12 U.S.C. 5101 et seq.): Regulation G (12 CFR 1007, federal registration) and
  // Regulation H (12 CFR 1008, state licensing). A statute register not yet loaded is skipped
  // (withCompanions finds no row and adds nothing).
  "safe-12cfr-1007-101": ["safe-12usc-5106"],
  "safe-12cfr-1007-102": ["safe-12usc-5102"],
  "safe-12cfr-1007-103": ["safe-12usc-5106", "safe-12usc-5103"],
  "safe-12cfr-1007-104": ["safe-12usc-5106"],
  "safe-12cfr-1007-105": ["safe-12usc-5106"],
  "safe-12cfr-1008-23": ["safe-12usc-5102"],
  "safe-12cfr-1008-103": ["safe-12usc-5103"],
  "safe-12cfr-1008-105": ["safe-12usc-5104"],
  "safe-12cfr-1008-107": ["safe-12usc-5104"],
  "safe-12cfr-1008-109": ["safe-12usc-5104"],
  "safe-12cfr-1008-111": ["safe-12usc-5105"],
  "safe-12cfr-1008-113": ["safe-12usc-5105"],
};

// At most this many statute rows are added per search, for regulation rows among the first
// COMPANION_REACH results.
export const MAX_COMPANIONS = 2;
export const COMPANION_REACH = 5;

// The statute targets for result rows, in result order: [{ after, ref }] where `after` is the
// regulation row's obligation_id and `ref` a statute "register#sub" not already in the results.
export function companionTargets(rows) {
  const present = new Set(rows.map((r) => r.register_id));
  const out = [];
  const used = new Set();
  const done = new Set();
  for (const r of rows.slice(0, COMPANION_REACH)) {
    const refs = IMPLEMENTS[r.register_id];
    // One companion per regulation section, after its first (best) row.
    if (!refs || done.has(r.register_id)) continue;
    done.add(r.register_id);
    const ref = refs.find((x) => !present.has(x.split("#")[0]) && !used.has(x.split("#")[0]));
    if (!ref) continue;
    used.add(ref.split("#")[0]);
    out.push({ after: r.obligation_id, ref });
    if (out.length >= MAX_COMPANIONS) break;
  }
  return out;
}

// The obligation id a "register#sub" ref points to (null without a subsection).
export function refObligationId(ref) {
  const [reg, sub] = String(ref).split("#");
  return sub ? `${reg}::${reg}-${sub}` : null;
}
