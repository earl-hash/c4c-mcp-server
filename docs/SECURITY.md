# C4C self-hosted: security overview

For vendor-risk and information-security reviewers. Research use only; C4C returns regulatory text and citations and is not legal advice. See `DATA-FLOW.md` for the full data-flow statement.

## What it is

A single container running a read-only MCP server. It answers lookups against a public-regulation library (a SQLite file in `/data`). It stores no customer data, has no user accounts and no database of its own beyond that library file.

## Data handling

- No customer data enters the library. Tools take search terms and citations only; your documents stay in your AI tool.
- Request bodies and answers are not logged on purpose (an internal error message may quote part of the request that caused it), unless you turn on the audit log.
- Optional audit log (`C4C_AUDIT_LOG=stdout|file`, off by default): one line per tool call with the tool, the arguments your AI tool sent, the citations and section ids returned, the library version, outcome, duration, client and caller address, and a user identity if your gateway supplies one (`C4C_AUDIT_USER_HEADER`). Failed bearer checks are logged without the token. It is written only to your console or `/data/audit`, never sent anywhere.
- The optional usage report (off by default) holds daily counts by tool and document name only, stays on your disk and is never sent.

## Network

- Inbound: TCP 8080, `/mcp` (MCP streamable HTTP) and `/healthz`. Request bodies are capped at 4 MiB.
- Outbound: none required. Updates come from `C4C_UPDATE_URL` by HTTPS GET: either your own mirror inside your network (no license key is sent and C4C is never contacted; fill it at your gate with `server/mirror-library.mjs`), or the C4C feed `https://mcp.claudeforcompliance.com/library`, which receives the license key and nothing else. No telemetry, no other hosts. Proxies are supported (`HTTPS_PROXY`, custom CA via `NODE_EXTRA_CA_CERTS`). With no license key and no mirror the container makes no outbound connections; libraries can be loaded offline.

## Authentication

- Set `C4C_AUTH_TOKEN` and every `/mcp` request must carry `Authorization: Bearer <token>`; requests without it get 401. Strongly recommended for any deployment, required by our AWS templates.
- No passwords, no default credentials, no secrets baked into the image. The license key and token are passed at runtime (environment, AWS Secrets Manager or Kubernetes Secret).
- The container needs no AWS credentials or IAM permissions.

## Integrity of the library

- Every library release is signed with an Ed25519 private key that CF Synergies keeps outside the image, the source repository and the update server. The public key is built into the image.
- The server verifies the signature and the SHA-256 checksum before installing; anything that fails is discarded and the current library keeps serving. Only newer versions install unless an operator explicitly allows a downgrade.
- Installs are atomic, with the previous version kept for rollback.
- Every answer reports the library version and age; after a configurable number of days without updates, answers and `/healthz` are marked `stale`.

## Container hardening

- Base image `node:24-slim` (Debian). npm, npx, corepack and yarn are removed from the runtime image; only production dependencies are installed.
- Runs as the non-root `node` user (UID 1000). Works with a read-only root filesystem; only `/data` and `/tmp` are written.
- No privileged mode, host networking or added capabilities needed; the Helm chart drops all capabilities, disables privilege escalation and uses the RuntimeDefault seccomp profile.
- Built for linux/amd64 and linux/arm64.

## Vulnerability management

- Each release image is scanned before publication (Docker Scout) and again by AWS Marketplace, which re-scans listed images continuously. Releases ship with no known fixable critical or high vulnerabilities.
- Remaining findings are base-OS packages with no upstream fix; we rebuild on the current base image for each release and when fixes become available.
- SBOM: `docker scout sbom --format spdx <image> > sbom.spdx.json` (or `syft <image> -o spdx-json`). See `security-pack/` for the published SBOM and scan of each release.

## Source and licensing

- Server source is public: https://github.com/earl-hash/c4c-mcp-server (Elastic License 2.0). Reviewers can build the image themselves and compare.
- The library is licensed for research and reference use only under the C4C Library License.

## Reporting a security issue

earl@cfsynergies.com. Please include the image tag and library version (`/healthz`).
