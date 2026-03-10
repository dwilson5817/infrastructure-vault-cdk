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
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export class InfrastructureVaultStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vaultInstanceRole = new iam.Role(this, 'VaultInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });

    vaultInstanceRole.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
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

    const instance = new ec2.Instance(this, 'VaultServerInstance', {
      vpc: defaultVpc,
      securityGroup: securityGroup,
      role: vaultInstanceRole,
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
      lifecycleRules: [
        { expiration: cdk.Duration.days(90) }
      ]
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
            `vault_storage_dynamodb_table_name=${ table.tableName } ` +
            `cloudflare_token_secret_name=${ cloudflareTokenSecret.secretName } `
        ],
      },
      scheduleExpression: 'rate(1 day)'
    });

    const runCommandFailureAlarm = new cloudwatch.Alarm(this, 'RunCommandFailureAlarm', {
      alarmDescription: 'Triggers when the Vault SSM RunCommand execution fails',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SSM-RunCommand',
        metricName: 'CommandsFailed',
        dimensionsMap: {
          DocumentName: 'AWS-ApplyAnsiblePlaybooks',
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    runCommandFailureAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(runCommandFailureTopic)
    );
  }
}
