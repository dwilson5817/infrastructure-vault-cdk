import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export class InfrastructureVaultStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const defaultVpc = ec2.Vpc.fromLookup(this, 'VPC', { isDefault: true })

    const securityGroup = new ec2.SecurityGroup(
        this,
        'vault-instance-1-security-group',
        {
          vpc: defaultVpc,
          allowAllOutbound: true,
          securityGroupName: 'vault-instance-1-security-group',
        }
    )

    securityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(22),
        'Allows SSH access from Internet'
    )

    securityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(443),
        'Allows HTTPS access from Internet'
    )

    const instance = new ec2.Instance(this, 'vault-instance-1', {
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
      partitionKey: { name: 'Key', type: dynamodb.AttributeType.STRING },
    })

    table.grantFullAccess(instance)
  }
}
