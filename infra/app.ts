#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { JuiceApiStack } from "./juice-api-stack.js";

const app = new cdk.App();

new JuiceApiStack(app, process.env.CDK_STACK_NAME || "JuiceApiStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || "us-east-1"
  }
});
