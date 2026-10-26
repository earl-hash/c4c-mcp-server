# C4C self-hosted: data flow

Research only. C4C returns regulatory text and citations. It is not legal advice.

In short: the C4C server never sends questions, documents or answers anywhere, and it can run with no connection to C4C at all. Rule updates can come to it through your own gates: an internal mirror your IT fills (see "Updates through your own gates" in `INSTALL.md`), or files you load by hand. The only optional connection to C4C is a GET that downloads signed library updates, carrying your license key.

Whether your questions and answers stay inside your network depends on the AI tool you connect, not on C4C:

- An in-network agent, or an agent driving a self-hosted model, keeps everything inside your network.
- Cloud assistants (ChatGPT connectors, Claude connectors, Copilot Studio) connect to C4C from the vendor's cloud. They need an internet-reachable HTTPS endpoint (your TLS reverse proxy in front of the container, with `C4C_AUTH_TOKEN` set). The questions those assistants send to C4C and the answers C4C returns pass through that vendor under its terms, along with everything else you type into that assistant.

## Diagram

The diagram shows an AI tool inside your network. A cloud assistant reaches the same container from the internet, through your TLS reverse proxy.

```
  Your AI tools                 Your network                         Internet
  (Claude, ChatGPT,        +----------------------------+
   Copilot, agents)  ----> | C4C server (container)     |
   question + citation     |  reads library from /data  | --GET--> your mirror, or the C4C feed
   <---- regulation text   |  (read-only SQLite file)   | <--- signed library --- (optional)
                           |  /data/usage-YYYY-MM.json  |
                           |  (optional, stays here)    |
                           +----------------------------+
```

## What goes where

| Data | Where it goes | Leaves your network? |
|---|---|---|
| Documents you work on | Stay in your AI tool. C4C tools take only search terms and citations. | Not through C4C. Your AI tool's vendor sees whatever you give that tool. |
| Prompts and questions to your AI tool | Stay with your AI tool. | Not through C4C. With a cloud assistant they go to that vendor. |
| Search terms and citations your AI tool sends to C4C | Handled in memory by the container on your host. Not written to the library or the usage report. The container's console log records startup and update messages and, if a request fails internally, an error message with its stack trace; it does not log request bodies or answers on purpose, but an internal error message logged to the console may quote part of the request that caused it. If you turn on the optional audit log, it records them as described below. | Not sent by C4C. With a cloud assistant, they arrive from and return through that vendor's cloud. |
| Answers (regulation text, citations, library version and age) | Returned to your AI tool. | Not sent anywhere else by C4C. With a cloud assistant, they return through that vendor's cloud. |
| Library updates | Downloaded by the container from the update URL: your internal mirror, or the C4C feed. | Inbound only. With a mirror, the container never leaves your network. |
| License key | Not needed on the server when it updates from your mirror. With the C4C feed, sent as part of the GET. | Only when the server uses the C4C feed directly; this is the only thing C4C itself sends out |
| Optional audit log (off by default) | With `C4C_AUDIT_LOG=stdout`, your console log (your collector, e.g. CloudWatch); with `file`, `/data/audit/` on your disk. One line per tool call: tool, the search terms or citations sent, citations and section ids returned, library version, outcome, client, caller address, and a user identity if your gateway supplies one. No regulation text, no bearer token. | No. C4C never sends it. |
| Optional usage report | Written to `/data/usage-YYYY-MM.json` on your disk: counts per day, by tool name and document name; no query text, no user info. | No, unless you choose to send the file to us |

## Update calls, and how to keep them inside your network

The server makes GET requests to `C4C_UPDATE_URL` to ask whether a newer library exists and to download it. Nothing is posted, no telemetry is sent, no questions, documents or answers are sent, and the server does not call any other host. Three setups:

- **Your mirror (no connection to C4C).** `C4C_UPDATE_URL` points at a server inside your network that your IT fills with `mirror-library.mjs` from a gate host (or by hand). The C4C server sends no license key and never contacts C4C.
- **The C4C feed.** With `C4C_LICENSE_KEY` set and the default `C4C_UPDATE_URL` (`https://mcp.claudeforcompliance.com/library`), the server fetches directly from C4C, through your proxy if you set one.
- **Offline.** No license key and no mirror: the server makes no outbound calls at all, and you load updates as files.

Each download is signed. The image carries our public key and rejects any library whose signature or checksum does not match, so a tampered download cannot be installed.

## The library contains no customer data

The library file we ship is the public regulation text and our index of it. Usage data of any kind is removed before packaging. The file is opened read-only in your container, and the server never writes your activity to it.

## Questions

earl@cfsynergies.com
