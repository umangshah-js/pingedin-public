import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';

export class PingedInCleanupStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const roleName = 'linkedin-guest-check-role';
    const functionName = 'linkedin-guest-check';
    const policyArn = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';

    const roleArn = cdk.Arn.format(
      {
        service: 'iam',
        region: '',
        resource: 'role',
        resourceName: roleName
      },
      this
    );

    const lambdaArn = cdk.Arn.format(
      {
        service: 'lambda',
        resource: 'function',
        resourceName: functionName
      },
      this
    );

    const logGroupArn = cdk.Arn.format(
      {
        service: 'logs',
        resource: 'log-group',
        resourceName: `/aws/lambda/${functionName}`
      },
      this
    );

    const deleteLambda = new cr.AwsCustomResource(this, 'DeleteTestLambda', {
      onCreate: {
        service: 'Lambda',
        action: 'deleteFunction',
        parameters: { FunctionName: functionName },
        physicalResourceId: cr.PhysicalResourceId.of('DeleteTestLambda')
      },
      onDelete: {
        service: 'Lambda',
        action: 'deleteFunction',
        parameters: { FunctionName: functionName }
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:DeleteFunction'],
          resources: [lambdaArn]
        })
      ]),
      installLatestAwsSdk: false,
      ignoreErrorCodesMatching: 'ResourceNotFoundException'
    });

    const deleteLogGroup = new cr.AwsCustomResource(this, 'DeleteTestLogGroup', {
      onCreate: {
        service: 'CloudWatchLogs',
        action: 'deleteLogGroup',
        parameters: { logGroupName: `/aws/lambda/${functionName}` },
        physicalResourceId: cr.PhysicalResourceId.of('DeleteTestLogGroup')
      },
      onDelete: {
        service: 'CloudWatchLogs',
        action: 'deleteLogGroup',
        parameters: { logGroupName: `/aws/lambda/${functionName}` }
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['logs:DeleteLogGroup'],
          resources: [logGroupArn]
        })
      ]),
      installLatestAwsSdk: false,
      ignoreErrorCodesMatching: 'ResourceNotFoundException'
    });

    const detachPolicy = new cr.AwsCustomResource(this, 'DetachTestRolePolicy', {
      onCreate: {
        service: 'IAM',
        action: 'detachRolePolicy',
        parameters: { RoleName: roleName, PolicyArn: policyArn },
        physicalResourceId: cr.PhysicalResourceId.of('DetachTestRolePolicy')
      },
      onDelete: {
        service: 'IAM',
        action: 'detachRolePolicy',
        parameters: { RoleName: roleName, PolicyArn: policyArn }
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['iam:DetachRolePolicy'],
          resources: [roleArn]
        })
      ]),
      installLatestAwsSdk: false,
      ignoreErrorCodesMatching: 'NoSuchEntity'
    });

    const deleteRole = new cr.AwsCustomResource(this, 'DeleteTestRole', {
      onCreate: {
        service: 'IAM',
        action: 'deleteRole',
        parameters: { RoleName: roleName },
        physicalResourceId: cr.PhysicalResourceId.of('DeleteTestRole')
      },
      onDelete: {
        service: 'IAM',
        action: 'deleteRole',
        parameters: { RoleName: roleName }
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['iam:DeleteRole'],
          resources: [roleArn]
        })
      ]),
      installLatestAwsSdk: false,
      ignoreErrorCodesMatching: 'NoSuchEntity'
    });

    deleteRole.node.addDependency(detachPolicy);
    deleteRole.node.addDependency(deleteLambda);
    deleteRole.node.addDependency(deleteLogGroup);
  }
}
