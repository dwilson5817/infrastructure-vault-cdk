import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3asset from 'aws-cdk-lib/aws-s3-assets';

export class InfrastructureVaultStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vaultInstanceRole = new iam.Role(this, 'VaultInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });

    vaultInstanceRole.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    );

    // Allow the EC2 instance to assume the VaultVerificationRole in other AWS accounts
    vaultInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [
        'arn:aws:iam::581807542937:role/InfrastructureBackupsCdkS-VaultVerificationRole6E52-UMM4dkV20joI',
        'arn:aws:iam::303040220222:role/DmarcAnalyserCdkStack-VaultVerificationRole6E5252AC-xg8IYCfTlDCK'
      ],
    }))

    // Vault configuration and secrets (such as the Cloudflare Tunnel credentials) are created out-of-band (see
    // README.md). SecureStrings use the AWS managed aws/ssm key, whose key policy already allows decryption via SSM,
    // so no KMS permissions are needed.
    vaultInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:GetParametersByPath',
      ],
      resources: [
        this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: 'vault' }),
        this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: 'vault/*' }),
      ],
    }));

    // Dual-stack VPC with no NAT gateway: the instance gets a private IPv4 address (free) and a public IPv6
    // address, so it has no public IPv4 address to pay for and can only reach the internet over IPv6
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipProtocol: ec2.IpProtocol.DUAL_STACK,
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{
        name: 'Public',
        subnetType: ec2.SubnetType.PUBLIC,
        mapPublicIpOnLaunch: false,
      }],
      // Gateway endpoints are free and give IPv4 access to S3 and DynamoDB
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
        DynamoDB: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB },
      },
    });

    // Vault is only reachable through the Cloudflare Tunnel, which only makes outbound connections
    const securityGroup = new ec2.SecurityGroup(
        this,
        'VaultServerSecurityGroup',
        {
          vpc,
          allowAllOutbound: true,
          allowAllIpv6Outbound: true,
        }
    )

    // Shared by the instance and the Ansible asset, which bundles binaries for this architecture
    const instanceType = ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO
    );

    // Make the SSM Agent use dual-stack endpoints, so it can reach Systems Manager over IPv6 (they also work over
    // IPv4). Without this it only uses the IPv4-only endpoints. This must be set before the agent starts, since Ansible
    // itself is run through the agent, so it is done in a cloud-init bootcmd, which runs on every boot before the
    // network is online (the agent starts after network-online.target). The config file does not exist by default,
    // so it is created from the template shipped with the agent if needed. Needs SSM Agent 3.3.3270.0 or later.
    const ssmAgentConfigPath = '/etc/amazon/ssm/amazon-ssm-agent.json';
    const enableSsmAgentDualStack = [
      'import json, os',
      `path = "${ssmAgentConfigPath}"`,
      'config = json.load(open(path if os.path.exists(path) else path + ".template"))',
      'config.setdefault("Agent", {})["UseDualStackEndpoint"] = True',
      'json.dump(config, open(path, "w"), indent=2)',
    ].join('; ');

    const userData = new ec2.MultipartUserData();
    userData.addPart(ec2.MultipartBody.fromRawBody({
      contentType: 'text/cloud-config; charset="utf-8"',
      body: [
        '#cloud-config',
        'bootcmd:',
        `  - [python3, -c, '${enableSsmAgentDualStack}']`,
      ].join('\n'),
    }));

    const instance = new ec2.Instance(this, 'VaultServerInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: securityGroup,
      role: vaultInstanceRole,
      userData,
      ipv6AddressCount: 1,
      instanceType,
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
        cpuType: ec2.AmazonLinuxCpuType.ARM_64
      }),
    })

    cdk.Tags.of(instance).add('Role', 'VaultServer');

    const ansibleExecutionLogsBucket = new s3.Bucket(this, 'AnsibleExecutionLogsBucket', {
      lifecycleRules: [
        { expiration: cdk.Duration.days(90) }
      ]
    });

    ansibleExecutionLogsBucket.grantPut(vaultInstanceRole)

    // The release binaries are downloaded by ansible/bundle.yml, because GitHub is not reachable from the instance over
    // IPv6. The bundling options (including the architecture) are part of the asset hash, so changing the instance
    // architecture rebuilds the asset.
    const asset = new s3asset.Asset(this, 'BundledAsset', {
      path: './ansible',
      bundling: {
        image: cdk.DockerImage.fromRegistry('python:3.14-trixie'),
        environment: {
          BUNDLE_ARCH: instanceType.architecture,
          BUNDLE_BINARIES_PATH: '/asset-output/binaries',
        },
        command: [
          'bash',
          '-lc',
          [
            'pip install --no-cache-dir -r /asset-input/requirements.txt',
            'cp -r /asset-input/. /asset-output',
            'ansible-galaxy collection install --force -r /asset-output/requirements.yml -p /asset-output/collections',
            'ansible-playbook -i localhost, /asset-input/bundle.yml',
          ].join(' && '),
        ],
      },
    });

    asset.bucket.grantRead(vaultInstanceRole)

    const table = new dynamodb.TableV2(this, 'VaultStorage', {
      partitionKey: { name: 'Path', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'Key', type: dynamodb.AttributeType.STRING },
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    })

    table.grantFullAccess(vaultInstanceRole)

    const vaultUnsealKey = new kms.Key(this, 'VaultUnsealKey', {
      alias: 'vault-unseal-key'
    });

    vaultUnsealKey.grant(instance, 'kms:DescribeKey');
    vaultUnsealKey.grantEncryptDecrypt(instance);

    const runCommandFailureTopic = new sns.Topic(this, 'RunCommandFailureTopic', {
      displayName: 'SSM RunCommand Failure Notifications',
    });

    runCommandFailureTopic.addSubscription(
      new subscriptions.EmailSubscription(process.env.SNS_RUN_COMMAND_FAILURE_TOPIC_NOTIFICATION_EMAIL!)
    );

    new ssm.CfnAssociation(this, 'ConfigureVaultAssociation', {
      name: 'AWS-ApplyAnsiblePlaybooks',
      targets: [{
        key: 'tag:Role',
        values: [
            'VaultServer'
        ],
      }],
      outputLocation: {
        s3Location: {
          outputS3BucketName: ansibleExecutionLogsBucket.bucketName,
        },
      },
      parameters: {
        SourceType: [
            "S3"
        ],
        SourceInfo: [
            `{ "path": "${ asset.httpUrl }" }`
        ],
        InstallDependencies: [
            "True"
        ],
        PlaybookFile: [
            "playbook.yml"
        ],
        ExtraVariables: [
            `vault_storage_dynamodb_table_name=${ table.tableName }`
        ],
      },
      scheduleExpression: 'rate(1 day)'
    });

    const runCommandFailureAlarm = new cloudwatch.Alarm(this, 'RunCommandFailureAlarm', {
      alarmDescription: 'Triggers when the Vault SSM RunCommand execution fails',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SSM-RunCommand',
        metricName: 'CommandsFailed',
        statistic: 'Sum',
        period: cdk.Duration.hours(24),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    runCommandFailureAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(runCommandFailureTopic)
    );
  }
}
