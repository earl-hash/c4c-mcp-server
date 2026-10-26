# C4C self-hosted: upgrades

Research only. C4C returns regulatory text and citations. It is not legal advice.

## Two things update separately

| | Image | Library |
|---|---|---|
| What it is | The server software: Node.js, the MCP tools, the updater. | The regulation text and its index, one signed SQLite file. |
| Version looks like | `1.0.1` (the image tag) | `2026-10-09.1` (date plus build number) |
| How often | Occasionally: fixes, new tools, security patches. | As regulations and guides change, often weekly. |
| How it arrives | You pull or load a new image and redeploy. Nothing updates the image by itself. | Automatically from your mirror or the C4C feed, or by offline load. No redeploy. |
| Where it lives | Your registry or Docker host | The `/data` volume |

Upgrading the image keeps the library on the volume. Library updates never change the image.

## What is in a release

- **Image release:** the image tag, the release notes (what changed in the tools or server, any new environment variables), and the Helm chart or template version that references it. Images are built from the public source at https://github.com/earl-hash/c4c-mcp-server, so you can review the change and build the same image yourself. Produce an SBOM for each new image as in `INSTALL.md`.
- **Library release:** three files, `manifest.json`, `manifest.sig` and `<version>/corpus.sqlite.gz`. The manifest names the version and build date, and the signature covers it. The server checks the signature and the file checksum before installing, and accepts only a newer version.

## Upgrade the image

Before any upgrade, note what is running now (see "Check what is running" below) so you can go back to it.

### Docker

```
docker load -i c4c-mcp-<new-tag>.tar.gz      # or: docker pull <registry>/c4c-mcp:<new-tag>
docker stop c4c-mcp && docker rm c4c-mcp
docker run -d --name c4c-mcp ... c4c-mcp:<new-tag>   # same options as before, new tag
```

Use the same `docker run` options as in `INSTALL.md`, with the same `-v c4c-data:/data`. The new container serves the library already on the volume as soon as it starts.

To go back, stop and remove the new container and start the old tag again. Keep the old image until you are satisfied (`docker image ls c4c-mcp`).

### Amazon ECS

1. In `ecs-task-definition.json`, change the `image` to the new tag (or, better, the digest: `...c4c-mcp@sha256:<digest>`).
2. Register a new revision: `aws ecs register-task-definition --cli-input-json file://ecs-task-definition.json`
3. Point the service at it: `aws ecs update-service --cluster <cluster> --service c4c-mcp --task-definition c4c-mcp:<new-revision>`

ECS starts the new task, waits for its health check, then stops the old one. Because the task's `/data` is ephemeral, the new task downloads the library again from your mirror or the feed; it reports `no_library` (503) until that finishes, normally within a minute. The task definition's 300-second health check start period allows for this.

If you deployed with the C4C CloudFormation template (`aws/cloudformation/c4c-ecs-fargate.yaml`), update the stack and change only its `ImageUri` parameter, keeping every other value. The exact `update-stack` command is in "Update to a new version" in `aws/cloudformation/README.md`. With the CDK or Terraform, change the image there instead of editing the service by hand. To go back, update the stack again with the old `ImageUri`.

To go back: `aws ecs update-service ... --task-definition c4c-mcp:<old-revision>`.

### Amazon EKS and other Kubernetes (Helm)

```
helm upgrade c4c-mcp oci://709825985650.dkr.ecr.us-east-1.amazonaws.com/cf-synergies/c4c-mcp-helm \
  --version <new-chart-version> --reuse-values
```

`--reuse-values` keeps your settings (update URL, secret name, persistence). With `persistence.enabled=true` the new pod keeps the library; without it, the pod downloads it again on start.

To go back: `helm history c4c-mcp`, then `helm rollback c4c-mcp <revision>`.

### Azure Container Apps

```
az containerapp update --name c4c-mcp --resource-group <rg> --image <registry>/c4c-mcp:<new-tag>
```

This creates a new revision with the new image and keeps your secrets and settings. You can also redeploy the template with a new `image` parameter. To go back, activate the previous revision (`az containerapp revision list` and `az containerapp revision activate`) or run the same `update` with the old tag.

### Azure Kubernetes Service (cluster extension)

New versions of the C4C extension come through the Azure Marketplace offer. Update it in the portal (the cluster's Extensions page), or with:

```
az k8s-extension update --name <extension-name> --cluster-name <cluster> --resource-group <rg> \
  --cluster-type managedClusters --version <new-version>
```

If the extension was installed with automatic minor-version upgrades on, Azure applies new minor versions for you. Turn that off if your change process requires approving each version.

## Library updates

With your mirror or the C4C feed configured, the server checks every `C4C_UPDATE_INTERVAL_H` hours (default 24), verifies a new library, and swaps it in while requests keep running. Nothing needs restarting. See "Updates" and "Updates through your own gates" in `INSTALL.md`.

### Hold a library version

Some teams want to review a library before it serves answers, or freeze it during an exam or audit. Choose one:

- **Mirror (recommended).** Point `C4C_UPDATE_URL` at your mirror and simply do not refresh the mirror. The servers keep checking but find nothing newer. When you are ready, run `mirror-library.mjs` at your gate and the servers pick up the new version on their next check. This is also how you stage a library: fill a test mirror first, check a test server against it, then fill the production mirror.
- **Offline.** Leave `C4C_LICENSE_KEY` unset and use no mirror. The server makes no update calls and serves only what you load with `load-library.mjs` (see "Offline load" in `INSTALL.md`; restart after each load).
- **Pause on the feed.** Remove `C4C_LICENSE_KEY` and restart. The server stops checking. Add the key back to resume.

Whatever you choose, `/healthz` and every answer keep showing the library version and its age. After `C4C_STALE_DAYS` days without a newer library they report `stale`, so reviewers know the text may be out of date. Raise `C4C_STALE_DAYS` if you hold versions on purpose for longer.

### Roll back a library

See "Rollback" in `INSTALL.md`. The server keeps the previous version on the volume, and removing `manifest.json` makes it fall back to that copy on the next start. To install a specific older version, load its files with `load-library.mjs --allow-downgrade`. Hold the version as described above, or the server takes the newer one again on its next check.

## Check what is running

**Library version:**

```
curl http://<host>:8080/healthz
{"ok":true,"library_version":"2026-10-09.1","age_days":3,"stale":false}
```

Every tool answer also carries a `library` block with the version, build date and age.

**Image version and digest:**

```
docker inspect c4c-mcp --format '{{.Config.Image}}  {{.Image}}'
docker image inspect c4c-mcp:<tag> --format '{{json .RepoDigests}}'
```

- ECS: `aws ecs describe-tasks --cluster <cluster> --tasks <task-id> --query 'tasks[].containers[].[image,imageDigest]'`
- Kubernetes: `kubectl get pods -l app.kubernetes.io/name=c4c-mcp -o jsonpath='{.items[*].status.containerStatuses[*].imageID}'`
- Azure Container Apps: `az containerapp show --name c4c-mcp --resource-group <rg> --query properties.template.containers[0].image`

Compare the digest with the one in the release notes, or with the digest of an image you built yourself from the tagged source. Pin by digest in production so a re-pushed tag cannot change what you run.

**Full check after any upgrade:**

```
docker exec c4c-mcp node server/verify-install.mjs --url http://127.0.0.1:8080/mcp
```

or `scripts/verify-install.sh` / `scripts/verify-install.ps1` from a client machine (see `CONNECT.md`).

## Support

earl@cfsynergies.com
