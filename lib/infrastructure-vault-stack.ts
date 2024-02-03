import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3asset from 'aws-cdk-lib/aws-s3-assets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export class InfrastructureVaultStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vaultInstanceRole = new iam.Role(this, 'VaultInstanceRole', {
      assumedBy: new iam.CompositePrincipal(
          new iam.ServicePrincipal('ec2.amazonaws.com'),
          new iam.ServicePrincipal('ssm.amazonaws.com'),
      ),
    });

    vaultInstanceRole.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedEC2InstanceDefaultPolicy')
    );

    const cloudflareTokenSecret = new secretsmanager.Secret(this, 'CloudFlareTokenSecret', {
      secretName: 'CloudFlareToken',
      secretStringValue: cdk.SecretValue.unsafePlainText(process.env.CLOUDFLARE_TOKEN!),
    });

    cloudflareTokenSecret.grantRead(vaultInstanceRole);

    const defaultVpc = ec2.Vpc.fromLookup(this, 'VPC', { isDefault: true })

    const securityGroup = new ec2.SecurityGroup(
        this,
        'VaultServerSecurityGroup',
        {
          vpc: defaultVpc,
          allowAllOutbound: true,
          securityGroupName: 'VaultServerSecurityGroup',
        }
    )

    securityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(443),
        'Allows HTTPS access from Internet'
    )

    const instance = new ec2.Instance(this, 'VaultServerInstance1', {
      vpc: defaultVpc,
      securityGroup: securityGroup,
      role: vaultInstanceRole,
      instanceName: 'vault-instance-1',
      instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.T2,
          ec2.InstanceSize.MICRO
      ),
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023
      }),
    })

    cdk.Tags.of(instance).add('Role', 'VaultServer');

    const ansibleExecutionLogsBucket = new s3.Bucket(this, 'AnsibleExecutionLogsBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    ansibleExecutionLogsBucket.grantPut(vaultInstanceRole)

    const asset = new s3asset.Asset(this, 'BundledAsset', {
      path: './ansible',
    });

    asset.bucket.grantRead(vaultInstanceRole)

    const table = new dynamodb.TableV2(this, 'VaultStorage', {
      partitionKey: { name: 'Path', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'Key', type: dynamodb.AttributeType.STRING },
    })

    table.grantFullAccess(vaultInstanceRole)

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
            `vault_storage_dynamodb_table_name=${ table.tableName } ` +
            `cloudflare_token_secret_name=${ cloudflareTokenSecret.secretName } ` +
            `current_region=${ cdk.Stack.of(this).region }`
        ],
      },
      scheduleExpression: 'rate(3 hours)'
    });
  }
}
