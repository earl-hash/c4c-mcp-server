# C4C: Mortgage Industry Regulations (self-hosted MCP server)

C4C answers in the regulator's own words. This is the server behind
the hosted C4C connector, packaged to run inside your own network: your AI tools ask it for
regulatory text, and it returns verbatim sections with their citations, version and currency
status. It never sends your questions, documents or answers anywhere, and it can run with no
connection to us at all: signed rule updates can reach it through your own gates (an internal
mirror, your file transfer, or a manual load).

**Research only. Not legal advice.** C4C returns regulatory text and citations for research
and reference. Check the regulator's own publication before you rely on any text.

## What it covers

Federal mortgage and consumer-finance regulations and agency guides: Regulation X, Z, B, C, V
and others in 12 CFR; Fannie Mae and Freddie Mac guides; FHA Handbook 4000.1 and Mortgagee
Letters; VA and USDA handbooks; Ginnie Mae; SBA SOPs; and related statutes. The library is
updated as regulators publish changes.

## Tools

| Tool | What it does |
|---|---|
| `search_regs` | Find the sections that address a topic |
| `lookup_citation` | Resolve a citation (`12 CFR 1026.19(e)`, `4000.1 II.A.4`, `B3-3.1-04`) |
| `get_reg` / `get_obligation` | Read a regulation or one section, verbatim, with currency and version |
| `find_in_section` | The paragraphs of a section that contain your terms |
| `verify_quote` | Check that a quoted passage really appears in the regulator's text |
| `list_playbooks` / `start_playbook` / `get_playbook_reference` / `get_playbook_kit` | Guided reviews (Fannie Mae LL-2026-04 P&P review; FHA, VA and USDA loan-file QC) |

## Quick start

Build the image from this repository, then run it:

```
git clone https://github.com/earl-hash/c4c-mcp-server.git
cd c4c-mcp-server
docker build -t c4c-mcp .
docker run -d --name c4c-mcp -p 8080:8080 -v c4c-data:/data \
  -e C4C_LICENSE_KEY=your-free-key \
  -e C4C_AUTH_TOKEN=choose-a-long-random-token \
  c4c-mcp
```

With a license key, the first start downloads and verifies the current library (about 37 MB).
Without one, the server starts with no library and says so at `/healthz`.

- **Free license key:** https://mcp-auth.claudeforcompliance.com/self-hosted. The key only
  downloads signed library updates; the server runs without one, serving whatever library is
  already in `/data`.
- **Updates through your own gates:** fill an internal mirror from a gate host with
  `server/mirror-library.mjs` and point `C4C_UPDATE_URL` at it; the server then needs no license
  key and never contacts us. See [docs/INSTALL.md](docs/INSTALL.md).
- Connect your AI tool to `http://<host>:8080/mcp` with the header
  `Authorization: Bearer <C4C_AUTH_TOKEN>`.
- Full setup, settings and network notes: [docs/INSTALL.md](docs/INSTALL.md).
  What leaves your network and what doesn't: [docs/DATA-FLOW.md](docs/DATA-FLOW.md).

## How updates stay trustworthy

Each library release is signed. The server checks the signature against the public key built
into the image before installing anything, keeps the previous library for rollback, and
reports the library version and age in every answer and at `/healthz`. If updates stop, the
server keeps answering and marks the library `stale` after 14 days.

## Licenses

- **Code:** [Elastic License 2.0](LICENSE). You may use, copy and modify it, including at
  work. You may not offer it to others as a hosted or managed service, or remove or get around
  the license key functionality.
- **Regulatory library and playbook text:** [C4C Library License](LIBRARY-LICENSE.md). Free,
  for research and reference only, inside your organization. No redistribution, resale or AI
  training.

Questions: earl@cfsynergies.com. Hosted connector and more: https://claudeforcompliance.com/mcp/
