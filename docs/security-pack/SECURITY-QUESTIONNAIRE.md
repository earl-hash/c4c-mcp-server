# C4C Private: pre-answered security questionnaire

Publisher: CF Synergies, LLC. Contact: earl@cfsynergies.com.
Product: C4C Private, the self-hosted C4C MCP server (a container you run in your own AWS or Azure account, or on any Docker host).
Research use only. C4C returns regulatory text and citations. It is not legal advice.

Answers describe the server as built from `workers/mcp` (image 1.0.2 unless noted). Evidence paths are relative to the public source repository (https://github.com/earl-hash/c4c-mcp-server) or to this repository's `docs/self-hosted/` folder. Items marked Details on request (earl@cfsynergies.com). are not yet established by code or documents and must be answered by the publisher before this questionnaire is relied on.

Domains follow the general shape of SIG Lite and CSA CAIQ. Question numbering is our own.

## 1. Company and governance

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1.1 | Legal entity | CF Synergies, LLC, a small limited liability company. Details on request (earl@cfsynergies.com). | `public-repo/LIBRARY-LICENSE.md` (names the provider) |
| 1.2 | Independent security attestation (SOC 2, ISO 27001, PCI) | None. CF Synergies has no SOC 2 report and no ISO 27001 certification. | n/a |
| 1.3 | Third-party penetration test | None performed yet. Details on request (earl@cfsynergies.com). | n/a |
| 1.4 | Written information security policy | Details on request (earl@cfsynergies.com). | n/a |
| 1.5 | Named security contact | earl@cfsynergies.com. | `SECURITY.md`, "Reporting a security issue" |
| 1.6 | Cyber liability insurance | Details on request (earl@cfsynergies.com). | n/a |
| 1.7 | Background checks, security training for personnel | Details on request (earl@cfsynergies.com). | n/a |
| 1.8 | Does the vendor have access to our environment? | No. The customer runs the container. CF Synergies has no login, remote access, support channel or agent in the customer environment. | `SECURITY.md`, "What it is", "Network" |

## 2. Data classification and handling

| # | Question | Answer | Evidence |
|---|---|---|---|
| 2.1 | What data does the product store? | The regulation library: a SQLite file of public regulatory text and C4C's index of it, in `/data`. Optional local files: a usage report (counts only) and, when turned on, an audit log. No customer database, no user accounts. | `SECURITY.md`; `DATA-FLOW.md`; `server/config.js` |
| 2.2 | Does the library contain customer data? | No. It is built by CF Synergies from public sources and shipped signed. It is opened read-only; the server never writes to it. The SQLite adapter's write method is a no-op. | `DATA-FLOW.md`, "The library contains no customer data"; `server/d1-sqlite.js` (`readOnly: true`, `run()` executes nothing) |
| 2.3 | What data does a client send to the server? | MCP tool calls: search terms, citations, section identifiers, and for `verify_quote` the passage to check. Playbook tools take ids only. The client's documents stay in the AI tool. | `DATA-FLOW.md`, "What goes where"; `public-repo/README.md`, "Tools" |
| 2.4 | Could tool inputs contain confidential or personal data? | Only if the AI client or user puts it there. Search terms can reveal what a lender is researching; treat them as customer-confidential. The optional Decision Workspace tools (off by default, `C4C_WORKSPACE=1`) accept a loan reference and a decision summary; their instructions forbid borrower names, SSNs, dates of birth and account numbers, and the tools store nothing. | `server/config.js` (`workspace`); `src/workspace/notes.js`; `INSTALL.md` variable table |
| 2.5 | Are requests or answers logged? | Not by default. The console log records startup, update results and internal errors. An internal error message, with its stack trace, may quote part of the request that caused it. | `server/node-server.js` (`console.error("request failed:", e)`); `DATA-FLOW.md` |
| 2.6 | Optional usage report | Off by default (`C4C_USAGE_REPORT=1` to enable). Daily counts by tool name and regulation document name, written to `/data/usage-YYYY-MM.json`. No query text, no user or client information. Never sent anywhere. | `server/usage-report.js`; `INSTALL.md`, "Usage report" |
| 2.7 | Optional audit log | Off by default. `C4C_AUDIT_LOG` set to `off`, `stdout` or `file`. When on, one JSON line per tool call: timestamp, tool name, arguments (search terms, citations; long arguments are cut at 4,000 characters and flagged), citations and section identifiers returned (up to 50 each), library version, duration, outcome, the client's User-Agent, the caller address (first `X-Forwarded-For` value if present, else the socket address), and optionally a user identifier taken from a header your gateway sets (`C4C_AUDIT_USER_HEADER`). Header values are cut at 200 characters. Failed bearer checks are logged as `auth_failed` events without the token. Written only to the container's stdout (for example CloudWatch Logs) or to `/data/audit/audit-YYYY-MM-DD.jsonl`. Never sent to C4C. Because it holds arguments, classify it as customer-confidential. Available from image 1.0.2; 1.0.1 does not have it. | `server/audit-log.js`; `server/node-server.js` (`caller`, `auditCalls`); `SECURITY.md`, "Data handling" |
| 2.8 | Data retention and deletion | The server keeps the current and previous library versions and deletes older ones on each install. Usage report and audit files are kept until the customer deletes them; the server does not rotate or expire them. Deleting the `/data` volume removes everything. | `server/library.js` (install step 5); `server/usage-report.js`; `server/audit-log.js` |
| 2.9 | Data the vendor holds about the customer | For a license key: the sign-up email and the key record, held by the hosted C4C service. The update feed records only aggregate download counts, not which customer downloaded. Customers using their own mirror or offline load need no key on the server. Details on request (earl@cfsynergies.com). | `RELEASE.md`, "Known behavior worth knowing"; `AWS-USAGE.md`, step 1 |

## 3. Data location

| # | Question | Answer | Evidence |
|---|---|---|---|
| 3.1 | Where is customer data processed and stored? | In the customer's own account, region and network, wherever the customer runs the container. CF Synergies does not process or store tool calls or answers for the self-hosted product. | `DATA-FLOW.md` |
| 3.2 | Does data leave our network through the product? | Not through C4C. The only outbound call the server can make is an HTTPS GET for library updates, and only when configured. With an internal mirror or offline load it makes no call to C4C; with no key and no mirror it makes no outbound calls at all. | `server/library.js` (`updatesEnabled`, `feedGet`); `SECURITY.md`, "Network" |
| 3.3 | What decides whether questions stay in our network? | The AI client you connect, not C4C. An in-network agent, or one using a self-hosted model, keeps questions and answers inside. Cloud assistants (ChatGPT connectors, claude.ai custom connectors, Copilot Studio) call the server from the vendor's cloud, so their calls and the returned text pass through that vendor. Amazon Bedrock model calls are governed by your Bedrock configuration. | `DATA-FLOW.md`; `INSTALL.md`, "Connect your AI tools" |
| 3.4 | Where is the update feed hosted? | `https://mcp.claudeforcompliance.com/library`, served by a Cloudflare Worker from Cloudflare R2 storage. | `RELEASE.md`, "One-time setup" |

## 4. Encryption

| # | Question | Answer | Evidence |
|---|---|---|---|
| 4.1 | Encryption in transit, inbound | The container serves plain HTTP on port 8080. TLS is terminated by the customer's load balancer or reverse proxy (for example an internal ALB with an ACM certificate). The hop from load balancer to container is plain HTTP inside your VPC unless you add your own TLS layer. | `server/node-server.js` (`http.createServer`); `INSTALL.md`, "Connect your AI tools" |
| 4.2 | Encryption in transit, outbound | Update URLs must be `https`; plain `http` is refused except to `localhost` / `127.0.0.1`. HTTP redirects are refused. Node's default certificate verification is used; custom CAs via `NODE_EXTRA_CA_CERTS`. | `server/library.js` (`updateUrlOk`, `redirect: "error"`); `INSTALL.md`, "Proxies" |
| 4.3 | Encryption at rest | The container does not encrypt `/data` itself. Encryption at rest is provided by the customer's platform: on ECS Fargate the task storage used by our template is ephemeral storage, which AWS documents as encrypted with AES-256 on platform version 1.4.0 and later; on EKS or AKS it depends on the storage class or `emptyDir` node disk you choose; on Azure Container Apps it is the platform's storage. The stored library is public text; the optional audit log is the sensitive file. | `aws/ecs-task-definition.json` (`ephemeralStorage`, no EFS); `aws/helm/c4c-mcp/values.yaml` (`persistence`) |
| 4.4 | Integrity of downloaded content | Every library release is signed with Ed25519. The server verifies the signature over the exact manifest bytes, then the SHA-256 of the decompressed file, runs `PRAGMA integrity_check` and checks row counts before installing. Anything that fails is discarded. Size caps: 1 GiB download, 2 GiB decompressed, 64 KiB manifest. | `server/library.js`; `server/manifest.js` |
| 4.5 | Key management | The signing private key is kept by CF Synergies outside the image, the source repository and the update server. The public key is built into the image. There is no in-band key rotation: rotating the signing key requires a new image. Details on request (earl@cfsynergies.com). | `SECURITY.md`, "Integrity of the library"; `RELEASE.md`, "One-time setup" step 2 |
| 4.6 | Secrets handling | The license key and bearer token are passed at runtime (environment variable, AWS Secrets Manager, Kubernetes Secret, Azure secret). None are baked into the image. The license key is redacted from update log lines. | `aws/ecs-task-definition.json` (`secrets`); `aws/helm/c4c-mcp/templates/deployment.yaml`; `server/library.js` (`scrub`); `.dockerignore` (`.env*`, `**/library-signing*.pem`) |

## 5. Access control and authentication

| # | Question | Answer | Evidence |
|---|---|---|---|
| 5.1 | How are clients authenticated? | One shared bearer token. When `C4C_AUTH_TOKEN` is set, every `/mcp` request must send `Authorization: Bearer <token>` or it gets 401. The comparison is constant-time. | `server/node-server.js` (`bearerOk`, `timingSafeEqual`) |
| 5.2 | Is authentication on by default? | Not in the bare image: with no `C4C_AUTH_TOKEN` there is no authentication. The AWS ECS template and Helm chart require the token secret (the Helm `auth-token` key is not optional). We recommend it for every deployment. | `server/config.js`; `aws/ecs-task-definition.json`; `aws/helm/c4c-mcp/templates/deployment.yaml` |
| 5.3 | SSO, SAML, OIDC, per-user accounts, RBAC | Not supported. There are no user accounts or roles. Per-user authentication is a roadmap item. Today, enforce user identity at a gateway or reverse proxy you operate; the optional audit log can record a user identifier from a header that gateway sets. | `server/node-server.js`; `server/audit-log.js` |
| 5.4 | Token rotation | Change the secret and restart the task. Only one token is accepted at a time, so clients must switch together. | `server/config.js` (`authToken`) |
| 5.5 | Unauthenticated endpoints | `/healthz`, which returns only `ok`, library version, age in days and `stale`. All other paths except `/mcp` return 404. | `server/node-server.js` |
| 5.6 | Admin interface or default credentials | None. No passwords, no default credentials, no admin UI. | `SECURITY.md`, "Authentication" |
| 5.7 | Cloud permissions the container needs | None. It needs no AWS credentials or IAM permissions of its own; on ECS only the task execution role reads the two secrets. S3 mirror reads are allowed by a bucket policy tied to your VPC endpoint. The Helm chart disables the service-account token. | `AWS-USAGE.md`, steps 2 and "Updates from your own S3 bucket"; `aws/helm/c4c-mcp/templates/serviceaccount.yaml` |
| 5.8 | Vendor access to customer deployments | None. See 1.8. | |

## 6. Logging and monitoring

| # | Question | Answer | Evidence |
|---|---|---|---|
| 6.1 | What does the server log? | To the console: the listening line, library warnings, one JSON line per update attempt (result, reason, version, detail; license key redacted), rejected malformed Host headers, and internal errors with stack traces. No per-request access log unless the audit log is on. | `server/main.mjs`; `server/library.js` (`startUpdater`); `server/node-server.js` |
| 6.2 | Where do logs go? | Wherever your platform sends container stdout and stderr. The ECS template uses the `awslogs` driver to CloudWatch Logs group `/ecs/c4c-mcp`. The Azure Container Apps offer creates a Log Analytics workspace with 30-day retention. | `aws/ecs-task-definition.json`; `azure/AZURE-USAGE.md` |
| 6.3 | Per-call audit trail for examiners | Optional audit log, off by default. See 2.7. The user identifier and caller address come from request headers, so they are only as trustworthy as the gateway or load balancer that sets them; strip client-supplied copies of those headers at your edge. Request-level network logs (ALB access logs, VPC flow logs) are yours to enable. | `server/audit-log.js` |
| 6.4 | Health monitoring | `/healthz` returns 200 with library version, age and `stale`, or 503 `no_library`. The image has a Docker `HEALTHCHECK`; the ECS template and Helm chart probe it. | `Dockerfile`; `INSTALL.md`, "Health check" |
| 6.5 | Content currency monitoring | Every tool result carries a `library` block (version, build date, age in days). After `C4C_STALE_DAYS` (default 14) without a new library, results and `/healthz` report `stale`. | `src/library-info.js`; `server/config.js` |

## 7. Vulnerability and patch management

| # | Question | Answer | Evidence |
|---|---|---|---|
| 7.1 | Are images scanned? | Release images are scanned with Docker Scout before publication, and AWS Marketplace re-scans listed images. | `SECURITY.md`, "Vulnerability management" |
| 7.2 | Current findings | Point-in-time Docker Scout scan of 1.0.1 (linux/amd64) on 2026-10-25: 0 critical, 9 high, 4 medium, 38 low. One high has a fix available: `zod` 4.6.5 (CVE-2023-54404, fixed in 4.6.6), an npm dependency. The other highs are Debian base-image packages with no fix listed. See `VULNERABILITY-AND-SBOM.md`. Fixed in image 1.0.2 (`zod` 4.6.7): a Docker Scout scan of the 1.0.2 build on 2026-10-25 shows 0 fixable critical or high findings; the remaining highs are base-image packages with no fix. | `sbom/c4c-mcp-1.0.1.scout-cves.sarif.json` |
| 7.3 | Patch cadence and SLAs | Each release is rebuilt on the current base image, and images are rebuilt when fixes become available. There is no written remediation SLA. Details on request (earl@cfsynergies.com). | `SECURITY.md`, "Vulnerability management" |
| 7.4 | SBOM | Provided in this pack for 1.0.1 (SPDX JSON), and reproducible by the reviewer. | `sbom/c4c-mcp-1.0.1.spdx.json`; `VULNERABILITY-AND-SBOM.md` |
| 7.5 | Image signing and provenance | Not in place. Images are not signed (no cosign or Notary signature) and carry no provenance attestations. Verify releases by digest. Library content is signed separately (see 4.4). | `VULNERABILITY-AND-SBOM.md` |
| 7.6 | Attack surface reduction | Base `node:24-slim`. npm, npx, corepack and yarn are removed from the runtime image. Production dependencies only. Tests, scripts, hosted-only code, `.env*` files and signing keys are excluded from the build context. | `Dockerfile`; `.dockerignore`; `test/image-scope.test.js` |
| 7.7 | Input limits | Request bodies capped at 4 MiB (413 above). Search work is bounded per query; `verify_quote` refuses candidates over 5,000 words. No built-in rate limiting: put a gateway or load balancer in front if you need it. | `server/node-server.js` (`MAX_BODY_BYTES`); `test/security-caps.test.js`; `src/tools/verify.js` (`MAX_WORDS`) |

## 8. Secure development (SDLC)

| # | Question | Answer | Evidence |
|---|---|---|---|
| 8.1 | Is source code available for review? | Yes. Server source is public under the Elastic License 2.0. Reviewers can build the image themselves and compare. | `public-repo/README.md`; `public-repo/LICENSE` |
| 8.2 | Automated testing | A vitest suite covers the HTTP layer (auth, body cap, health), library signing and install, mirror and offline load, input caps, and an image-scope test that fails if the self-hosted server imports hosted-only code. Details on request (earl@cfsynergies.com). | `test/node-server.test.js`; `test/library-updater.test.js`; `test/security-caps.test.js`; `test/image-scope.test.js` |
| 8.3 | Dependency management | Dependencies are locked (`package-lock.json`) and installed with `npm ci --omit=dev`. The base image is referenced by tag (`node:24-slim`), not by digest. | `Dockerfile` |
| 8.4 | Code review, branch protection, separation of duties | Details on request (earl@cfsynergies.com). CF Synergies is a small company; assume a single maintainer unless stated otherwise. | n/a |
| 8.5 | Build safeguards | The build fails if the library public key is missing, so a release image cannot ship unable to verify updates. | `Dockerfile` (`ALLOW_NO_PUBLIC_KEY` check) |
| 8.6 | Container runtime hardening | Runs as non-root `node` (UID 1000). Works with a read-only root filesystem; writes only `/data` and `/tmp`. Needs no privileged mode, host networking or added capabilities. The Helm chart sets `runAsNonRoot`, drops all capabilities, disables privilege escalation and uses the RuntimeDefault seccomp profile. | `Dockerfile`; `aws/helm/c4c-mcp/templates/deployment.yaml` |

## 9. Third parties and subprocessors

| # | Question | Answer | Evidence |
|---|---|---|---|
| 9.1 | Subprocessors that receive customer tool calls or answers | None. The self-hosted server sends no tool calls, answers or telemetry to C4C or anyone else. | `DATA-FLOW.md` |
| 9.2 | Third parties in the update path | Cloudflare hosts the update feed and stores library files (R2). Only used when the server or your gate host fetches from the C4C feed. | `RELEASE.md` |
| 9.3 | Image distribution | AWS Marketplace (Amazon ECR, `709825985650.dkr.ecr.us-east-1.amazonaws.com/cf-synergies/c4c-mcp`), GitHub Container Registry (`ghcr.io/earl-hash/c4c-mcp`, used by the Azure templates), an image file sent by C4C, or a build from public source. | `aws/ecs-task-definition.json`; `azure/container-apps/mainTemplate.json`; `INSTALL.md`, "Get the image" |
| 9.4 | Third parties in license sign-up | Details on request (earl@cfsynergies.com). | n/a |
| 9.5 | Open-source components | See the SBOM. Main npm dependencies: `@modelcontextprotocol/server`, `agents`, `zod`, on Node.js 24 and Debian. | `package.json`; `sbom/c4c-mcp-1.0.1.spdx.json` |

## 10. Incident response

| # | Question | Answer | Evidence |
|---|---|---|---|
| 10.1 | How do we report a vulnerability? | Email earl@cfsynergies.com with the image tag and library version (from `/healthz`). | `SECURITY.md` |
| 10.2 | Documented incident response plan | Details on request (earl@cfsynergies.com). | n/a |
| 10.3 | Customer notification commitments and timelines | Details on request (earl@cfsynergies.com). CF Synergies holds no customer tool data for the self-hosted product, so an incident at CF Synergies cannot expose your queries. | `DATA-FLOW.md` |
| 10.4 | What if the update feed or signing key is compromised? | A tampered library cannot install unless it is signed with the private key. If the private key were compromised, there is no in-band revocation; CF Synergies would need to ship a new image with a new public key. Customers can stop updates at once by unsetting `C4C_LICENSE_KEY` or pointing `C4C_UPDATE_URL` at a mirror they control, and keep serving the installed library. | `server/library.js`; `RELEASE.md`, "One-time setup" step 2 |
| 10.5 | Rollback | The previous library is kept. Removing `manifest.json` and restarting makes the server serve the verified previous version. | `INSTALL.md`, "Rollback" |

## 11. Business continuity

| # | Question | Answer | Evidence |
|---|---|---|---|
| 11.1 | What if C4C is unavailable or the company ceases operations? | The server keeps running and answering from the installed library. It does not need C4C to start or serve. Answers report the library age and, after `C4C_STALE_DAYS`, mark it `stale`. | `INSTALL.md`, "License expiry"; `src/library-info.js` |
| 11.2 | What if an update fails mid-download? | Nothing changes; the current library keeps serving. Installs are atomic and keep the previous version. | `server/library.js` |
| 11.3 | Can we run fully offline? | Yes. Load signed library files by hand with `server/load-library.mjs`. | `INSTALL.md`, "Offline load" |
| 11.4 | Source code escrow | Server source is public. The library is licensed, not escrowed. Details on request (earl@cfsynergies.com). | `public-repo/README.md` |
| 11.5 | High availability | One replica by default. The server is stateless per request, so you can run more replicas behind a load balancer; each keeps its own copy of the library. | `aws/helm/c4c-mcp/values.yaml` (`replicaCount: 1`); `server/node-server.js` (stateless streamable HTTP) |
| 11.6 | Vendor BC/DR plan for the update feed | Details on request (earl@cfsynergies.com). | n/a |

## 12. AI-specific questions

| # | Question | Answer | Evidence |
|---|---|---|---|
| 12.1 | Does the product contain or call an AI model or LLM? | No. It is a lookup server: full-text search and citation lookup over a SQLite library. It calls no model and no external API. The customer's own AI client calls it. | `server/node-server.js`; `src/server.js`; no outbound calls in the shipped code other than the updater |
| 12.2 | Does the vendor train models on customer data? | No. CF Synergies receives no customer tool calls or answers from the self-hosted server, so there is nothing to train on. The library license also forbids using the library to train or evaluate AI models. | `DATA-FLOW.md`; `public-repo/LIBRARY-LICENSE.md` §3 |
| 12.3 | Are outputs deterministic? | Yes for a given library version: answers come from database queries with no sampling or randomness. Some notices depend on the current date (for example library age). | `src/tools/*.js`; `src/library-info.js` |
| 12.4 | Hallucination controls | Answers return the regulator's text verbatim with its citation, effective date where known, version and currency status. `verify_quote` lets an AI client check that a quotation actually appears in the source text and reports exact, normalized, composed (with any omitted words disclosed) or not found. Server instructions tell the AI to quote verbatim and verify quotes. The server cannot stop a client AI from paraphrasing or inventing; human review is required. | `src/tools/verify.js`; `src/instructions.js` |
| 12.5 | SR 11-7 / model risk relevance | The server is a retrieval tool that returns stored text; it does not produce quantitative estimates. The AI system that uses it may be in your model or AI inventory. Your model-risk function decides how to classify it. See `AI-USE-STATEMENT.md`. | `AI-USE-STATEMENT.md` |
| 12.6 | Does the product make decisions? | No. It returns text and citations. The optional Decision Workspace drafts a file note that a person must approve, and stores nothing. | `src/workspace/notes.js` |
| 12.7 | Is it legal advice? | No. Research and reference use only. Every result carries a research-only notice. | `public-repo/LIBRARY-LICENSE.md` §2; `src/instructions.js` |
