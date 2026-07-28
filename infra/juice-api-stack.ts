import { Duration, Stack, CfnOutput, CfnParameter } from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

export class JuiceApiStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);
    const buildVersionCommit = String(
      this.node.tryGetContext("versionCommit") ||
      process.env.GITHUB_SHA ||
      process.env.JUICE_VERSION_COMMIT ||
      resolveHeadCommit() ||
      "unknown"
    );

    const githubClientId = new CfnParameter(this, "GitHubClientId", {
      type: "String",
      description: "GitHub OAuth application client ID used by juice auth login."
    });

    const convexUrl = new CfnParameter(this, "ConvexUrl", {
      type: "String",
      description: "Convex HTTP Actions URL for the membership store, e.g. https://<deployment>.convex.site"
    });

    /**
     * An ARN rather than the value itself. A CfnParameter is readable in the
     * CloudFormation console and stored with the stack, so passing the shared
     * secret directly would publish it. Create the secret out of band, populate
     * it with the same value as Convex's JUICE_API_SHARED_SECRET, and pass its
     * ARN here.
     */
    const convexSecretArn = new CfnParameter(this, "ConvexSharedSecretArn", {
      type: "String",
      description: "COMPLETE ARN (including the trailing 6-character suffix, e.g. ...-PJOkpC) of a Secrets Manager secret holding the Convex shared secret. Must match JUICE_API_SHARED_SECRET in Convex."
    });

    const versionCommit = new CfnParameter(this, "VersionCommit", {
      type: "String",
      default: buildVersionCommit,
      description: "Git commit SHA exposed by GET / and baked into the Docker image."
    });

    const desiredCount = new CfnParameter(this, "DesiredCount", {
      type: "Number",
      default: 1,
      minValue: 1,
      description: "Number of Juice API Fargate tasks to run."
    });

    const certificateArn = new CfnParameter(this, "CertificateArn", {
      type: "String",
      description: "ACM certificate ARN for the Juice API HTTPS listener."
    });

    const hostedZoneId = new CfnParameter(this, "HostedZoneId", {
      type: "String",
      description: "Route53 hosted zone ID for the Juice API domain."
    });

    const hostedZoneName = new CfnParameter(this, "HostedZoneName", {
      type: "String",
      description: "Route53 hosted zone name, for example example.com."
    });

    const apiDomainName = new CfnParameter(this, "ApiDomainName", {
      type: "String",
      description: "Fully-qualified HTTPS API domain, for example api.example.com."
    });

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1
    });

    const cluster = new ecs.Cluster(this, "Cluster", { vpc });

    const convexSharedSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "ConvexSharedSecret",
      convexSecretArn.valueAsString
    );

    const tokenSecret = new secretsmanager.Secret(this, "TokenSecret", {
      description: "JWT signing secret for Juice API tokens.",
      generateSecretString: {
        passwordLength: 48,
        excludePunctuation: true
      }
    });

    const imageAsset = new ecrAssets.DockerImageAsset(this, "Image", {
      directory: path.resolve("."),
      file: "Dockerfile",
      buildArgs: {
        JUICE_VERSION_COMMIT: buildVersionCommit
      }
    });

    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "Service", {
      cluster,
      desiredCount: desiredCount.valueAsNumber,
      publicLoadBalancer: true,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      redirectHTTP: true,
      certificate: acm.Certificate.fromCertificateArn(this, "Certificate", certificateArn.valueAsString),
      domainName: apiDomainName.valueAsString,
      domainZone: route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
        hostedZoneId: hostedZoneId.valueAsString,
        zoneName: hostedZoneName.valueAsString
      }),
      circuitBreaker: { rollback: true },
      cpu: 512,
      memoryLimitMiB: 1024,
      minHealthyPercent: 100,
      taskImageOptions: {
        image: ecs.ContainerImage.fromDockerImageAsset(imageAsset),
        containerPort: 8787,
        environment: {
          AWS_REGION: Stack.of(this).region,
          GITHUB_CLIENT_ID: githubClientId.valueAsString,
          JUICE_CONVEX_URL: convexUrl.valueAsString,
          JUICE_VERSION_COMMIT: versionCommit.valueAsString,
          NODE_ENV: "production",
          PORT: "8787"
        },
        secrets: {
          JUICE_TOKEN_SECRET: ecs.Secret.fromSecretsManager(tokenSecret),
          JUICE_CONVEX_SECRET: ecs.Secret.fromSecretsManager(convexSharedSecret)
        },
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: "juice-api",
          logRetention: logs.RetentionDays.ONE_MONTH
        })
      },
      healthCheckGracePeriod: Duration.seconds(60)
    });

    service.targetGroup.configureHealthCheck({
      path: "/healthz",
      healthyHttpCodes: "200",
      interval: Duration.seconds(30),
      timeout: Duration.seconds(5)
    });

    tokenSecret.grantRead(service.taskDefinition.taskRole);

    convexSharedSecret.grantRead(service.taskDefinition.taskRole);

    const juiceSecretNamespaceArn = `arn:${Stack.of(this).partition}:secretsmanager:${Stack.of(this).region}:${Stack.of(this).account}:secret:/juice/accounts/*/projects/*`;
    const tokenRevocationsArn = `arn:${Stack.of(this).partition}:secretsmanager:${Stack.of(this).region}:${Stack.of(this).account}:secret:/juice/token-revocations*`;
    service.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:DeleteSecret"
      ],
      resources: [juiceSecretNamespaceArn, tokenRevocationsArn]
    }));
    service.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:CreateSecret"],
      resources: ["*"],
      conditions: {
        StringLike: {
          "secretsmanager:Name": [
            "/juice/accounts/*/projects/*",
            "/juice/token-revocations"
          ]
        }
      }
    }));
    // ListSecrets cannot be IAM-scoped by name prefix; the API filters results to
    // /juice/accounts/<token account>/… before returning keys (tenant isolation boundary).
    service.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:ListSecrets"],
      resources: ["*"]
    }));

    new CfnOutput(this, "ApiUrl", {
      value: `https://${apiDomainName.valueAsString}`,
      description: "Public Juice API URL."
    });

    new CfnOutput(this, "TokenSecretArn", {
      value: tokenSecret.secretArn,
      description: "Generated Juice API JWT signing secret."
    });

    new CfnOutput(this, "DeployedVersionCommit", {
      value: versionCommit.valueAsString,
      description: "Git commit SHA exposed by GET /."
    });
  }
}

function resolveHeadCommit(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve("."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}
