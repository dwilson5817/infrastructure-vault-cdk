# Vault

![Pipeline status badge](https://gitlab.dylanw.dev/infrastructure/vault/badges/main/pipeline.svg)

A CDK application which creates the infrastructure to deploy a very simple installation of HashiCorp Vault to AWS.

This project creates the following resources:

- An EC2 instance to run Vault on
- A DynamoDB table for data storage
- A KMS key, with Vault is configured to use [auto-unseal with KMS](https://developer.hashicorp.com/vault/tutorials/auto-unseal/autounseal-aws-kms)

The EC2 instance is configured with Ansible, they configured a TLS certificate from Let's Encrypt, with NGINX is used as a reverse proxy.  The Ansible playbooks are stored in `ansible/` and are run automatically using AWS Systems Manager State Manager every day.

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
