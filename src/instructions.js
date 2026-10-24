// MCP server `instructions`: workflow guidance for clients that surface it (ChatGPT and
// Codex read it at initialize; OpenAI advises the key guidance sit in the FIRST 512
// CHARACTERS). Ordered by importance, and the numbered list must stay within 512
// chars -- test/handler.test.js enforces it.
//
// Verbatim by default (owner's decision, 2026-09-25): asked in claude.ai for "fha
// requirements for underwriting refinances", Claude read all of 4000.1 II.A.8.d and
// returned a long, correct PARAPHRASE -- "it isn't the specific regulatory text though" --
// and never mentioned that II.A.8.d has two versions in force. So rule 1 is the regulator's
// exact words (every relevant section for a broad question; any summary after, labeled),
// and rule 2 is stating the `currency` warning the tools now return. The earlier rules
// (regulator vocabulary, re-search, special programs, no answers from memory) came from
// the GPT-4o eval, which took a special-program DTI cap as the general rule.
//
// Two versions (2026-09-26): the MCP now serves both texts of an FHA dual-version section,
// so the one line after the corpus paragraph says which to quote.
//
// Notice (2026-09-26): every tool result now carries the owner-approved `notice`
// (metrics.js NOTICE); the line after the numbered list says to mention it once per
// conversation, not under every answer.
//
// page_url (Earl, 2026-10-08): citations link to the section's page on claudeforcompliance.com
// (src/sourceurl.js); the 20 characters came from shortening the `figures` sentence.
//
// MCP Directory policy (2026-09-27): tool and output-schema descriptions are FACTUAL ONLY
// (what the tool does, returns and what each field means). All usage guidance -- how to
// quote, cite, page, verify and when to ask -- lives HERE, the MCP-designated place for
// "how to use this server". test/tool-text-policy.test.js enforces the split.
//
// Length: Claude Code truncates server instructions (and each tool description) at 2,048
// characters (a per-server cap since 2.1.84); test/handler.test.js keeps this under it.
//
// Its own module because the Worker entry (index.js) may export only handlers:
// workerd rejects a string export there and the runtime fails to start.
// Joined from lines (not a template literal) so a CRLF checkout cannot change its length.
export const SERVER_INSTRUCTIONS = [
  "1. Answer in the regulator's exact words: quote each relevant section verbatim with its section citation, not a paraphrase. Summary after, labeled as a summary.",
  "2. State any `currency` warning and which version.",
  "3. Use regulator vocabulary (\"debt-to-income\" not \"DTI\"). Titles don't fit: search again.",
  "4. A special program's rule applies only to that program: find the general rule.",
  "5. Still none: the corpus doesn't address it; say so, don't answer from memory.",
  "6. Read: find_in_section. Verify: verify_quote.",
  "",
  "Notice: every result carries a `notice` (research only, not legal advice). Mention it ONCE per conversation, in one short line, not under every answer.",
  "Cite `canonical_citation`, link `page_url`. Reading: find_in_section gives the paragraphs with your terms (check `heading_path` is the program meant); get_obligation pages the whole section: repeat with offset=next_offset until null. Don't say a section lacks something before reading every page; no find_in_section match doesn't mean the rule is silent. `figures` is best-effort; an empty or partial list doesn't mean the text states no figure.",
  "Two versions (an FHA section Update 18 revises; `version` in-force / update-18-optional): quote the one that applies. If you don't know whether the user has adopted Update 18, quote the in-force text and state what the revision changes, or ask.",
  "superseded-in-part: quote the Mortgagee Letter for the replaced provisions, this text for the rest.",
  "verify_quote quotes before presenting them. composed: check `omissions` (a dropped \"not\" changes meaning); not_found: not a quotation; superseded: only as the prior version; update-18-optional: as the Update 18 version; rescinded: never as current.",
  "lookup_citation \"ambiguous\": ask the user which. daily_capacity_reached: stop for today; don't answer from memory.",
  "Playbooks (FNMA AI governance P&P review; FHA, VA, USDA loan-file QC): list_playbooks, then start_playbook; follow its instructions exactly. Playbook tools take only ids: the user's documents stay in their chat, never sent here.",
].join("\n");
