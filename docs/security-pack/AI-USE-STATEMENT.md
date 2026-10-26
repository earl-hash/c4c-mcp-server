# C4C Private: AI use statement

For model-risk, AI-governance and compliance reviewers, including lenders working under Fannie Mae's AI governance expectations. Publisher: CF Synergies, LLC. Research use only. C4C returns regulatory text and citations. It is not legal advice.

## In one paragraph

The C4C self-hosted server is not an AI model and does not call one. It is a lookup service. Your AI tool (Claude, ChatGPT, Copilot, a Bedrock or internal agent) sends it a search term or a citation over MCP, and it returns the regulator's text, verbatim, with the citation, version and currency information, from a signed library stored in your container. The AI tool, not C4C, writes the answer your staff read. Treat C4C as a reference source that your AI tool consults, and govern the AI tool itself under your own AI policy.

## What the server does

- **Retrieves stored text.** Full-text search and citation lookup over a SQLite library of federal mortgage and consumer-finance regulations and agency guides. Results are the regulator's words as stored, with `canonical_citation`, a link to the source page, and an effective date where the library has one.
- **Reports version and currency.** Each section carries version and currency status, such as superseded or rescinded text, or a revision that is optional until adopted (for example FHA Handbook 4000.1 Update 18). Every result carries a `library` block with the library version, build date and age in days. After `C4C_STALE_DAYS` (default 14) without a new library, results and `/healthz` say `stale`.
- **Checks quotations.** `verify_quote` tells an AI tool whether a passage it intends to quote appears in the stored source text. Outcomes are exact, normalized (typography differences only), composed (pieces in source order, with skipped words disclosed as `omissions`, because a dropped "not" changes meaning) or not found.
- **Gives the AI instructions.** The server tells connected AI tools to quote verbatim with the citation, state currency warnings, label any summary as a summary, verify quotes, and say when the library does not address a question instead of answering from memory.
- **Is deterministic for a given library version.** Answers come from database queries with no sampling or randomness. Some notices depend on the current date, such as library age.

## What the server does not do

- It contains no machine-learning model, no LLM and no embedding model, and it calls none.
- It does not train on anything. CF Synergies receives no tool calls or answers from self-hosted servers, so there is no customer data to train on. The library license forbids using the library to train or evaluate AI models.
- It makes no credit, pricing, underwriting or eligibility decision, and produces no score or estimate.
- It does not send questions, documents or answers anywhere. See `DATA-FLOW.md`.
- It does not interpret the law for you. It returns text. Interpretation is done by your AI tool and, finally, by your people.

## Where it sits in your AI inventory

- **The server.** A deterministic retrieval tool that returns stored text. It applies no statistical, economic or financial theory to produce quantitative estimates. In our view that places it outside the usual definition of a model in SR 11-7 (OCC 2011-12). Your model-risk function makes that call; you may still list it as a component or data source of the AI system that uses it.
- **The AI system that calls it.** Your AI tool, its model and your prompts are the system to inventory, risk-rate and monitor. C4C narrows what that system relies on to cited, versioned source text, which makes outputs easier to check, but it does not validate the AI's reasoning.
- **Third-party risk.** CF Synergies is the provider of the library and server. See `SECURITY-QUESTIONNAIRE.md` for the vendor profile, including what is not in place (no SOC 2 or ISO 27001, no third-party penetration test yet).

## Human in the loop

We expect, and the product is built for:

- A qualified person reviews every AI output that relies on C4C text before it is used in a decision, a policy, a file or a communication.
- Reviewers check quotations against the citation and, for anything material, against the regulator's own publication. The library is a research aid, not an official source.
- Reviewers confirm the version that applies (for example whether your organization has adopted an optional revision) and act on any `stale` or superseded flag.
- The optional Decision Workspace (`C4C_WORKSPACE=1`, off by default) drafts a file note for a person to approve. The server stores nothing and never marks a note as saved; saving happens in your own system after a person approves the text.

## Evidence you can keep

- The optional audit log (`C4C_AUDIT_LOG=stdout` or `file`, off by default) records, per tool call, the time, tool, arguments, citations and sections returned, library version, duration and outcome, the client and caller address, and optionally a user identifier from a header your gateway sets. It stays in your logs or on your volume. It shows what the AI looked up and which library version answered. The audit log is in image 1.0.2 and later.
- The library version in every result lets you reproduce what text was available on a given day, as long as you keep that library version.

## Limitations

- **Research and reference use only.** Not legal advice. Using C4C creates no attorney-client relationship.
- **Coverage.** Federal mortgage and consumer-finance regulations and agency guides (for example Regulations X, Z, B and C, Fannie Mae and Freddie Mac guides, FHA, VA, USDA, Ginnie Mae). State law, investor overlays, your own policies and anything outside the library are not covered. When the library does not address a question, the AI tool is told to say so.
- **Accuracy of the copy.** The library reproduces regulatory text and may be incomplete, out of date or contain errors. Effective dates and currency flags are best effort. Check the issuer's publication before relying on any text.
- **Staleness.** Content is only as current as the last installed library. The server reports library age on every result and flags `stale` after the configured number of days; it keeps serving the old library if updates stop.
- **The AI can still be wrong.** C4C returns verbatim text and a way to verify quotes, but it cannot stop a connected AI tool from paraphrasing, mis-applying a rule or skipping verification. That is why the human review above is required.
- **Search is lexical.** Search matches words and regulator vocabulary, not meaning. A section not found by a search may still exist; reading the full section (`get_obligation`, `find_in_section`) is the reliable check.

## Sources in the code

`src/tools/verify.js` (verify_quote), `src/instructions.js` (instructions to AI tools), `src/library-info.js` (library version and staleness), `src/workspace/notes.js` (Decision Workspace), `server/audit-log.js`, `server/node-server.js`, `public-repo/LIBRARY-LICENSE.md`.

Questions: earl@cfsynergies.com
