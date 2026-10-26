# C4C regulatory MCP server on AWS: usage instructions

Research use only. C4C returns regulatory text and citations; it is not legal advice.

The container is an MCP server (streamable HTTP on port 8080, path `/mcp`) that serves U.S. mortgage regulations and agency guides from a signed library stored in `/data`. It runs as a non-root user with a read-only root filesystem and needs no AWS credentials or IAM permissions of its own.

## External services

None required. The container never sends questions, documents, answers or telemetry anywhere, and it can run with no connection outside your AWS account. Library updates are signed; the container refuses any library whose signature does not verify, however it arrives. Choose how updates reach it:

- **Your own mirror in your account (recommended for regulated environments).** The container reads updates from an S3 bucket (or any HTTPS server) you control and never contacts us. See "Updates from your own S3 bucket" below.
- **Direct from the C4C feed.** The container makes HTTPS GET requests (port 443) to `https://mcp.claudeforcompliance.com/library`, sending only your free license key.
- **Offline.** Load signed library files by hand (see the full install guide).

## 1. Get your free license key (automated, no approval)

Sign up at `https://mcp-auth.claudeforcompliance.com/self-hosted` with a work email. Confirm the email and the key is shown once. There is no charge and no seller approval step. Signing up again with the same email replaces the key.

## 2. Store your secrets

Choose a long random bearer token; every client must send it as `Authorization: Bearer <token>`. The license key secret is needed only if the container fetches updates directly from the C4C feed; with your own mirror, remove the `C4C_LICENSE_KEY` entry from the task definition (or leave the `license-key` value out of the Kubernetes secret).

Amazon ECS: create two AWS Secrets Manager secrets, `c4c/license-key` and `c4c/auth-token`, and give the task execution role `secretsmanager:GetSecretValue` on them.

Amazon EKS: `kubectl create secret generic c4c-mcp --from-literal=license-key=<key> --from-literal=auth-token=<token>`

## 3a. Deploy on Amazon ECS (Fargate)

1. Download the task definition template `ecs-task-definition.json` from the Deployment resources link.
2. Replace `<ACCOUNT_ID>` and `<REGION>` with yours (the image URI is already filled in). For Graviton, set `cpuArchitecture` to `ARM64` (the image supports both).
3. Register it: `aws ecs register-task-definition --cli-input-json file://ecs-task-definition.json`
4. Create a service in private subnets and allow inbound TCP 8080 only from your AI tools or an internal load balancer. Outbound HTTPS (NAT gateway or proxy) is needed only if the container uses the C4C feed directly; with your own S3 mirror, the S3 gateway endpoint is enough.

## 3b. Deploy on Amazon EKS (Helm)

```
aws ecr get-login-password --region us-east-1 | helm registry login --username AWS --password-stdin 709825985650.dkr.ecr.us-east-1.amazonaws.com
helm install c4c-mcp oci://709825985650.dkr.ecr.us-east-1.amazonaws.com/cf-synergies/c4c-mcp-helm --version 1.0.2
```

The chart runs one replica as UID 1000 with a read-only root filesystem, all capabilities dropped and no service-account token. Set `persistence.enabled=true` to keep the library on a volume across restarts; otherwise it re-downloads in seconds.

## Updates from your own S3 bucket

1. **Fill the bucket from a gate you choose** (a scheduled ECS task, CodeBuild job or EC2 instance allowed to reach the internet), using the mirror tool in this same image with your license key:

   ```
   docker run --rm -e C4C_LICENSE_KEY=<key> -v /srv/c4c-mirror:/mirror <image> node --no-warnings server/mirror-library.mjs --out /mirror
   aws s3 sync /srv/c4c-mirror s3://<bucket>/c4c --exclude "manifest.*"
   aws s3 cp /srv/c4c-mirror/manifest.sig s3://<bucket>/c4c/manifest.sig
   aws s3 cp /srv/c4c-mirror/manifest.json s3://<bucket>/c4c/manifest.json
   ```

   The tool verifies the signature and checksum before writing anything. Copy the manifest last, as shown, so the container never sees a manifest before its library file.
2. **Let the container read the bucket without credentials or internet access:** add an S3 gateway endpoint to its VPC and a bucket policy allowing `s3:GetObject` on `<bucket>/c4c/*` only when `aws:SourceVpce` is that endpoint.
3. **Point the container at it:** set `C4C_UPDATE_URL` to `https://<bucket>.s3.<region>.amazonaws.com/c4c` (Helm: `config.updateUrl`). With that URL the container sends no license key and never contacts C4C; it checks the bucket every `C4C_UPDATE_INTERVAL_H` hours and verifies the signature again before installing.

## 4. Check it

`/healthz` returns `200 {"ok":true,"library_version":"...","stale":false}` once the first library is installed, normally within a minute of start. Until then it returns 503 `no_library`.

## 5. Connect your AI tools

Point any MCP client (Amazon Bedrock AgentCore Gateway, an internal agent, Claude, ChatGPT or Copilot) at `http://<host>:8080/mcp` with the bearer token. Put a TLS load balancer or reverse proxy in front for traffic that leaves a trusted network. Every answer carries the library version and age.

## Resources

- Memory: about 400 MiB under load (1 GiB recommended). Disk: about 350 MB in `/data`.
- Full install guide, data-flow statement and source: https://github.com/earl-hash/c4c-mcp-server
- Support: earl@cfsynergies.com
