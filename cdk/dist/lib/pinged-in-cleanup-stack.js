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
exports.PingedInCleanupStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const cr = __importStar(require("aws-cdk-lib/custom-resources"));
class PingedInCleanupStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const roleName = 'linkedin-guest-check-role';
        const functionName = 'linkedin-guest-check';
        const policyArn = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';
        const roleArn = cdk.Arn.format({
            service: 'iam',
            region: '',
            resource: 'role',
            resourceName: roleName
        }, this);
        const lambdaArn = cdk.Arn.format({
            service: 'lambda',
            resource: 'function',
            resourceName: functionName
        }, this);
        const logGroupArn = cdk.Arn.format({
            service: 'logs',
            resource: 'log-group',
            resourceName: `/aws/lambda/${functionName}`
        }, this);
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
exports.PingedInCleanupStack = PingedInCleanupStack;
