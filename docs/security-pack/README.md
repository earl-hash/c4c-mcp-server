# C4C Private: security review pack

For bank and mortgage-lender third-party-risk, information-security and model-risk reviewers.
Product: C4C Private, the self-hosted C4C MCP server, a container you run in your own AWS or Azure account or on any Docker host.
Publisher: CF Synergies, LLC. Contact: earl@cfsynergies.com.
Research use only. C4C returns regulatory text and citations. It is not legal advice.

## What is in the pack

| File | Use it for |
|---|---|
| `SECURITY-QUESTIONNAIRE.md` | Pre-answered questions in the shape of SIG Lite and CAIQ domains: governance, data handling, location, encryption, access, logging, vulnerabilities, SDLC, subprocessors, incident response, continuity, AI. Each answer cites the file that supports it. |
| `ARCHITECTURE.md` | A typical AWS deployment (internal ALB, ECS Fargate in private subnets, Secrets Manager, CloudWatch, optional S3 mirror and C4C feed), with trust boundaries and what data crosses each. Mermaid diagram inside. |
| `ARCHITECTURE-aws.svg` | The same diagram as an image for decks and review tickets. |
| `VULNERABILITY-AND-SBOM.md` | How releases are scanned, a dated scan of 1.0.1, how to verify the image by digest, and how to produce your own SBOM and scan. |
| `AI-USE-STATEMENT.md` | One page for model-risk and AI-governance reviewers: what the server does and does not do, where it sits in an AI inventory, human review expectations, limitations. |
| `sbom/c4c-mcp-1.0.1.spdx.json` | SPDX SBOM of image 1.0.1 (linux/amd64), generated with Docker Scout. |
| `sbom/c4c-mcp-1.0.1.scout-cves.sarif.json` | Docker Scout CVE report for the same image, SARIF format, 2026-10-25. |

Related documents in the parent folder: `SECURITY.md` (short security overview), `DATA-FLOW.md` (what leaves your network), `INSTALL.md` (settings, updates, offline load), `aws/AWS-USAGE.md`, `azure/AZURE-USAGE.md`.

## How to use it

1. **Start with the facts that usually decide scope.** The server holds no customer data, calls no AI model, sends no telemetry, and needs no outbound connection (`DATA-FLOW.md`; questionnaire sections 2, 3 and 12).
2. **Map it to your deployment.** Use `ARCHITECTURE.md` to place the container in your network and decide which optional flows (C4C feed, S3 mirror, offline load) you allow.
3. **Fill your own questionnaire from ours.** Copy answers and keep the evidence column; every answer points to a file in the public source or these docs, so your reviewers can check it.
4. **Verify, do not trust.** Pull the image by digest, generate your own SBOM, run your own scanner, and read the source (https://github.com/earl-hash/c4c-mcp-server). Steps are in `VULNERABILITY-AND-SBOM.md`.
5. **Send open items to us.** Answers marked Details on request (earl@cfsynergies.com). are not yet established. Ask earl@cfsynergies.com for the answer before you rely on that row.

## What is not in place

Stated plainly so you do not have to dig:

- No SOC 2 report and no ISO 27001 certification.
- No third-party penetration test yet.
- Container images are not signed (no cosign); releases are identified by digest. Library content is signed (Ed25519) and verified before install.
- One shared bearer token per deployment. No SSO or per-user authentication yet (roadmap). Enforce user identity at your own gateway.
- No written remediation SLA for vulnerabilities.
- CF Synergies is a small LLC.

## Getting the SBOM and scan for a specific version

- **1.0.1:** included in `sbom/`.
- **Any version, yourself:** `docker scout sbom --format spdx --output sbom.spdx.json <image>` or `syft <image> -o spdx-json=sbom.spdx.json`, then `grype`, `trivy`, Amazon Inspector or Microsoft Defender for Containers. See `VULNERABILITY-AND-SBOM.md`.
- **From us:** email earl@cfsynergies.com with the tag or digest. Details on request (earl@cfsynergies.com).

## Report a security issue

earl@cfsynergies.com. Include the image tag or digest and the library version from `/healthz`.
