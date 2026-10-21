// Decision Workspace tools (Plan 2, 2026-10-19): the "prevent" layer of the C4C Decision
// Workspace. Spec: c4c-compliance-reviewer/docs/superpowers/specs/2026-10-19-decision-workspace-design.md.
//
// Registered only when env.WORKSPACE_TOOLS === "1" (a preview Worker, wrangler dev, or the
// self-hosted box with C4C_WORKSPACE=1). With the flag off, tools/list and the instructions
// are byte-identical to production. None of these tools stores anything: a tag_record call
// is itself the tag, and it lands in the Compliance API transcript.
//
// Titles are set here, not in metrics.js TOOL_TITLES: that table also decides which tool
// names production counts by name, and production has none of these tools.

import { z } from "zod";
import { DECISION_TYPES, recordRules } from "./record-rules.js";
import { NOTE_SCHEMA, TAG_SCHEMA, proposeFileNote, tagRecord } from "./notes.js";

export function workspaceEnabled(env) {
  return env?.WORKSPACE_TOOLS === "1";
}

const json = (body) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });

const RECORD_RULES_DESCRIPTION =
  "Returns the record-retention rule for a kind of lending decision, quoted verbatim from the " +
  "regulation. Input: `decision_type`. Each rule has `canonical_citation`, `verbatim`, `page_url`, " +
  "`source_url`, and two summary fields, `period` and `clock_starts` (summaries, not regulator " +
  "text). `verbatim` is null with `error` \"text_not_found\" when the corpus does not hold the " +
  "passage. `not_covered` lists retention requirements not mapped.";

const PROPOSE_DESCRIPTION =
  "Returns a draft file note for a lending decision; nothing is stored. Inputs: `decision_type`, " +
  "`conclusion` (at most 2,000 characters), `citations` (up to 10), optional `loan_ref` (letters, " +
  "digits and hyphens; SSN-shaped values are refused). The draft has `status` \"draft\", " +
  "`stored` false, `approval_required`, `date` (UTC), each citation checked against the corpus " +
  "(`resolved` true, false when the corpus does not hold it, or null when the check failed), " +
  "and the decision type's retention rules.";

const TAG_DESCRIPTION =
  "Records what happened to a proposed file note: saved, edited, or declined, with an optional " +
  "reason. Nothing is stored on this server; the call itself, in the conversation transcript, " +
  "is the record. Inputs: `decision_type`, `status`, optional `reason`, `reason_detail` (at most " +
  "200 characters, not echoed), `rule`, `loan_ref`. Returns `stored` false and the tag's fields.";

export function registerWorkspaceTools(server, env) {
  if (!workspaceEnabled(env)) return;
  server.registerTool(
    "record_rules",
    {
      title: "Record rules",
      description: RECORD_RULES_DESCRIPTION,
      inputSchema: {
        decision_type: z.enum(DECISION_TYPES).describe("The kind of decision being recorded."),
      },
    },
    async ({ decision_type }) => json(await recordRules(env, decision_type)),
  );
  server.registerTool(
    "propose_file_note",
    {
      title: "Propose file note",
      description: PROPOSE_DESCRIPTION,
      inputSchema: NOTE_SCHEMA,
    },
    async (args) => json(await proposeFileNote(env, args)),
  );
  server.registerTool(
    "tag_record",
    {
      title: "Tag record",
      description: TAG_DESCRIPTION,
      inputSchema: TAG_SCHEMA,
    },
    async (args) => json(tagRecord(args)),
  );
}
