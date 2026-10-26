# C4C: self-hosted install guide

This guide installs the C4C regulatory MCP server inside your own network. Your AI tools (Claude, ChatGPT, Copilot, internal agents) connect to it over MCP and read the regulation library from your own server. It never sends questions, documents or answers anywhere, and it does not need to contact C4C at all: rule updates can reach it through your own gates (see "Updates through your own gates" below). The only optional connection to C4C is the update download, which carries your license key. Whether questions and answers stay inside your network depends on the AI tool: an in-network agent or a self-hosted model keeps everything inside, while cloud assistants (ChatGPT, Claude connectors, Copilot Studio) connect from the vendor's cloud, so their questions and answers pass through that vendor under its terms (see "Connect your AI tools"). See `DATA-FLOW.md` for the full picture.

Research only. C4C returns regulatory text and citations. It is not legal advice.

## Requirements

- A Linux host (or any host that runs Docker) with Docker 24 or later.
- 2 GB of RAM and about 5 GB of free disk for the library volume (several versions are kept for rollback).
- Inbound access: port 8080 from the machines or tools that will connect.
- Outbound access: none required. For updates, either fill an internal mirror through your own gates (below), allow HTTPS (port 443) to `mcp.claudeforcompliance.com`, or use the offline load.
- Your C4C license key, needed only where updates are fetched from C4C (your gate host, or the server itself if it uses the C4C feed directly). It is free: sign up at https://mcp-auth.claudeforcompliance.com/self-hosted (confirm by email; the key is shown once, and signing up again with the same email replaces it).

## Get the image

Either build it from the public source, https://github.com/earl-hash/c4c-mcp-server:

```
git clone https://github.com/earl-hash/c4c-mcp-server.git
cd c4c-mcp-server
docker build -t c4c-mcp:<tag> .
```

or ask us for a prebuilt image. C4C sends a prebuilt image as a file named `c4c-mcp-<tag>.tar.gz`, where `<tag>` is the image version (for example `c4c-mcp-1.0.0.tar.gz`). Copy it to the Docker host and load it:

```
docker load -i c4c-mcp-<tag>.tar.gz
```

Docker prints `Loaded image: c4c-mcp:<tag>`. Use that same tag in every command below (they show `c4c-mcp:<tag>`; replace `<tag>` with yours). When we send a new image, load it the same way, then stop and remove the old container and start a new one with the new tag. The library volume (`c4c-data`) is kept.

## Start the server

```
docker run -d --name c4c-mcp \
  --restart unless-stopped \
  --read-only --tmpfs /tmp \
  -v c4c-data:/data \
  -p 8080:8080 \
  -e C4C_LICENSE_KEY=your-license-key \
  -e C4C_UPDATE_URL=https://mcp.claudeforcompliance.com/library \
  -e C4C_UPDATE_INTERVAL_H=24 \
  -e C4C_DOWNLOAD_TIMEOUT_MIN=30 \
  -e C4C_STALE_DAYS=14 \
  -e C4C_AUTH_TOKEN=choose-a-long-random-token \
  -e C4C_USAGE_REPORT=0 \
  -e PORT=8080 \
  -e C4C_DATA_DIR=/data \
  c4c-mcp:<tag>
```

| Variable | Default | Meaning |
|---|---|---|
| `C4C_LICENSE_KEY` | none | Turns on automatic updates from the C4C feed. Not needed when `C4C_UPDATE_URL` is your own mirror. With no key and no mirror the server never contacts anyone and serves only what is in `/data`. |
| `C4C_UPDATE_URL` | `https://mcp.claudeforcompliance.com/library` | Where updates are fetched. Must be `https`. Any address other than the C4C feed is treated as your mirror: updates run without a license key and nothing is sent to C4C. |
| `C4C_UPDATE_INTERVAL_H` | `24` | Hours between update checks. |
| `C4C_DOWNLOAD_TIMEOUT_MIN` | `30` | Overall ceiling for one library download. |
| `C4C_STALE_DAYS` | `14` | After this many days without a new library, answers and `/healthz` report `stale`. |
| `C4C_AUTH_TOKEN` | none (no auth) | If set, every `/mcp` request must send `Authorization: Bearer <token>`. Strongly recommended. |
| `C4C_USAGE_REPORT` | `0` | Set `1` to write the optional local usage report (see below). |
| `C4C_AUDIT_LOG` | `off` | Set `stdout` or `file` to keep an audit log of every tool call (see "Audit log" below). |
| `C4C_AUDIT_USER_HEADER` | none | Name of a request header your gateway or proxy sets with the user's identity (for example `x-user-email`). Its value is recorded in the audit log. |
| `C4C_WORKSPACE` | `0` | Set `1` to turn on the Decision Workspace: the `record_rules`, `propose_file_note` and `tag_record` tools and the `decision-workspace` playbook. These tools store nothing; file notes are drafts a person approves before saving them in your own loan system. |
| `PORT` | `8080` | Listening port inside the container. |
| `C4C_DATA_DIR` | `/data` | Library and report location. Keep it on a volume. |

The image runs as a non-root user and works with a read-only root filesystem. Only `/data` and `/tmp` are written.

### First start

If `/data` is empty and you have no license key, the server stays up in "no library" mode: `/healthz` returns 503 and tool calls answer "The regulation library is not installed yet". With a license key, the first library downloads automatically within a few minutes. Otherwise load one offline.

## Connect your AI tools

Step-by-step recipes for each tool (Claude Code, Claude Desktop, Amazon Bedrock and AgentCore, Microsoft Foundry and Copilot Studio, Python, curl) are in `CONNECT.md`. To confirm an install works, run `docker exec c4c-mcp node server/verify-install.mjs --url http://127.0.0.1:8080/mcp` (or `scripts/verify-install.sh` / `.ps1` from any machine).

The MCP endpoint is `http://<host>:8080/mcp` (streamable HTTP). Put it behind your own TLS reverse proxy if clients connect across a network you do not control.

Where the client runs matters:

- Clients inside your network (an internal agent, Claude Code on a staff machine talking to the server directly, or an agent driving a self-hosted model) reach the server over your network. With a self-hosted model, questions and answers stay inside your network.
- Cloud assistants (ChatGPT connectors, Claude custom connectors added in claude.ai, Copilot Studio) call MCP servers from the vendor's cloud, not from your network. To use them, the server must be reachable from the internet over HTTPS: put it behind a TLS reverse proxy with a public name, and set `C4C_AUTH_TOKEN` so only requests carrying the token are served. The questions those assistants send to C4C, and the regulation text C4C returns, then pass through that vendor under its terms, as does everything else you type into that assistant.

- Claude Code: `claude mcp add --transport http c4c <url> --header "Authorization: Bearer <token>"`, or a shared `.mcp.json` (see `CONNECT.md`).
- Claude Desktop: custom connectors added in Claude settings connect from Anthropic's cloud and cannot reach a server inside your network. For an internal server, add a local entry to `claude_desktop_config.json` that runs a bridge such as `mcp-remote` (see `CONNECT.md`).
- ChatGPT: custom connectors connect from OpenAI's cloud and support OAuth or no authentication; they cannot send a fixed bearer token. They are not a fit for this server's bearer-token setup.
- Microsoft Copilot (Copilot Studio): add an MCP server tool pointing at the URL, with the bearer token as the authentication header.
- Internal agents: any MCP client library works. Send JSON-RPC `initialize`, then `tools/call`, to the URL with `Accept: application/json, text/event-stream`.

Every answer includes a `library` block with the library version, build date and age in days, so reviewers can see how current the text is. Request bodies are limited to 4 MiB.

## Health check

```
curl http://<host>:8080/healthz
```

- `200 {"ok":true,"library_version":"2026-10-09.1","age_days":3,"stale":false}`: serving.
- `503 {"ok":false,"reason":"no_library"}`: running, but no library is installed.

The image has a built-in Docker health check against the same endpoint. Until a library is installed (503 `no_library`) the container reports `unhealthy`. If you use an orchestrator or a supervisor that restarts unhealthy containers, load the first library before enabling that restart policy, or it will keep restarting the container.

## Updates

With a license key, the server checks the update URL every `C4C_UPDATE_INTERVAL_H` hours. A new library is downloaded, its signature and checksum are verified, and it is swapped in while requests keep running. A failed or corrupt download changes nothing; the current library keeps serving. Only newer libraries are accepted. Versions look like `2026-10-09.1`.

## Updates through your own gates

If your servers must not reach outside services, keep them inside and let your gate bring the updates in. Every release is signed, so it is verified however it arrives.

1. **At the gate** (a jump host, an artifact-repository job, a managed file transfer step), fetch the newest release from C4C into a folder. The image includes the tool, so Docker is all the gate needs:

   ```
   docker run --rm -e C4C_LICENSE_KEY=your-license-key -v /srv/c4c-mirror:/mirror c4c-mcp:<tag>      node --no-warnings server/mirror-library.mjs --out /mirror
   ```

   It checks the signature and the library checksum before writing anything, writes the manifest last, and keeps the two newest versions (`--keep N` to change). Run it on a schedule (daily is plenty). Scan or approve the folder however your process requires.

2. **Inside your network**, serve that folder over HTTPS from any static web server or artifact repository (Artifactory, Nexus, an S3-compatible bucket, IIS). It must serve `manifest.json`, `manifest.sig` and `<version>/corpus.sqlite.gz` at the paths the tool wrote.

3. **On each C4C server**, point `C4C_UPDATE_URL` at it and leave `C4C_LICENSE_KEY` unset:

   ```
   -e C4C_UPDATE_URL=https://artifacts.yourcompany.internal/c4c
   ```

   The server checks your mirror every `C4C_UPDATE_INTERVAL_H` hours, sends no license key, never contacts C4C, and verifies the signature again before installing. If your mirror uses an internal certificate authority, mount it and set `NODE_EXTRA_CA_CERTS` (see Proxies).

## Offline load

For sites with no outbound access, we send you three files: `corpus-<version>.sqlite.gz`, `manifest.json` and `manifest.sig`. Copy them to the host and run:

```
docker run --rm -v c4c-data:/data -v "$PWD:/pkg:ro" c4c-mcp:<tag> \
  node --no-warnings server/load-library.mjs \
  /pkg/corpus-2026-10-09.1.sqlite.gz /pkg/manifest.json /pkg/manifest.sig
```

The loader verifies the signature with the public key built into the image and refuses anything that does not verify. Add `--allow-downgrade` to deliberately install an older version. If it reports `busy`, an update is running; wait a few minutes and retry.

Restart the server after every offline load: `docker restart c4c-mcp`. A running server with no license key (the usual offline setup), or one that started with no library, never checks for updates, so it keeps serving the old library (or none) until it restarts. A licensed running server also picks up the offline load on its next update check (up to `C4C_UPDATE_INTERVAL_H` hours later), but a restart makes it serve the new version right away. The loader's success message says the same.

## Rollback

The server keeps the previous library next to the current one. To go back one version:

1. `docker stop c4c-mcp`
2. In the volume, delete or rename `manifest.json` (for example `docker run --rm -v c4c-data:/data debian:stable-slim mv /data/manifest.json /data/manifest.json.bad`).
3. `docker start c4c-mcp`

On start, with `manifest.json` missing, the server falls back to the verified previous manifest (`manifest.prev.json`) and its library file. Each release is a separate file named `corpus-<version>.sqlite`, so nothing is overwritten. Note that a licensed server will download the newer library again on its next check; to stay on the older one, stop automatic updates by removing `C4C_LICENSE_KEY` until we have a fixed release.

## License expiry

When your license expires the server keeps running and keeps answering from the library it has. It simply stops getting updates. Answers keep showing the library age, and after `C4C_STALE_DAYS` they and `/healthz` mark the library as `stale`, so reviewers know to treat the text as possibly out of date. Renewing the license resumes updates with no other action.

## Proxies

If your network requires an outbound proxy, set `HTTPS_PROXY` (and `NO_PROXY` if needed) on the container, for example `-e HTTPS_PROXY=http://proxy.example.com:3128`. The image sets `NODE_USE_ENV_PROXY=1`, which is what makes the server honor those variables. If you build your own image, keep that setting. If your proxy re-signs TLS, mount your CA bundle and set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.

## Usage report (optional, off by default)

With `C4C_USAGE_REPORT=1` the server writes counts to `/data/usage-YYYY-MM.json`, one file per month:

```
{ "2026-10-09": { "tool:search_regs": 41, "tool:get_obligation": 17 } }
```

It holds only counts per day, by tool name and document name. There is no query text, no user or client information. It is never sent anywhere. If you want us to see it (for example to size a renewal), you send the file yourself.

## Audit log (optional, off by default)

For examiners and internal audit: a record, kept in your environment, of what your AI tools asked C4C and what C4C returned. With `C4C_AUDIT_LOG=stdout` the server writes one JSON line per tool call to its console, so your log collector (CloudWatch, Azure Monitor, Splunk) keeps it. With `C4C_AUDIT_LOG=file` it appends to `/data/audit/audit-YYYY-MM-DD.jsonl` (keep `/data` on a volume).

```
{"type":"c4c_audit","ts":"2026-10-25T23:35:51.754Z","request_id":"853d595e-...","rpc_id":6,
 "tool":"search_regs","arguments":{"query":"large deposits"},
 "citations_returned":["B3-4.2-02","B3-4.3-09","Freddie Mac Guide 5501.1"],
 "sections_returned":["fnma-sel-b3-4-2-02::fnma-sel-b3-4.2-02-full", "..."],
 "outcome":"ok","duration_ms":227,"library_version":"2026-10-22.1",
 "user":"uw1@lender.example","client":"claude-code/2.0","remote":"10.0.4.12"}
```

- `arguments` are what the AI tool sent: search terms, citations or quoted text (cut at 4,000 characters). If your AI tool puts borrower details in a search, they are recorded here, so treat the log like other internal records and set retention to match your policy.
- `citations_returned` and `sections_returned` name what came back, so a reviewer can pull the same text later from the same `library_version`. The regulation text itself is not copied into the log.
- `user` appears only when you set `C4C_AUDIT_USER_HEADER` and your gateway sends that header. The bearer token is never logged. Failed bearer checks are logged as `{"event":"auth_failed", ...}` with the caller address.
- The log is never sent anywhere by C4C. A write failure is reported once on the console and never stops the server.

## SBOM

To produce a software bill of materials for your security review:

```
docker scout sbom --format spdx c4c-mcp:<tag> > sbom.spdx.json
```

(or `syft c4c-mcp:<tag> -o spdx-json=sbom.spdx.json`).

## Support

earl@cfsynergies.com
