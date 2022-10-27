// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Effect, Policy, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from '@aws-cdk/aws-iam';
import { Code, Function as LambdaFunction, Runtime } from '@aws-cdk/aws-lambda';
import { Bucket, IBucket } from '@aws-cdk/aws-s3';
import { ArnFormat, Aws, CfnCondition, CfnResource, Construct, CustomResource, Duration, Lazy, Stack } from '@aws-cdk/core';
import { addCfnSuppressRules } from '../../../utils/utils';

import { SolutionConstructProps } from '../../types';
import { CommonResourcesProps, Conditions } from '../common-resources-construct';

export interface CustomResourcesConstructProps extends CommonResourcesProps {
  readonly conditions: Conditions;
  readonly secretsManagerPolicy: Policy;
}

export interface ValidateSourceAndFallbackImageBucketsCustomResourceProps {
  readonly sourceBuckets: string;
  readonly fallbackImageS3Bucket: string;
  readonly fallbackImageS3Key: string;
}

export interface SetupCopyWebsiteCustomResourceProps {
  readonly hostingBucket: Bucket;
}

export interface SetupPutWebsiteConfigCustomResourceProps {
  readonly hostingBucket: Bucket;
  readonly apiEndpoint: string;
}

export interface SetupValidateSecretsManagerProps {
  readonly secretsManager: string;
  readonly secretsManagerKey: string;
}

export class CustomResourcesConstruct extends Construct {
  private readonly environment: string;
  private readonly solutionVersion: string;
  private readonly sourceCodeBucket: IBucket;
  private readonly sourceCodeKeyPrefix: string;
  private readonly conditions: Conditions;
  private readonly customResourceRole: Role;
  private readonly customResourceLambda: LambdaFunction;
  public readonly uuid: string;

  constructor(scope: Construct, id: string, props: CustomResourcesConstructProps) {
    super(scope, id);

    this.sourceCodeBucket = Bucket.fromBucketName(this, 'ImageHandlerLambdaSource', props.sourceCodeBucketName);
    this.sourceCodeKeyPrefix = props.sourceCodeKeyPrefix;
    this.environment = props.environment;
    this.solutionVersion = props.solutionVersion;
    this.conditions = props.conditions;

    this.customResourceRole = new Role(this, 'CustomResourceRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      path: '/',
      inlinePolicies: {
        CloudWatchLogsPolicy: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
              resources: [Stack.of(this).formatArn({ service: 'logs', resource: 'log-group', resourceName: '/aws/lambda/*', arnFormat: ArnFormat.COLON_RESOURCE_NAME })]
            }),
            new PolicyStatement({
              actions: ['s3:putBucketAcl', 's3:putEncryptionConfiguration', 's3:putBucketPolicy', 's3:CreateBucket', 's3:GetObject', 's3:PutObject', 's3:ListBucket'],
              resources: [Stack.of(this).formatArn({ partition: Aws.PARTITION, service: 's3', region: '', account: '', resource: '*', arnFormat: ArnFormat.COLON_RESOURCE_NAME })]
            })
          ]
        }),
        EC2Policy: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ['ec2:DescribeRegions'],
              resources: ['*']
            })
          ]
        })
      }
    });

    addCfnSuppressRules(this.customResourceRole, [
      {
        id: 'W11',
        reason: "Allow '*' because it is required for making DescribeRegions API call as it doesn't support resource-level permissions and require to choose all resources."
      }
    ]);

    props.secretsManagerPolicy.attachToRole(this.customResourceRole);

    this.customResourceLambda = new LambdaFunction(this, 'CustomResourceFunction', {
      functionName: `${props.solutionName}-CustomResourceFunction-${props.environment}`,
      description: `${props.solutionDisplayName} (${props.solutionVersion}): Custom resource on ${props.environment} environment`,
      runtime: Runtime.NODEJS_14_X,
      handler: 'custom-resource/index.handler',
      timeout: Duration.minutes(1),
      memorySize: 128,
      code: Code.fromBucket(this.sourceCodeBucket, [props.sourceCodeKeyPrefix, 'custom-resource.zip'].join('/')),
      role: this.customResourceRole,
      environment: {
        SOLUTION_ID: props.solutionId,
        RETRY_SECONDS: '5',
        SOLUTION_VERSION: props.solutionVersion
      }
    });

    const customResourceUuid = this.createCustomResource('CustomResourceUuid', this.customResourceLambda, { Region: Aws.REGION, CustomAction: 'createUuid' });
    this.uuid = customResourceUuid.getAttString('UUID');
  }

  public setupCopyWebsiteCustomResource(props: SetupCopyWebsiteCustomResourceProps) {
    // Allows the custom resource to read the static assets for the front-end from the source code bucket
    this.sourceCodeBucket.grantRead(this.customResourceLambda, `${this.sourceCodeKeyPrefix}/*`);

    this.createCustomResource(
      'CopyWebsite',
      this.customResourceLambda,
      {
        CustomAction: 'copyS3assets',
        Region: Aws.REGION,
        ManifestKey: [this.sourceCodeKeyPrefix, 'demo-ui-manifest.json'].join('/'),
        SourceS3Bucket: this.sourceCodeBucket.bucketName,
        SourceS3key: [this.sourceCodeKeyPrefix, 'demo-ui'].join('/'),
        DestS3Bucket: props.hostingBucket.bucketName,
        Version: this.solutionVersion
      },
      this.conditions.deployUICondition
    );
  }

  public setupPutWebsiteConfigCustomResource(props: SetupPutWebsiteConfigCustomResourceProps) {
    this.createCustomResource(
      'PutWebsiteConfig',
      this.customResourceLambda,
      {
        CustomAction: 'putConfigFile',
        Region: Aws.REGION,
        ConfigItem: { apiEndpoint: `https://${props.apiEndpoint}` },
        DestS3Bucket: props.hostingBucket.bucketName,
        DestS3key: 'demo-ui-config.js'
      },
      this.conditions.deployUICondition
    );
  }

  public setupValidateSecretsManager(props: SetupValidateSecretsManagerProps) {
    this.createCustomResource(
      'CustomResourceCheckSecretsManager',
      this.customResourceLambda,
      {
        CustomAction: 'checkSecretsManager',
        SecretsManagerName: props.secretsManager,
        SecretsManagerKey: props.secretsManagerKey
      },
      this.conditions.enableSignatureCondition
    );
  }

  public createLogBucket(): IBucket {
    const bucketSuffix = `${Aws.STACK_NAME}-${Aws.REGION}-${Aws.ACCOUNT_ID}-${this.environment}`;
    const logBucketCreationResult = this.createCustomResource('LogBucketCustomResource', this.customResourceLambda, {
      CustomAction: 'createCloudFrontLoggingBucket',
      BucketSuffix: bucketSuffix
    });

    const optInRegionAccessLogBucket = Bucket.fromBucketAttributes(this, 'CloudFrontLoggingBucket', {
      bucketName: Lazy.string({ produce: () => logBucketCreationResult.getAttString('BucketName') }),
      region: Lazy.string({ produce: () => logBucketCreationResult.getAttString('Region') })
    });

    return optInRegionAccessLogBucket;
  }

  private createCustomResource(id: string, customResourceFunction: LambdaFunction, props?: Record<string, unknown>, condition?: CfnCondition): CustomResource {
    const customResource = new CustomResource(this, id, {
      serviceToken: customResourceFunction.functionArn,
      properties: props
    });

    if (condition) {
      (customResource.node.defaultChild as CfnResource).cfnOptions.condition = condition;
    }

    return customResource;
  }
}
