# C4C self-hosted: sizing and cost

Research only. C4C returns regulatory text and citations. It is not legal advice.

C4C is one small Node.js process reading a read-only SQLite file. It needs little CPU or memory. Most of the monthly cost is the platform around it (load balancer, NAT gateway, cluster), not the container.

## Resources

| Resource | Minimum | Recommended | Why |
|---|---|---|---|
| CPU | 0.25 vCPU | 0.5 vCPU | Queries take milliseconds. Decompressing a new library uses one core for a short while. |
| Memory | 512 MiB | 1 GiB | About 400 MiB under load. 1 GiB leaves room for a library swap, when the old and new files are both open for about a minute. |
| Disk (`/data`) | 1 GB | 5 GB | See below. |

`INSTALL.md` asks for a host with 2 GB of RAM. That covers the operating system and Docker as well as the container. The container itself needs 1 GiB. The Azure Container Apps template uses 1 vCPU and 2 GiB, which is more than needed; 0.5 vCPU and 1 GiB is enough if your platform allows it.

### Why the disk numbers differ

The AWS usage page says about 350 MB in `/data`. `INSTALL.md` says 5 GB. Both are right; they measure different things.

- **Steady state, about 350 MB.** One library version is about 170 MB uncompressed. The server keeps the current version and the previous one (the rollback copy), so about 350 MB.
- **During an update, more for a short time.** While a new version installs, `/data` holds the current file, the previous file, the compressed download, and the new file being written. Peak use is roughly three versions plus the download, around 600 MB today. The older files are deleted once the new one is committed.
- **Room to grow.** The library grows as regulations and guides are added. The server accepts a library of up to 2 GiB uncompressed. A 5 GB volume covers today's peak many times over, leaves room for growth, and holds the optional usage reports.

On AWS Fargate the task definition asks for 21 GiB of ephemeral storage (20 GiB is the minimum Fargate offers), so disk is never the limit there. Ephemeral storage is lost when a task stops; a new task downloads the library again, normally in under a minute. On Kubernetes, use `persistence.enabled=true` with a 5 GiB volume to keep the library across pod restarts.

## Concurrency

- The server is stateless. Each MCP request is answered on its own, with no session kept between requests.
- Queries run on a single Node.js thread against SQLite. Most tool calls are short lookups, and they are answered one after another on that thread. For a compliance team, a single replica is plenty: an AI agent waits far longer for its model than for C4C.
- To scale out or for availability, run more replicas behind a load balancer. Give each replica its own `/data`. Do not share one volume between replicas. Each replica fetches and verifies the library on its own, so for a few minutes after a release two replicas may serve different library versions. Every answer carries its `library` version, so this is visible.
- Request bodies are capped at 4 MiB.

## Monthly cost estimates

**These are estimates.** List prices fetched 2026-10-25 for AWS us-east-1 and Azure East US, on-demand, 730 hours a month, before tax, credits or discounts. Your prices depend on region, commitments and traffic. Data transfer within one availability zone or region is usually small for this workload and is not included.

### AWS ECS on Fargate, 0.5 vCPU / 1 GB, 24x7, internal ALB

| Item | Unit price | Monthly |
|---|---|---|
| Fargate x86 (0.5 vCPU, 1 GB) | $0.04048 per vCPU-hour, $0.004445 per GB-hour | about $18 |
| Fargate ARM / Graviton instead | $0.03238 per vCPU-hour, $0.00356 per GB-hour | about $14 |
| Ephemeral storage over 20 GB (1 GB) | $0.000111 per GB-hour | under $0.10 |
| Internal Application Load Balancer | $0.0225 per hour + $0.008 per LCU-hour | $16 to $23 |
| Secrets Manager (2 secrets) | $0.40 per secret | $0.80 |
| CloudWatch Logs | $0.50 per GB ingested (first 5 GB free) | $0 to $1 |
| **Total, updates from your S3 mirror** | | **about $32 to $42** |
| NAT gateway, only if the container uses the C4C feed directly | $0.045 per hour + $0.045 per GB, per AZ | add about $33 per AZ |

With your own S3 mirror, the S3 gateway endpoint is free and no NAT gateway is needed. If a NAT gateway already serves the subnet, it adds nothing new.

### AWS EKS, incremental pod only

- The chart's pod requests 250m CPU and 512 MiB. On existing nodes that is a share of a node you already pay for: roughly $4 to $9 a month at on-demand prices (for example 1/8 of an m6i.large's CPU, or 1/8 of a t3.medium). Often $0 in practice, until the pod causes the cluster to add a node.
- The EKS control plane ($0.10 per cluster-hour, about $73 a month) is not counted, since it is already paid for an existing cluster.
- Add an internal load balancer only if clients outside the cluster connect: about $16 to $23 a month for an ALB.

### Azure Container Apps, consumption, 0.5 vCPU / 1 GiB, minimum 1 replica

| Item | Unit price | Monthly |
|---|---|---|
| Active rate | $0.000024 per vCPU-second, $0.000003 per GiB-second | about $34 if always active |
| Idle rate (minimum replica, no requests) | $0.000003 per vCPU-second, $0.000003 per GiB-second | about $10 if always idle |
| Free grant per subscription per month | 180,000 vCPU-seconds, 360,000 GiB-seconds, 2 million requests | already subtracted above |
| Log Analytics | first 5 GB free, then $2.30 per GB | $0 to a few dollars |
| **Total** | | **about $10 to $35**, usually toward the low end for light use |

- A replica is billed at the idle rate only while it is handling no requests and using almost no CPU. Hours with traffic bill at the active rate.
- The template's 1 vCPU / 2 GiB size costs about $22 (idle) to $73 (active) a month.
- An internal Container Apps environment with only consumption apps has no environment fee. A $0.10 per hour fee (about $73 a month) applies if you add a dedicated workload profile or a private endpoint to the environment. The C4C template uses neither.

### A single small VM running Docker

| VM | Compute | Disk | Monthly |
|---|---|---|---|
| AWS EC2 t4g.small (2 vCPU, 2 GiB, ARM) | $0.0168 per hour | gp3 at $0.08 per GB-month, 8 to 20 GB | about $13 to $18 |
| AWS EC2 t3.small (2 vCPU, 2 GiB) | $0.0208 per hour | same | about $16 to $20 |
| Azure B1ms (1 vCPU, 2 GiB) | $0.0207 per hour | managed disk extra | about $15 plus disk |
| Azure B2s (2 vCPU, 4 GiB) | $0.0416 per hour | managed disk extra | about $30 plus disk |

A public IPv4 address on AWS adds $0.005 per hour (about $3.65 a month); an internal-only VM does not need one. A VM puts patching and Docker upkeep on your team, which the managed options avoid.

### Summary

| Option | Rough monthly cost |
|---|---|
| Pod on an existing EKS or AKS cluster | $0 to $9 |
| Small VM with Docker | $13 to $20 |
| Azure Container Apps, 0.5 vCPU / 1 GiB, mostly idle | $10 to $15 |
| ECS Fargate + internal ALB | $32 to $42 |
| Add a NAT gateway (AWS, feed direct) | + about $33 per AZ |

The C4C license itself is free.

### Price sources

- AWS Fargate: https://aws.amazon.com/fargate/pricing/
- Elastic Load Balancing: https://aws.amazon.com/elasticloadbalancing/pricing/
- NAT gateway and VPC endpoints: https://aws.amazon.com/vpc/pricing/
- Secrets Manager: https://aws.amazon.com/secrets-manager/pricing/
- CloudWatch: https://aws.amazon.com/cloudwatch/pricing/
- EKS: https://aws.amazon.com/eks/pricing/
- EBS: https://aws.amazon.com/ebs/pricing/
- EC2 on-demand: https://aws.amazon.com/ec2/pricing/on-demand/ (t3/t4g figures were read from third-party price trackers because the AWS table did not load; m6i.large is a last-known price)
- Azure Container Apps billing: https://learn.microsoft.com/en-us/azure/container-apps/billing
- Azure retail prices (Container Apps, Log Analytics, VMs): https://prices.azure.com/api/retail/prices

## Support

earl@cfsynergies.com
