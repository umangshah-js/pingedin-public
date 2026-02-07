#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PingedInStack } from '../lib/pinged-in-stack';
import { PingedInCleanupStack } from '../lib/pinged-in-cleanup-stack';

const app = new cdk.App();

new PingedInStack(app, 'PingedInStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1'
  }
});

if (app.node.tryGetContext('cleanupTestResources') === 'true') {
  new PingedInCleanupStack(app, 'PingedInCleanupStack', {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: 'us-east-1'
    }
  });
}
