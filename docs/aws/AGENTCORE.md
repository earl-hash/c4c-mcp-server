# C4C on Amazon Bedrock AgentCore Runtime

The AgentCore edition of the C4C MCP server runs as an MCP server in Amazon Bedrock AgentCore Runtime. The signed regulation library is built into the image, so each AgentCore session answers within seconds with no download, no license key and no outbound connection.

Research use only; results are not legal advice.

Tested 2026-10-26 on real AgentCore Runtime (us-east-1): MCP protocol, IAM (SigV4) inbound auth, all 10 tools, quote verification, audit log to CloudWatch, unsigned requests refused.

## What you get

| | AgentCore edition | Standard image (ECS, EKS, Docker) |
|---|---|---|
| Image | `c4c-mcp:<version>-agentcore` (arm64 + amd64) | `c4c-mcp:<version>` |
| Port | 8000, path `/mcp`, health `/ping` | 8080, path `/mcp`, health `/healthz` |
| Library | Built in, signed, verified at start | Downloaded at first start (feed, your mirror, or offline) |
| Auth | AgentCore inbound auth (IAM SigV4 or OAuth JWT) | Bearer token (`C4C_AUTH_TOKEN`) |
| Library updates | New image version (each Marketplace version ships the then-current library) | Daily, signed, through your gates |

## Deploy

1. Subscribe to the C4C listing on AWS Marketplace (free) and choose the **Amazon Bedrock AgentCore Runtime** delivery option. It gives you the image URI.
2. Create an execution role that `bedrock-agentcore.amazonaws.com` can assume, with `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` and `ecr:GetAuthorizationToken` for the image, and CloudWatch Logs write access to `/aws/bedrock-agentcore/runtimes/*`.
3. Create the runtime in the AgentCore console, or with the CLI:

```
aws bedrock-agentcore-control create-agent-runtime --region us-east-1 \
  --agent-runtime-name c4c_mcp \
  --agent-runtime-artifact '{"containerConfiguration":{"containerUri":"<image URI>"}}' \
  --protocol-configuration '{"serverProtocol":"MCP"}' \
  --network-configuration '{"networkMode":"PUBLIC"}' \
  --role-arn <execution role ARN> \
  --environment-variables C4C_AUDIT_LOG=stdout
```

It is READY in under a minute. Use `networkMode` `VPC` to keep it inside your network (the edition needs no outbound access).

**Do not set `C4C_AUTH_TOKEN`.** AgentCore authenticates callers before requests reach the container; a static token would make every call fail with 401.

## Call it

The MCP endpoint is
`https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/<URL-encoded runtime ARN>/invocations?qualifier=DEFAULT`, signed with SigV4 (service `bedrock-agentcore`) or carrying an OAuth bearer token, depending on how you configured inbound auth.

- Send `initialize` first. AgentCore returns an `Mcp-Session-Id` header; send it back on later calls. Standard MCP clients do this. Calls in the same session stay on one warm microVM (about half a second each). A call without it starts a new microVM (about 7 seconds).
- Agents in AgentCore, Strands, LangGraph or your own code can use any MCP client with a SigV4 or OAuth transport. You can also add the runtime as an AgentCore Gateway target.
- Quick check from the CLI:

```
aws bedrock-agentcore invoke-agent-runtime --region us-east-1 \
  --agent-runtime-arn <runtime ARN> --runtime-session-id <33+ character id> \
  --content-type application/json --accept "application/json, text/event-stream" \
  --cli-binary-format raw-in-base64-out \
  --payload '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"lookup_citation","arguments":{"citation":"12 CFR 1026.43"}}}' out.txt
```

Give your agent the instructions in [AGENT-INSTRUCTIONS.md](../AGENT-INSTRUCTIONS.md) so it quotes the regulator's words with citations.

## Environment variables

| Name | Default | Purpose |
|---|---|---|
| `C4C_AUDIT_LOG` | `off` | `stdout` writes one JSON line per tool call (tool, arguments, citations returned, library version) to the runtime's CloudWatch log group. Never sent anywhere else. |
| `C4C_AUDIT_USER_HEADER` | none | A request header that carries the end user's identity, recorded in each audit line. AgentCore passes only allowlisted headers to the container; add it to the runtime's request header allowlist (`--request-header-configuration requestHeaderAllowlist=...`). |
| `C4C_UPDATE_URL` | none | Optional: your own signed-library mirror reachable from the runtime (VPC mode). A newer verified library in the session replaces the built-in one. Usually unnecessary: sessions last at most 8 hours. |

## Library currency

Each AgentCore image carries the library current when that Marketplace version was built. Every tool result carries a `library` block (version, built date, age in days) and sets `stale: true` once the library is more than 14 days old. Update the runtime to the latest Marketplace version to pick up new rules (existing sessions keep the old image until they end).

Full guide, security review pack and source: https://github.com/earl-hash/c4c-mcp-server. Support: earl@cfsynergies.com
