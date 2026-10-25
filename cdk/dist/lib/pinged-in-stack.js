"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PingedInStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const scheduler = __importStar(require("aws-cdk-lib/aws-scheduler"));
const secretsmanager = __importStar(require("aws-cdk-lib/aws-secretsmanager"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const s3deploy = __importStar(require("aws-cdk-lib/aws-s3-deployment"));
const cognito = __importStar(require("aws-cdk-lib/aws-cognito"));
const path = __importStar(require("path"));
class PingedInStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const table = new dynamodb.Table(this, 'LinkedInJobsTable', {
            tableName: 'linkedin_jobs',
            partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.RETAIN
        });
        const pushoverAppToken = new secretsmanager.Secret(this, 'PushoverAppToken', {
            secretName: 'pinged-in/pushover-app-token',
            secretStringValue: cdk.SecretValue.unsafePlainText(this.node.tryGetContext('pushoverAppToken') ?? 'REPLACE_ME')
        });
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
            sources: [s3deploy.Source.asset(path.join(__dirname, '..', '..', 'portal'))],
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
                RESUME_S3_BUCKET: resumeBucket.bucketName,
                RESUME_S3_PREFIX: 'resumes',
                RESUME_URL_EXPIRES_SECONDS: '604800',
                RESUME_TEX_PATH: '/var/task/resume.tex',
                SKILLS_GROUPED_PATH: '/var/task/skills_grouped.json',
                REPLACEMENT_RULES_PATH: '/var/task/replacement_rules.json',
                FONTCONFIG_PATH: '/etc/fonts',
                FONTCONFIG_FILE: '/etc/fonts/fonts.conf',
                RESUME_URL_BASE: resumeUrlRedirectUrl.url,
                COGNITO_USER_POOL_ID: portalUserPool.userPoolId,
                COGNITO_APP_CLIENT_ID: portalUserPoolClient.userPoolClientId,
                COGNITO_REGION: this.region,
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
            cacheControl: [cdk.aws_s3_deployment.CacheControl.noCache()],
        });
        table.grantReadWriteData(portalApi);
        resumeBucket.grantReadWrite(portalApi);
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
                PUSHOVER_USER_KEY: '',
                PUSHOVER_APP_TOKEN_SECRET_ARN: pushoverAppToken.secretArn,
                DEBUG_HTML: 'false',
                RESUME_S3_BUCKET: resumeBucket.bucketName,
                RESUME_S3_PREFIX: 'resumes',
                RESUME_COMPILE_PDF: 'true',
                RESUME_URL_EXPIRES_SECONDS: '604800',
                RESUME_AUTO_GENERATE: 'false',
                RESUME_URL_BASE: resumeUrlRedirectUrl.url,
                PORTAL_URL_BASE: portalBucket.bucketWebsiteUrl,
                JD_FETCH_MODE: 'urllib',
                RESUME_TEX_PATH: '/var/task/resume.tex',
                SKILLS_GROUPED_PATH: '/var/task/skills_grouped.json',
                REPLACEMENT_RULES_PATH: '/var/task/replacement_rules.json',
                CHROME_BINARY: '/usr/bin/chromium',
                CHROMEDRIVER_PATH: '/usr/bin/chromedriver',
                FONTCONFIG_PATH: '/etc/fonts',
                FONTCONFIG_FILE: '/etc/fonts/fonts.conf'
            }
        });
        table.grantReadWriteData(jobChecker);
        pushoverAppToken.grantRead(jobChecker);
        resumeBucket.grantReadWrite(jobChecker);
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
            value: portalBucket.bucketWebsiteUrl
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
exports.PingedInStack = PingedInStack;
