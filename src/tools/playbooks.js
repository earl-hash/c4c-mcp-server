// Playbooks: the full compliance Skills, served over the MCP (playbooks/ in the repo,
// bundled into playbooks.generated.js by scripts/build-playbooks-module.py).
//
// A user connected to this server says "run the FNMA AI lender letter review on this P&P"
// or "QC this FHA loan file" and their own AI window runs the workflow the downloadable
// Skill ran: start_playbook returns the instructions, get_playbook_reference loads a
// stage's reference when the workflow reaches it (the way a Skill loads references
// progressively), get_playbook_kit returns the rule kit.
//
// PRIVACY: every input here is an id. The user's P&Ps and loan files stay in their own
// chat and never reach this server; no playbook tool accepts document text, and the ids
// are pattern-constrained so none can carry it. Nothing is read from D1 -- these tools
// serve bundled, public text.

import { z } from "zod";
import { MAX_CHARS } from "../envelope.js";
import { PLAYBOOKS } from "../playbooks.generated.js";

// HIDDEN PLAYBOOKS (2026-10-03). A playbook whose playbook.json sets `"hidden": true` is
// bundled but NOT served by default: it is absent from list_playbooks, prompts/list, the
// tool descriptions' id list and every `valid_ids`, and start_playbook /
// get_playbook_reference / get_playbook_kit answer `unknown_playbook` for it -- exactly
// as for an id that does not exist. It is served only when the Worker's PLAYBOOKS_PREVIEW
// var (comma- or space-separated ids) names it. wrangler.jsonc does not set that var, so
// production serves only the public playbooks and the public surface (tools/list,
// SERVER_INSTRUCTIONS, prompts/list, list_playbooks) stays byte-identical while a hidden
// playbook is being built (both MCP directory listings were under review when the first
// one, pp-regulation-watchlist, was added). Tool descriptions and input schemas name only
// the PUBLIC ids, even with a preview enabled, so enabling one never changes tools/list.
const PUBLIC_PLAYBOOKS = PLAYBOOKS.filter((p) => !p.hidden);
export const PLAYBOOK_IDS = PUBLIC_PLAYBOOKS.map((p) => p.id);
// Every bundled id, hidden included: only the metrics outcome vocabulary uses it.
export const ALL_PLAYBOOK_IDS = PLAYBOOKS.map((p) => p.id);
const HIDDEN_IDS = new Set(PLAYBOOKS.filter((p) => p.hidden).map((p) => p.id));

export function previewIds(env) {
  const raw = typeof env?.PLAYBOOKS_PREVIEW === "string" ? env.PLAYBOOKS_PREVIEW : "";
  return raw.split(/[\s,]+/).filter((id) => HIDDEN_IDS.has(id));
}

// The playbooks this server serves for this env: the public ones, plus any hidden one
// PLAYBOOKS_PREVIEW names, in bundle order.
export function visiblePlaybooks(env) {
  const preview = new Set(previewIds(env));
  if (!preview.size) return PUBLIC_PLAYBOOKS;
  return PLAYBOOKS.filter((p) => !p.hidden || preview.has(p.id));
}

function catalog(env) {
  const list = visiblePlaybooks(env);
  return { list, ids: list.map((p) => p.id), byId: new Map(list.map((p) => [p.id, p])) };
}

// A kit page holds rows up to this many characters of JSON, leaving room for the
// envelope around them so the whole response stays within MAX_CHARS.
export const KIT_PAGE_BUDGET = MAX_CHARS - 2000;

export const PRIVACY =
  "Playbook tools accept only ids and reference names, no document text; the user's P&Ps " +
  "and loan files stay in their own chat.";

const idSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9-]+$/)
  .describe(`Playbook id: one of ${PLAYBOOK_IDS.join(", ")}.`);

function json(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

function unknownPlaybook(id, ids) {
  return {
    error: "unknown_playbook",
    id,
    valid_ids: ids,
    hint: "Call list_playbooks to see what each playbook does.",
  };
}

export function listPlaybooks(env) {
  return {
    playbooks: catalog(env).list.map((p) => ({
      id: p.id,
      title: p.title,
      what: p.what,
      when: p.when,
      user_provides: p.user_provides,
      version: p.version,
      prompt: p.prompt.name,
    })),
    privacy: PRIVACY,
    next: "Call start_playbook({id}) and follow the instructions it returns.",
  };
}

function kitVersion(p) {
  return { kind: p.kit.kind, source: p.kit.source, ...p.kit.version };
}

export function startPlaybook(id, env) {
  const { byId, ids } = catalog(env);
  const p = byId.get(id);
  if (!p) return unknownPlaybook(id, ids);
  return {
    id: p.id,
    title: p.title,
    version: p.version,
    privacy: PRIVACY,
    user_provides: p.user_provides,
    kit: {
      ...kitVersion(p),
      load_with: `get_playbook_kit({id: "${p.id}"})` +
        (p.kit.kind === "rows" ? " -- paginated: follow next_offset until it is null" : ""),
    },
    stages: p.stages,
    references: Object.keys(p.references),
    load_reference_with: Object.keys(p.references).length
      ? `get_playbook_reference({id: "${p.id}", name}) -- when the workflow reaches that stage`
      : null,
    instructions: p.instructions,
  };
}

export function getPlaybookReference(id, name, env) {
  const { byId, ids } = catalog(env);
  const p = byId.get(id);
  if (!p) return unknownPlaybook(id, ids);
  if (!Object.hasOwn(p.references, name)) {
    return {
      error: "unknown_reference",
      id,
      name,
      valid_names: Object.keys(p.references),
    };
  }
  return { id, name, content: p.references[name] };
}

const REGISTER_HOW_TO =
  "For each register: get_reg({register_id}) lists its obligations with sections and sizes; " +
  "get_obligation({obligation_id}) returns the verbatim text and its provenance (fetched_at, " +
  "effective_date). get_obligation returns at most 24,000 characters: when `truncated` is true, " +
  "find topics beyond it with search_regs (family as below) -- its excerpts are verbatim -- " +
  "before calling anything 'outside the loaded text'. Check quotations with verify_quote.";

export function getPlaybookKit(id, offset = 0, env) {
  const { byId, ids } = catalog(env);
  const p = byId.get(id);
  if (!p) return unknownPlaybook(id, ids);
  const kit = kitVersion(p);

  if (p.kit.kind === "corpus-registers") {
    return {
      id,
      kit,
      how_to_read: REGISTER_HOW_TO,
      search_family: p.kit.search_family,
      areas: p.kit.areas,
      next_offset: null,
    };
  }

  const rows = p.kit.rows;
  if (offset > 0 && offset >= rows.length) {
    return { error: "offset_out_of_range", id, offset, rows_total: rows.length };
  }
  const page = [];
  let size = 0;
  for (let i = offset; i < rows.length; i++) {
    const n = JSON.stringify(rows[i]).length + 1;
    if (page.length && size + n > KIT_PAGE_BUDGET) break;
    page.push(rows[i]);
    size += n;
  }
  const end = offset + page.length;
  return {
    id,
    kit,
    offset,
    rows_returned: page.length,
    rows_total: rows.length,
    next_offset: end < rows.length ? end : null,
    note: end < rows.length
      ? `More rows: call get_playbook_kit({id: "${id}", offset: ${end}}). Load every page before citing.`
      : "Last page: the kit is complete.",
    rows: page,
  };
}

export function registerPlaybookTools(server, env) {
  server.registerTool(
    "list_playbooks",
    {
      description:
        "Lists the guided compliance playbooks this server provides: the Fannie Mae AI lender " +
        "letter (LL-2026-04) P&P review (AI inventory, AI governance policy, risk assessment, " +
        "P&P updates, change log) and FHA, VA and USDA loan-file QC against the verbatim " +
        "handbooks. Returns each playbook's id, what it does, when it applies and what the " +
        "user provides. " + PRIVACY,
      inputSchema: {},
    },
    async () => json(listPlaybooks(env)),
  );

  server.registerTool(
    "start_playbook",
    {
      description:
        "Returns one playbook's full workflow instructions, its stages, the stage reference " +
        "names and the rule-kit version: the Fannie Mae AI lender letter (LL-2026-04) P&P " +
        "review, or FHA, VA or USDA loan-file QC. Input: the playbook `id`; an unknown id " +
        "returns `unknown_playbook` with `valid_ids`. " + PRIVACY,
      inputSchema: { id: idSchema },
    },
    async ({ id }) => json(startPlaybook(id, env)),
  );

  server.registerTool(
    "get_playbook_reference",
    {
      description:
        "Returns one stage reference document of a playbook (e.g. the FNMA playbook's " +
        "DISCOVERY, RECONCILE, SYNTHESIS, PP-UPDATE, CHANGELOG or UPDATING stage). Inputs: " +
        "`id`, `name` (one of the playbook's `references`). " + PRIVACY,
      inputSchema: {
        id: idSchema,
        name: z.string().max(64).regex(/^[A-Za-z0-9-]+$/)
          .describe("Reference name, one of the playbook's `references`."),
      },
    },
    async ({ id, name }) => json(getPlaybookReference(id, name, env)),
  );

  server.registerTool(
    "get_playbook_kit",
    {
      description:
        "Returns a playbook's rule kit. FNMA AI lender letter: the verbatim LL-2026-04, " +
        "InfoSec Supplement and ECOA/Reg B/FCRA/AVM rows with citations, paginated; " +
        "`next_offset` is the next page's offset, or null when the kit is complete. " +
        "FHA/VA/USDA QC: the corpus registers each check area is grounded in. The kit block's " +
        "fingerprint and dates identify its version. " + PRIVACY,
      inputSchema: {
        id: idSchema,
        offset: z.number().int().min(0).optional()
          .describe("Row offset for the next page (the previous page's next_offset)."),
      },
    },
    async ({ id, offset }) => json(getPlaybookKit(id, offset ?? 0, env)),
  );
}

// One MCP prompt per playbook, so clients show them in their prompt menu. The optional
// argument is a short label (batch name / loan purpose), capped so no document fits.
export function playbookPromptText(p, arg) {
  const label = arg && arg.trim() ? ` (${arg.trim()})` : "";
  return [
    `Run the C4C playbook "${p.title}" (id: ${p.id}).`,
    `1. Call the start_playbook tool with {"id": "${p.id}"} and follow the instructions it ` +
      "returns exactly, loading the kit and any stage references with the tools it names.",
    "2. Then ask me to upload the documents it needs. They stay in this chat: do not send " +
      "their text to any C4C tool.",
    p.prompt.ask.replace("{arg}", label),
  ].join("\n");
}

export function registerPlaybookPrompts(server, env) {
  for (const p of visiblePlaybooks(env)) {
    const arg = p.prompt.argument;
    server.registerPrompt(
      p.prompt.name,
      {
        title: p.prompt.title,
        description: p.prompt.description,
        argsSchema: z.object({
          [arg.name]: z.string().max(120).optional().describe(arg.description),
        }),
      },
      (args) => ({
        messages: [{
          role: "user",
          content: { type: "text", text: playbookPromptText(p, args?.[arg.name]) },
        }],
      }),
    );
  }
}
