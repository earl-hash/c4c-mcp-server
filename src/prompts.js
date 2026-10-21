import { z } from "zod";

// One-click "give me the regulator's words" prompt (verbatim by default, 2026-09-25). The
// owner asked claude.ai for FHA refinance underwriting requirements and got a long, correct
// paraphrase; this prompt states the verbatim contract in the user's own voice, for clients
// that show MCP prompts in a menu. The topic is a short label (<= 120 chars), so no
// document text fits.
export const REGULATORY_TEXT_PROMPT = "regulatory-text";
export const TOPIC_MAX = 120;

export function regulatoryTextPromptText(topic) {
  const t = String(topic ?? "").trim() || "the topic I name next";
  return `Give me the regulator's exact text on ${t}: quote each relevant section verbatim ` +
    "with its citation and effective date, note any pending revision or superseded version, " +
    "no paraphrase.";
}

export function registerTextPrompts(server) {
  server.registerPrompt(
    REGULATORY_TEXT_PROMPT,
    {
      title: "Regulatory text (verbatim)",
      description: "The regulator's exact words on a topic, each quote with its citation " +
        "and effective date, plus any pending revision or superseded version.",
      argsSchema: z.object({
        topic: z.string().max(TOPIC_MAX)
          .describe("The topic, e.g. \"FHA cash-out refinance credit requirements\"."),
      }),
    },
    (args) => ({
      messages: [{
        role: "user",
        content: { type: "text", text: regulatoryTextPromptText(args?.topic) },
      }],
    }),
  );
}
