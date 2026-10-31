# Vault CDK

![Pipeline status badge](https://gitlab.dylanw.dev/infrastructure/vault-cdk/badges/main/pipeline.svg)

A CDK application that creates the infrastructure to deploy a very simple installation of HashiCorp Vault to AWS.

This project creates the following resources:

- An EC2 instance to run Vault on
- A DynamoDB table for data storage
- A KMS key, with Vault is configured to use [auto-unseal with KMS](https://developer.hashicorp.com/vault/tutorials/auto-unseal/autounseal-aws-kms)

The EC2 instance is configured with Ansible, and Vault is made reachable through a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), with TLS terminated by Cloudflare.  The Ansible playbooks are stored in `ansible/` and are run automatically using AWS Systems Manager State Manager every day.

To avoid paying for a public IPv4 address, the EC2 instance runs in a dual-stack VPC with no public IPv4 address, so it can only reach the internet over IPv6.  AWS services are reached using their dual-stack endpoints, or for S3 and DynamoDB, through gateway VPC endpoints.  Cloudflare makes Vault reachable over both IPv4 and IPv6.

The cloudflared release binary is downloaded from GitHub when the Ansible asset is built (by `ansible/bundle.yml`, using the version and checksums in the role defaults), since GitHub is not reachable over IPv6.

### Prerequisites

The following SSM parameters must exist in the account and region before deploying:

| Parameter                              | Type         | Required |
|----------------------------------------|--------------|----------|
| `/vault/cloudflare-tunnel-credentials` | SecureString | Yes      |

SecureString parameters must use the default `aws/ssm` KMS key.

The tunnel is locally managed, and its ingress rule routes `vault.dylanw.net` to Vault.  Create it with `cloudflared tunnel create`, store the credentials JSON it writes in `/vault/cloudflare-tunnel-credentials`, and route the hostname to it with `cloudflared tunnel route dns` (or a proxied CNAME to `<tunnel-id>.cfargotunnel.com`).  The DNS record is not managed by this project.

Using DynamoDB for data storage allows for EC2 instances to be replaced without data loss but since there is only EC2 instance and no load balancer deployments will cause downtime if the EC2 instance is replaced.

### License

Licensed under the GNU General Public License v3.0.

```
Vault CDK - Deploy HashiCorp Vault to AWS
Copyright (C) 2024 Dylan Wilson

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
```

Full license available [here](https://gitlab.dylanw.dev/infrastructure/vault/-/raw/main/LICENSE).
