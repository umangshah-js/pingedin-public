import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as path from 'path';

export class PingedInStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const portalPublicUrl = 'https://pingedin.umangshah.me';

    const table = new dynamodb.Table(this, 'LinkedInJobsTable', {
      tableName: 'linkedin_jobs',
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    const pushoverTokenCtx = this.node.tryGetContext('pushoverAppToken') as string | undefined;
    const pushoverAppToken = pushoverTokenCtx
      ? (() => {
          const s = new secretsmanager.Secret(this, 'PushoverAppToken', {
            secretName: 'pinged-in/pushover-app-token',
            secretStringValue: cdk.SecretValue.unsafePlainText(pushoverTokenCtx),
            removalPolicy: cdk.RemovalPolicy.RETAIN,
          });
          return s;
        })()
      : secretsmanager.Secret.fromSecretNameV2(this, 'PushoverAppToken', 'pinged-in/pushover-app-token');

    const geminiKeyCtx = this.node.tryGetContext('geminiApiKey') as string | undefined;
    const geminiApiKey = geminiKeyCtx
      ? (() => {
          const s = new secretsmanager.Secret(this, 'GeminiApiKey', {
            secretName: 'pinged-in/gemini-api-key',
            secretStringValue: cdk.SecretValue.unsafePlainText(geminiKeyCtx),
            removalPolicy: cdk.RemovalPolicy.RETAIN,
          });
          return s;
        })()
      : secretsmanager.Secret.fromSecretNameV2(this, 'GeminiApiKey', 'pinged-in/gemini-api-key');

    const resumeBucket = new s3.Bucket(this, 'ResumeBucket', {
      bucketName: this.node.tryGetContext('resumeBucketName'),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      enforceSSL: true
    });

    const portalBucket = new s3.Bucket(this, 'PortalBucket', {
      websiteIndexDocument: 'index.html',
      publicReadAccess: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    const portalUserPool = new cognito.UserPool(this, 'PortalUserPool', {
      signInAliases: { username: true, email: false },
      selfSignUpEnabled: false,
      autoVerify: { email: false, phone: false },
      standardAttributes: {
        email: { required: false, mutable: true },
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const portalUserPoolClient = portalUserPool.addClient('PortalUserPoolClient', {
      authFlows: { userPassword: true },
      generateSecret: false,
      preventUserExistenceErrors: true,
    });

    new s3deploy.BucketDeployment(this, 'PortalDeployment', {
      destinationBucket: portalBucket,
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', '..', 'portal', 'dist'))],
      prune: false,
      cacheControl: [cdk.aws_s3_deployment.CacheControl.noCache()],
    });

    const resumeUrlRedirect = new lambda.Function(this, 'ResumeUrlRedirect', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'resume_url_redirect.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'src')),
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        DYNAMODB_TABLE: table.tableName,
        RESUME_S3_BUCKET: resumeBucket.bucketName,
        RESUME_S3_PREFIX: 'resumes',
        RESUME_URL_EXPIRES_SECONDS: '604800'
      }
    });

    resumeBucket.grantRead(resumeUrlRedirect);
    table.grantReadData(resumeUrlRedirect);

    const resumeUrlRedirectUrl = resumeUrlRedirect.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE
    });

    const portalApi = new lambda.DockerImageFunction(this, 'PortalApi', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '..', '..'), {
        file: 'cdk/lambda/Dockerfile.portal'
      }),
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(180),
      memorySize: 2048,
      environment: {
        DYNAMODB_TABLE: table.tableName,
        LINKEDIN_KEYWORDS: 'Data Engineer',
        LINKEDIN_LOCATION: 'New York',
        LINKEDIN_TPR: 'r86400',
        ROLE_KEYWORDS: 'Data Engineer',
        RESUME_S3_BUCKET: resumeBucket.bucketName,
        RESUME_S3_PREFIX: 'resumes',
        RESUME_URL_EXPIRES_SECONDS: '604800',
        USER_TEMPLATES_ROOT: '/var/task/users',
        DEFAULT_TEMPLATE_USER: 'umang',
        RESUME_TEX_PATH: '/var/task/users/umang/resume.tex',
        COVER_LETTER_TEX_PATH: '/var/task/users/umang/cover_letter.tex',
        SKILLS_GROUPED_PATH: '/var/task/users/umang/skills_grouped.json',
        REPLACEMENT_RULES_PATH: '/var/task/users/umang/replacement_rules.json',
        FONTCONFIG_PATH: '/etc/fonts',
        FONTCONFIG_FILE: '/etc/fonts/fonts.conf',
        RESUME_URL_BASE: resumeUrlRedirectUrl.url,
        COGNITO_USER_POOL_ID: portalUserPool.userPoolId,
        COGNITO_APP_CLIENT_ID: portalUserPoolClient.userPoolClientId,
        COGNITO_REGION: this.region,
        PUSHOVER_APP_TOKEN_SECRET_ARN: pushoverAppToken.secretArn,
        GEMINI_API_KEY_SECRET_ARN: geminiApiKey.secretArn,
        GEMINI_MODEL: 'gemini-2.5-flash',
        GEMINI_TIMEOUT_SECONDS: '15',
        COVER_LETTER_MISSION_ENABLED: 'true',
        PORTAL_URL_BASE: portalPublicUrl,
      }
    });

    const portalApiUrl = portalApi.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedHeaders: ['content-type', 'authorization'],
        allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST],
        allowedOrigins: ['*']
      }
    });

    new s3deploy.BucketDeployment(this, 'PortalApiConfigDeployment', {
      destinationBucket: portalBucket,
      sources: [s3deploy.Source.jsonData('config.json', {
        apiBase: portalApiUrl.url.replace(/\/$/, ''),
        cognitoRegion: this.region,
        cognitoUserPoolId: portalUserPool.userPoolId,
        cognitoClientId: portalUserPoolClient.userPoolClientId,
      })],
      prune: false,
      cacheControl: [cdk.aws_s3_deployment.CacheControl.noCache()],
    });

    table.grantReadWriteData(portalApi);
    resumeBucket.grantReadWrite(portalApi);
    pushoverAppToken.grantRead(portalApi);
    geminiApiKey.grantRead(portalApi);
    portalApi.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminSetUserPassword',
        'cognito-idp:AdminGetUser',
      ],
      resources: [portalUserPool.userPoolArn],
    }));

    const jobChecker = new lambda.DockerImageFunction(this, 'LinkedInJobChecker', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '..', '..'), {
        file: 'cdk/lambda/Dockerfile'
      }),
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(180),
      memorySize: 2048,
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
        DEBUG_HTML: 'false',
        RESUME_S3_BUCKET: resumeBucket.bucketName,
        RESUME_S3_PREFIX: 'resumes',
        RESUME_COMPILE_PDF: 'true',
        RESUME_URL_EXPIRES_SECONDS: '604800',
        RESUME_AUTO_GENERATE: 'false',
        RESUME_URL_BASE: resumeUrlRedirectUrl.url,
        PORTAL_URL_BASE: portalPublicUrl,
        JD_FETCH_MODE: 'urllib',
        USER_TEMPLATES_ROOT: '/var/task/users',
        DEFAULT_TEMPLATE_USER: 'umang',
        RESUME_TEX_PATH: '/var/task/users/umang/resume.tex',
        COVER_LETTER_TEX_PATH: '/var/task/users/umang/cover_letter.tex',
        SKILLS_GROUPED_PATH: '/var/task/users/umang/skills_grouped.json',
        REPLACEMENT_RULES_PATH: '/var/task/users/umang/replacement_rules.json',
        CHROME_BINARY: '/usr/bin/chromium',
        CHROMEDRIVER_PATH: '/usr/bin/chromedriver',
        FONTCONFIG_PATH: '/etc/fonts',
        FONTCONFIG_FILE: '/etc/fonts/fonts.conf'
      }
    });

    table.grantReadWriteData(jobChecker);
    pushoverAppToken.grantRead(jobChecker);
    resumeBucket.grantReadWrite(jobChecker);
    jobChecker.grantInvoke(portalApi);
    portalApi.addEnvironment('JOB_CHECKER_FUNCTION_NAME', jobChecker.functionName);

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

    new cdk.CfnOutput(this, 'PortalWebsiteUrl', {
      value: portalPublicUrl
    });
    new cdk.CfnOutput(this, 'PortalApiUrl', {
      value: portalApiUrl.url
    });
    new cdk.CfnOutput(this, 'PortalUserPoolId', {
      value: portalUserPool.userPoolId
    });
    new cdk.CfnOutput(this, 'PortalUserPoolClientId', {
      value: portalUserPoolClient.userPoolClientId
    });
  }
}
