import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';

export class PingedInStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'LinkedInJobsTable', {
      tableName: 'linkedin_jobs',
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    const pushoverAppToken = new secretsmanager.Secret(this, 'PushoverAppToken', {
      secretName: 'pinged-in/pushover-app-token',
      secretStringValue: cdk.SecretValue.unsafePlainText(
        this.node.tryGetContext('pushoverAppToken') ?? 'REPLACE_ME'
      )
    });

    const jobChecker = new lambda.Function(this, 'LinkedInJobChecker', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'lambda_function.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'src')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        DYNAMODB_TABLE: table.tableName,
        LINKEDIN_KEYWORDS: 'Data Engineer',
        LINKEDIN_LOCATION: 'New York',
        LINKEDIN_TPR: 'r86400',
        MAX_TPR_SECONDS: '86400',
        FORCE_TPR: '',
        REQUEST_DELAY_SECONDS: '0.6',
        ROLE_KEYWORDS: 'Data Engineer',
        PUSHOVER_USER_KEY: 'u4km6osr7t6w37h9pc4ncbd5o9yabo',
        PUSHOVER_APP_TOKEN_SECRET_ARN: pushoverAppToken.secretArn,
        DEBUG_HTML: 'false'
      }
    });

    table.grantReadWriteData(jobChecker);
    pushoverAppToken.grantRead(jobChecker);

    const schedulerRole = new iam.Role(this, 'SchedulerInvokeRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com')
    });
    schedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [jobChecker.functionArn]
    }));

    new scheduler.CfnSchedule(this, 'ScheduleEvery30', {
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: 'cron(0/30 8-22 ? * * *)',
      scheduleExpressionTimezone: 'America/New_York',
      target: {
        arn: jobChecker.functionArn,
        roleArn: schedulerRole.roleArn
      }
    });
  }
}
