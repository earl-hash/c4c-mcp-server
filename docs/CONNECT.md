# C4C self-hosted: connect your AI tools

Research only. C4C returns regulatory text and citations. It is not legal advice.

This page has copy-paste recipes for connecting AI tools to your C4C server. Each recipe lists what the tool needs to reach, the configuration, and a test question.

Throughout this page:

- `https://c4c.example.internal/mcp` stands for your endpoint. Without a TLS proxy it is `http://<host>:8080/mcp`.
- `C4C_TOKEN` is an environment variable holding the bearer token you set as `C4C_AUTH_TOKEN` on the server. Clients send it as `Authorization: Bearer <token>`.
- The endpoint is MCP streamable HTTP, stateless. Raw HTTP clients must send `Accept: application/json, text/event-stream`. Answers come back as JSON or as server-sent events (`data:` lines).

Before connecting anything, run the install check from a machine on the same network as the client (see "Check the install first" at the end).

Facts below were checked against vendor documentation on 2026-10-25. Vendors change these products often; the source links let you recheck.

## First: where does the client run?

This decides whether a tool can reach a server that lives only inside your network.

| Client | Where its MCP calls come from | Can reach an internal-only server? |
|---|---|---|
| Claude Code (CLI, IDE) | The staff machine | Yes |
| Claude Desktop, local server entry (via `mcp-remote`) | The staff machine | Yes |
| Claude Desktop, claude.ai, Cowork "custom connectors" | Anthropic's cloud | No |
| Your own agent (Python, Lambda, container) | Wherever you run it | Yes, if it runs in your network |
| Amazon Bedrock AgentCore Gateway | AWS, with a private endpoint into your VPC | Yes, through VPC Lattice |
| Amazon Bedrock AgentCore Runtime (VPC mode) | ENIs in your subnets | Yes |
| Amazon Bedrock Agents (action-group Lambda in your VPC) | The Lambda in your VPC | Yes |
| Microsoft Foundry Agent Service (Standard setup, private networking) | Your VNet's MCP subnet | Yes |
| Microsoft Copilot Studio | Microsoft's cloud | Not documented for MCP; plan on a public endpoint |
| ChatGPT apps / developer mode | OpenAI's cloud | No |

A "No" row means the server must have a public HTTPS name (your TLS reverse proxy in front of the container). That tool's vendor then carries the questions it sends to C4C and the regulation text C4C returns. See "Where questions and answers go" below.

## Claude Code

**Reach:** the developer's machine must reach the endpoint (office network or VPN).

Add it for yourself:

```
claude mcp add --transport http c4c https://c4c.example.internal/mcp \
  --header "Authorization: Bearer $C4C_TOKEN"
```

`--scope` sets who gets it: `local` (default, you in this project), `user` (you in every project), `project` (written to `.mcp.json` for the team). Check it with `claude mcp list` or `/mcp` inside Claude Code.

For a team, commit `.mcp.json` at the repo root and keep the token out of it:

```json
{
  "mcpServers": {
    "c4c": {
      "type": "http",
      "url": "https://c4c.example.internal/mcp",
      "headers": { "Authorization": "Bearer ${C4C_TOKEN}" }
    }
  }
}
```

Each person sets `C4C_TOKEN` in their own environment. `${VAR:-default}` also works. If a variable is unset and has no default, Claude Code leaves the literal `${VAR}` text and warns. Use a name like `C4C_TOKEN`. Claude Code does not expand some credential names (for example `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`) in remote server headers.

**Test question:** "Using C4C, quote 12 CFR 1026.43(c)(1) verbatim with its citation."

Source: https://code.claude.com/docs/en/mcp

## Claude Code on Amazon Bedrock (inference stays in your AWS account)

Claude Code can use Claude models through Amazon Bedrock in your account instead of the Anthropic API. Combined with the C4C server in your VPC, prompts go to Bedrock in your account and C4C traffic stays on your network.

```
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=us-east-1          # the region where you enabled Claude models
export AWS_PROFILE=your-profile      # or any standard AWS credential source
# optional: pin a model or inference profile
export ANTHROPIC_MODEL='us.anthropic.claude-sonnet-4-6'
claude
```

Then add C4C exactly as in the Claude Code section. Your org needs Claude models enabled in Bedrock and IAM permission to invoke them. Claude Code also has a `/setup-bedrock` wizard.

Source: https://code.claude.com/docs/en/amazon-bedrock

On Azure, the equivalent is Microsoft Foundry: `CLAUDE_CODE_USE_FOUNDRY=1` and `ANTHROPIC_FOUNDRY_RESOURCE=<resource name>`, with an API key or Entra ID. Source: https://code.claude.com/docs/en/microsoft-foundry

## Claude Desktop

**Important:** a "custom connector" added in Claude Desktop, claude.ai or Cowork (Settings, Connectors) is called from Anthropic's cloud, not from the user's computer. Anthropic's help article says servers "hosted on a private corporate network, behind a VPN, or blocked by a firewall won't connect". To use a custom connector you need a public HTTPS endpoint, and you may allowlist Anthropic's published IP ranges at your proxy. Custom connectors support a fixed request header, so the bearer token works there.

- https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- Anthropic IP ranges: https://platform.claude.com/docs/en/api/ip-addresses

**For an internal-only server**, use a local server entry instead. Claude Desktop starts `mcp-remote` on the user's machine, and `mcp-remote` connects to C4C from that machine. The computer needs Node.js and must reach the endpoint.

Edit `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\claude_desktop_config.json`; macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "c4c": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://c4c.example.internal/mcp",
        "--header", "Authorization:${C4C_AUTH_HEADER}",
        "--transport", "http-only"
      ],
      "env": { "C4C_AUTH_HEADER": "Bearer <your token>" }
    }
  }
}
```

Notes:

- Write `Authorization:${C4C_AUTH_HEADER}` with no space after the colon. The `mcp-remote` README says Claude Desktop on Windows, Cursor and Codex CLI do not escape spaces inside `args`, so the space lives in the env value instead.
- If the endpoint is plain `http://` (no TLS proxy), add `"--allow-http"`. Use it only on a trusted private network.
- `--transport http-only` skips the SSE fallback. C4C speaks streamable HTTP only.
- If your proxy uses an internal certificate authority, add `"NODE_EXTRA_CA_CERTS": "C:\\path\\to\\ca.pem"` to `env`.
- The token sits in this file on the user's machine. Treat the file as a secret, or give each user their own token behind a gateway.
- To avoid `npx` fetching from the public npm registry, install a vetted copy (`npm install -g mcp-remote@<version>`) and set `"command": "mcp-remote"` with the remaining args.

Sources: https://github.com/geelen/mcp-remote, https://modelcontextprotocol.io/docs/develop/connect-local-servers

**Test question:** "Use C4C to look up 12 CFR 1026.43 and quote paragraph (c)(1) exactly."

## Amazon Bedrock AgentCore

**AgentCore Gateway (MCP server target).** Gateway can reach an MCP server inside your VPC through a private endpoint built on Amazon VPC Lattice. You give the target your VPC, subnets and security groups (a managed Lattice resource), or your own Lattice resource configuration (shared through AWS RAM for another account). Requirements and limits from the AWS docs:

- Use an `https://` endpoint. By default Gateway trusts public certificate authorities only. For a private CA, register the certificate with `certificateConfigurations`, and the certificate's subject alternative name must match the host. An internal ALB with an ACM certificate in front of the container works well.
- A target with a private endpoint cannot use no-auth inbound on the gateway unless you add an interceptor Lambda.
- Outbound auth to the MCP server can be none, OAuth, IAM SigV4 (AWS-hosted services only) or an API key credential provider. We have not confirmed that the API key provider can send the value as `Authorization: Bearer <token>`. Test it, or put C4C behind a gateway that accepts the form AgentCore sends.

Example target shape (from the AWS docs, with C4C's endpoint):

```json
{
  "name": "c4c",
  "privateEndpoint": {
    "managedVpcResource": {
      "vpcIdentifier": "vpc-0123456789abcdef0",
      "subnetIds": ["subnet-0aaa", "subnet-0bbb"],
      "endpointIpAddressType": "IPV4",
      "securityGroupIds": ["sg-0123456789abcdef0"]
    }
  },
  "targetConfiguration": { "mcp": { "mcpServer": { "endpoint": "https://c4c.example.internal/mcp" } } }
}
```

Allow the Lattice endpoint's security group to reach the ALB (or container) on its port.

Sources: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-vpc-egress.html, https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-MCPservers.html

**AgentCore Runtime.** An agent hosted in AgentCore Runtime with `networkMode` `VPC` gets network interfaces in your subnets, so it can call the C4C URL directly with any MCP client (see the Python example below). It has no internet access by default. Allow its security group to reach C4C on port 8080 (or your ALB on 443).

Source: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-vpc.html

## Amazon Bedrock Agents (action group Lambda)

Bedrock Agents do not speak MCP directly. A Lambda function in your VPC can call C4C with plain JSON-RPC and return the text to the agent. Define an action group with function details: functions `lookup_citation` (parameter `citation`), `search_regs` (parameter `query`) and `get_obligation` (parameter `obligation_id`). Put the Lambda in subnets that can reach C4C, and give it the token through an encrypted environment variable or AWS Secrets Manager.

```python
# Bedrock Agents action group (function details) -> C4C MCP server. Python 3.12, no extra packages.
import json, os, urllib.request

C4C_URL = os.environ["C4C_URL"]          # e.g. https://c4c.example.internal/mcp
C4C_TOKEN = os.environ["C4C_TOKEN"]      # or read from Secrets Manager at cold start
ALLOWED = {"lookup_citation", "search_regs", "get_obligation", "find_in_section", "verify_quote"}

def call_c4c(tool, arguments):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": tool, "arguments": arguments}}).encode()
    req = urllib.request.Request(C4C_URL, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {C4C_TOKEN}",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode()
    # The answer is JSON or SSE ("data: {...}" lines). Keep the last JSON-RPC message.
    lines = [l[5:].strip() for l in raw.splitlines() if l.startswith("data:")]
    msg = json.loads(lines[-1] if lines else raw)
    if "error" in msg:
        return "C4C error: " + msg["error"].get("message", "unknown")
    return "\n".join(c["text"] for c in msg["result"]["content"] if c.get("type") == "text")

def lambda_handler(event, context):
    fn = event["function"]
    args = {p["name"]: p["value"] for p in event.get("parameters", [])}
    text = call_c4c(fn, args) if fn in ALLOWED else f"Unknown function {fn}"
    return {
        "messageVersion": "1.0",
        "response": {
            "actionGroup": event["actionGroup"],
            "function": fn,
            "functionResponse": {"responseBody": {"TEXT": {"body": text[:20000]}}},
        },
        "sessionAttributes": event.get("sessionAttributes", {}),
        "promptSessionAttributes": event.get("promptSessionAttributes", {}),
    }
```

C4C is stateless, so a single `tools/call` per request works without an `initialize` first. Long sections are paged (`get_obligation` returns `next_offset`); the trim to 20,000 characters keeps the action group response small. Add the instructions from `AGENT-INSTRUCTIONS.md` to the agent's instructions.

Source for the event and response format: https://docs.aws.amazon.com/bedrock/latest/userguide/agents-lambda.html

**Test question:** "What does 12 CFR 1026.43(c)(1) say? Quote it."

## Microsoft Foundry Agent Service (formerly Azure AI Foundry)

**Reach:** Foundry agents can call MCP servers that are not on the public internet, but only with the Standard agent setup and private networking (your own VNet with a dedicated MCP subnet). The Basic setup cannot. Microsoft tested this with Azure Container Apps on internal-only ingress, which is what the C4C Azure offer deploys. Peer the C4C virtual network with the agent network and link the C4C private DNS zone to it (see `azure/AZURE-USAGE.md`).

Configuration: add an MCP tool to the agent with the C4C endpoint as the server URL, and store the bearer token in a project connection (key-based, header `Authorization`, value `Bearer <token>`). Tool calls that do not stream time out after 100 seconds.

Sources: https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/model-context-protocol, template `19-private-network-agent-tools` in https://github.com/microsoft-foundry/foundry-samples

## Microsoft Copilot Studio

**Reach:** Copilot Studio runs in Microsoft's cloud. Its virtual network support covers HTTP request nodes and certain connectors, and Microsoft does not document a private path for MCP servers. Plan on a public HTTPS endpoint (TLS proxy, `C4C_AUTH_TOKEN` set). Your Power Platform data policies apply to MCP tools.

Configuration: in your agent, Tools, Add a tool, Model Context Protocol. Server URL: your public endpoint. Authentication: API key, type Header, header name `Authorization`, and value `Bearer <token>`. Copilot Studio supports streamable HTTP only, which is what C4C serves.

Sources: https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent, https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-network-isolation-vnet

## ChatGPT (apps and developer mode connectors)

**Reach:** ChatGPT calls MCP servers from OpenAI's infrastructure, so it needs a public HTTPS endpoint. OpenAI publishes its egress ranges at https://openai.com/chatgpt-connectors.json.

**Auth caveat:** OpenAI's documentation supports OAuth or no authentication, and says ChatGPT cannot present custom API keys. A static bearer token (`C4C_AUTH_TOKEN`) is therefore not something you can enter in ChatGPT. Options: put an OAuth-capable gateway in front of C4C, or restrict the public endpoint to OpenAI's IP ranges and run that endpoint with no token. Discuss either with your security team before exposing it. Your workspace admin controls whether custom connectors are allowed.

Sources: https://developers.openai.com/apps-sdk/build/auth, https://developers.openai.com/api/docs/guides/ip-addresses

## Python (official MCP SDK)

Version 2 of the `mcp` package (2.3.0 at the time of writing) takes headers on the HTTP client, not on the transport:

```python
# pip install "mcp>=2"
import asyncio, os
import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

URL = "https://c4c.example.internal/mcp"

async def main():
    async with httpx2.AsyncClient(
        headers={"Authorization": f"Bearer {os.environ['C4C_TOKEN']}"},
        timeout=httpx2.Timeout(30.0, read=300.0),
    ) as http_client:
        transport = streamable_http_client(URL, http_client=http_client)
        async with Client(transport) as client:          # runs initialize
            tools = await client.list_tools()
            print([t.name for t in tools.tools])
            result = await client.call_tool("lookup_citation", {"citation": "12 CFR 1026.43"})
            print(result.content[0].text[:500])

asyncio.run(main())
```

Passing `headers=` to `streamable_http_client()` raises a `TypeError` in version 2. On the older 1.x line, use `streamable_http_client(URL, http_client=httpx.AsyncClient(headers=...))` with `ClientSession(read, write)` and `await session.initialize()`.

Source: https://py.sdk.modelcontextprotocol.io/client/transports/

## curl

```
curl -sS https://c4c.example.internal/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $C4C_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"lookup_citation","arguments":{"citation":"12 CFR 1026.43"}}}'
```

The answer is one JSON-RPC message, possibly as an SSE `data:` line. The tool output is JSON inside `result.content[0].text`. Use `"method":"tools/list","params":{}` to list the tools.

## Tools

Core tools every install serves: `search_regs`, `lookup_citation`, `get_obligation`, `find_in_section`, `verify_quote`, `get_reg`, `list_playbooks`, `start_playbook` (plus `get_playbook_reference` and `get_playbook_kit`). With `C4C_WORKSPACE=1` the server also serves `record_rules`, `propose_file_note` and `tag_record`. Tool calls take search terms, citations and ids, never documents.

Give your agent the system prompt in `AGENT-INSTRUCTIONS.md` so it quotes and cites correctly.

## Where questions and answers go

The C4C server never sends questions, documents or answers anywhere (see `DATA-FLOW.md`). What leaves your network depends on the client:

- Claude Code, Claude Desktop with `mcp-remote`, your own agents, AgentCore in VPC mode, Bedrock Agents with a VPC Lambda and Foundry with private networking call C4C over your network. The model provider still receives the prompts and the C4C text placed in them: Anthropic, or AWS Bedrock or Microsoft Foundry in your own cloud account, under that provider's terms. Only a self-hosted model keeps everything inside.
- Cloud connectors (Claude custom connectors, Copilot Studio, ChatGPT) reach C4C through your public endpoint. The search terms they send and the regulation text C4C returns pass through that vendor, along with everything else typed into that assistant.

## Check the install first

From a machine that can reach the endpoint:

```
export C4C_AUTH_TOKEN='<token>'
bash scripts/verify-install.sh https://c4c.example.internal/mcp
```

Windows PowerShell:

```
$env:C4C_AUTH_TOKEN = '<token>'
.\scripts\verify-install.ps1 -Url https://c4c.example.internal/mcp
```

Or inside the container (the token is already in its environment):

```
docker exec c4c-mcp node server/verify-install.mjs --url http://127.0.0.1:8080/mcp
```

Each checks `/healthz`, `initialize`, `tools/list` and a `lookup_citation` call, confirms a request without the token is refused, and prints PASS or FAIL. The token is read only from `C4C_AUTH_TOKEN`, never from the command line, and is never printed.

## Support

earl@cfsynergies.com
