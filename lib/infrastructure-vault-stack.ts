import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deployment from 'aws-cdk-lib/aws-s3-deployment';

export class InfrastructureVaultStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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
      instanceName: 'vault-instance-1',
      instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.T2,
          ec2.InstanceSize.MICRO
      ),
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023
      }),
    })

    const table = new dynamodb.TableV2(this, 'VaultStorage', {
      partitionKey: { name: 'Path', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'Key', type: dynamodb.AttributeType.STRING },
    })

    table.grantFullAccess(instance)

    const ansibleConfigurationBucket = new s3.Bucket(this, 'AnsibleConfigurationBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new s3deployment.BucketDeployment(this, 'DeployFiles', {
      sources: [
          s3deployment.Source.asset('./ansible')
      ],
      destinationBucket: ansibleConfigurationBucket,
    });

    new ssm.CfnAssociation(this, 'ConfigureVaultAssociation', {
      name: 'AWS-ApplyAnsiblePlaybooks',
      instanceId: instance.instanceId,
      parameters: {
        SourceType: "S3",
        SourceInfo: [
            `{ "path": "${ ansibleConfigurationBucket.bucketDomainName }" }`
        ],
        InstallDependencies: true,
        PlaybookFile: "playbook.yml",
        ExtraVariables: `vault_storage_dynamodb_table_name=${ table.tableName }`,
      }
    });
  }
}
