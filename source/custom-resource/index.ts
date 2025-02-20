// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import EC2, { DescribeRegionsRequest } from 'aws-sdk/clients/ec2';
import S3, { CreateBucketRequest, PutBucketEncryptionRequest, PutBucketPolicyRequest } from 'aws-sdk/clients/s3';
import SecretsManager from 'aws-sdk/clients/secretsmanager';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { createHash } from 'crypto';
import moment from 'moment';
import { v4 } from 'uuid';

import { getOptions } from '../solution-utils/get-options';
import { isNullOrWhiteSpace } from '../solution-utils/helpers';
import {
  CheckSecretManagerRequestProperties,
  CompletionStatus,
  CopyS3AssetsRequestProperties,
  CreateLoggingBucketRequestProperties,
  CustomResourceActions,
  CustomResourceError,
  CustomResourceRequest,
  CustomResourceRequestTypes,
  ErrorCodes,
  LambdaContext,
  PutConfigRequestProperties,
  StatusTypes
} from './lib';

const awsSdkOptions = getOptions();
const s3Client = new S3(awsSdkOptions);
const ec2Client = new EC2(awsSdkOptions);
const secretsManager = new SecretsManager(awsSdkOptions);

const { AWS_REGION, RETRY_SECONDS } = process.env;
const RETRY_COUNT = 3;

/**
 * Custom resource Lambda handler.
 * @param event The custom resource request.
 * @param context The custom resource context.
 * @returns Processed request response.
 */
export async function handler(event: CustomResourceRequest, context: LambdaContext) {
  console.info('Received event:', JSON.stringify(event, null, 2));

  const { RequestType, ResourceProperties } = event;
  const response: CompletionStatus = {
    Status: StatusTypes.SUCCESS,
    Data: {}
  };

  try {
    switch (ResourceProperties.CustomAction) {
      case CustomResourceActions.PUT_CONFIG_FILE:
        if ([CustomResourceRequestTypes.CREATE, CustomResourceRequestTypes.UPDATE].includes(RequestType)) {
          response.Data = await putConfigFile(ResourceProperties as PutConfigRequestProperties);
        }
        break;
      case CustomResourceActions.COPY_S3_ASSETS:
        if ([CustomResourceRequestTypes.CREATE, CustomResourceRequestTypes.UPDATE].includes(RequestType)) {
          response.Data = await copyS3Assets(ResourceProperties as CopyS3AssetsRequestProperties);
        }
        break;
      case CustomResourceActions.CREATE_UUID:
        if ([CustomResourceRequestTypes.CREATE].includes(RequestType)) {
          response.Data = await generateUUID();
        }
        break;
      case CustomResourceActions.CHECK_SECRETS_MANAGER:
        if ([CustomResourceRequestTypes.CREATE, CustomResourceRequestTypes.UPDATE].includes(RequestType)) {
          response.Data = await checkSecretsManager(ResourceProperties as CheckSecretManagerRequestProperties);
        }
        break;
      case CustomResourceActions.CREATE_LOGGING_BUCKET:
        if ([CustomResourceRequestTypes.CREATE].includes(RequestType)) {
          response.Data = await createCloudFrontLoggingBucket(ResourceProperties as CreateLoggingBucketRequestProperties);
        }
        break;
      default:
        break;
    }
  } catch (error) {
    console.error(`Error occurred at ${event.RequestType}::${ResourceProperties.CustomAction}`, error);

    response.Status = StatusTypes.FAILED;
    response.Data.Error = {
      Code: error.code ?? 'CustomResourceError',
      Message: error.message ?? 'Custom resource error occurred.'
    };
  } finally {
    await sendCloudFormationResponse(event, context.logStreamName, response);
  }

  return response;
}

/**
 * Suspends for the specified amount of seconds.
 * @param timeOut The number of seconds for which the call is suspended.
 * @returns Sleep promise.
 */
async function sleep(timeOut: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, timeOut));
}

/**
 * Gets retry timeout based on the current retry attempt in seconds.
 * @param attempt Retry attempt.
 * @returns Timeout in seconds.
 */
function getRetryTimeout(attempt: number): number {
  const retrySeconds = Number(RETRY_SECONDS);
  return retrySeconds * 1000 * attempt;
}

/**
 * Get content type by file name.
 * @param filename File name.
 * @returns Content type.
 */
function getContentType(filename: string): string {
  let contentType = '';
  if (filename.endsWith('.html')) {
    contentType = 'text/html';
  } else if (filename.endsWith('.css')) {
    contentType = 'text/css';
  } else if (filename.endsWith('.png')) {
    contentType = 'image/png';
  } else if (filename.endsWith('.svg')) {
    contentType = 'image/svg+xml';
  } else if (filename.endsWith('.jpg')) {
    contentType = 'image/jpeg';
  } else if (filename.endsWith('.js')) {
    contentType = 'application/javascript';
  } else {
    contentType = 'binary/octet-stream';
  }
  return contentType;
}

/**
 * Send custom resource response.
 * @param event Custom resource event.
 * @param logStreamName Custom resource log stream name.
 * @param response Response completion status.
 * @returns The promise of the sent request.
 */
async function sendCloudFormationResponse(event: CustomResourceRequest, logStreamName: string, response: CompletionStatus): Promise<AxiosResponse> {
  const responseBody = JSON.stringify({
    Status: response.Status,
    Reason: `See the details in CloudWatch Log Stream: ${logStreamName}`,
    PhysicalResourceId: event.LogicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: response.Data
  });

  const config: AxiosRequestConfig = {
    headers: {
      'Content-Type': '',
      'Content-Length': responseBody.length
    }
  };

  return axios.put(event.ResponseURL, responseBody, config);
}

/**
 * Puts the config file into S3 bucket.
 * @param requestProperties The request properties.
 * @returns Result of the putting config file.
 */
async function putConfigFile(requestProperties: PutConfigRequestProperties): Promise<{ Message: string; Content: string }> {
  const { ConfigItem, DestS3Bucket, DestS3key } = requestProperties;

  console.info(`Attempting to save content blob destination location: ${DestS3Bucket}/${DestS3key}`);
  console.info(JSON.stringify(ConfigItem, null, 2));

  const configFieldValues = Object.entries(ConfigItem)
    .map(([key, value]) => `${key}: '${value}'`)
    .join(',\n');

  const content = `'use strict';\n\nconst appVariables = {\n${configFieldValues}\n};`;

  // In case getting object fails due to asynchronous IAM permission creation, it retries.
  const params = {
    Bucket: DestS3Bucket,
    Body: content,
    Key: DestS3key,
    ContentType: getContentType(DestS3key)
  };

  for (let retry = 1; retry <= RETRY_COUNT; retry++) {
    try {
      console.info(`Putting ${DestS3key}... Try count: ${retry}`);

      await s3Client.putObject(params).promise();

      console.info(`Putting ${DestS3key} completed.`);
      break;
    } catch (error) {
      if (retry === RETRY_COUNT || error.code !== ErrorCodes.ACCESS_DENIED) {
        console.info(`Error occurred while putting ${DestS3key} into ${DestS3Bucket} bucket.`, error);
        throw new CustomResourceError('ConfigFileCreationFailure', `Saving config file to ${DestS3Bucket}/${DestS3key} failed.`);
      } else {
        console.info('Waiting for retry...');
        await sleep(getRetryTimeout(retry));
      }
    }
  }

  return {
    Message: 'Config file uploaded.',
    Content: content
  };
}

/**
 * Copies assets from the source S3 bucket to the destination S3 bucket.
 * @param requestProperties The request properties.
 * @returns The result of copying assets.
 */
async function copyS3Assets(requestProperties: CopyS3AssetsRequestProperties): Promise<{ Message: string; Manifest: { Files: string[] } }> {
  const { ManifestKey, SourceS3Bucket, SourceS3key, DestS3Bucket } = requestProperties;

  console.info(`Source bucket: ${SourceS3Bucket}`);
  console.info(`Source prefix: ${SourceS3key}`);
  console.info(`Destination bucket: ${DestS3Bucket}`);

  let manifest: { files: string[] };

  // Download manifest
  for (let retry = 1; retry <= RETRY_COUNT; retry++) {
    try {
      const getParams = {
        Bucket: SourceS3Bucket,
        Key: ManifestKey
      };
      const response = await s3Client.getObject(getParams).promise();
      manifest = JSON.parse(response.Body.toString());

      break;
    } catch (error) {
      if (retry === RETRY_COUNT || error.code !== ErrorCodes.ACCESS_DENIED) {
        console.error('Error occurred while getting manifest file.');
        console.error(error);

        throw new CustomResourceError('GetManifestFailure', 'Copy of website assets failed.');
      } else {
        console.info('Waiting for retry...');

        await sleep(getRetryTimeout(retry));
      }
    }
  }

  // Copy asset files
  try {
    await Promise.all(
      manifest.files.map(async (fileName: string) => {
        const copyObjectParams = {
          Bucket: DestS3Bucket,
          CopySource: `${SourceS3Bucket}/${SourceS3key}/${fileName}`,
          Key: fileName,
          ContentType: getContentType(fileName)
        };

        console.debug(`Copying ${fileName} to ${DestS3Bucket}`);
        return s3Client.copyObject(copyObjectParams).promise();
      })
    );

    return {
      Message: 'Copy assets completed.',
      Manifest: { Files: manifest.files }
    };
  } catch (error) {
    console.error('Error occurred while copying assets.');
    console.error(error);

    throw new CustomResourceError('CopyAssetsFailure', 'Copy of website assets failed.');
  }
}

/**
 * Generates UUID.
 * @returns Generated UUID.
 */
async function generateUUID(): Promise<{ UUID: string }> {
  return Promise.resolve({ UUID: v4() });
}

/**
 * Checks if AWS Secrets Manager secret is valid.
 * @param requestProperties The request properties.
 * @returns ARN of the AWS Secrets Manager secret.
 */
async function checkSecretsManager(requestProperties: CheckSecretManagerRequestProperties): Promise<{ Message: string; ARN: string }> {
  const { SecretsManagerName, SecretsManagerKey } = requestProperties;

  if (isNullOrWhiteSpace(SecretsManagerName)) {
    throw new CustomResourceError('SecretNotProvided', 'You need to provide AWS Secrets Manager secret.');
  }

  if (isNullOrWhiteSpace(SecretsManagerKey)) {
    throw new CustomResourceError('SecretKeyNotProvided', 'You need to provide AWS Secrets Manager secret key.');
  }

  let arn = '';

  for (let retry = 1; retry <= RETRY_COUNT; retry++) {
    try {
      const response = await secretsManager.getSecretValue({ SecretId: SecretsManagerName }).promise();
      const secretString = JSON.parse(response.SecretString);

      if (!Object.prototype.hasOwnProperty.call(secretString, SecretsManagerKey)) {
        throw new CustomResourceError('SecretKeyNotFound', `AWS Secrets Manager secret requires ${SecretsManagerKey} key.`);
      }

      arn = response.ARN;
      break;
    } catch (error) {
      if (retry === RETRY_COUNT) {
        console.error(`AWS Secrets Manager secret or signature might not exist: ${SecretsManagerName}/${SecretsManagerKey}`);

        throw error;
      } else {
        console.info('Waiting for retry...');

        await sleep(getRetryTimeout(retry));
      }
    }
  }

  return {
    Message: 'Secrets Manager validated.',
    ARN: arn
  };
}

/**
 * Creates a bucket with settings for cloudfront logging.
 * @param requestProperties The request properties.
 * @returns Bucket name of the created bucket.
 */
async function createCloudFrontLoggingBucket(requestProperties: CreateLoggingBucketRequestProperties) {
  const logBucketSuffix = createHash('md5').update(`${requestProperties.BucketSuffix}${moment.utc().valueOf()}`).digest('hex');
  const bucketName = `serverless-image-handler-logs-${logBucketSuffix.substring(0, 8)}`.toLowerCase();

  // the S3 bucket will be created in 'us-east-1' if the current region is in opt-in regions,
  // because CloudFront does not currently deliver access logs to opt-in region buckets
  const isOptInRegion = await checkRegionOptInStatus(AWS_REGION);
  const targetRegion = isOptInRegion ? 'us-east-1' : AWS_REGION;
  console.info(`The opt-in status of the '${AWS_REGION}' region is '${isOptInRegion ? 'opted-in' : 'opt-in-not-required'}'`);

  // create bucket
  try {
    const s3Client = new S3({ ...awsSdkOptions, apiVersion: '2006-03-01', region: targetRegion });

    const createBucketRequestParams: CreateBucketRequest = { Bucket: bucketName, ACL: 'log-delivery-write' };
    await s3Client.createBucket(createBucketRequestParams).promise();

    console.info(`Successfully created bucket '${bucketName}' in '${targetRegion}' region`);
  } catch (error) {
    console.error(`Could not create bucket '${bucketName}'`);
    console.error(error);

    throw error;
  }

  // add encryption to bucket
  console.info('Adding Encryption...');
  try {
    const putBucketEncryptionRequestParams: PutBucketEncryptionRequest = {
      Bucket: bucketName,
      ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] }
    };

    await s3Client.putBucketEncryption(putBucketEncryptionRequestParams).promise();

    console.info(`Successfully enabled encryption on bucket '${bucketName}'`);
  } catch (error) {
    console.error(`Failed to add encryption to bucket '${bucketName}'`);
    console.error(error);

    throw error;
  }

  // add policy to bucket
  try {
    console.info('Adding policy...');

    const bucketPolicyStatement = {
      Resource: `arn:aws:s3:::${bucketName}/*`,
      Action: '*',
      Effect: 'Deny',
      Principal: '*',
      Sid: 'HttpsOnly',
      Condition: { Bool: { 'aws:SecureTransport': 'false' } }
    };
    const bucketPolicy = { Version: '2012-10-17', Statement: [bucketPolicyStatement] };
    const putBucketPolicyRequestParams: PutBucketPolicyRequest = { Bucket: bucketName, Policy: JSON.stringify(bucketPolicy) };

    await s3Client.putBucketPolicy(putBucketPolicyRequestParams).promise();

    console.info(`Successfully added policy added to bucket '${bucketName}'`);
  } catch (error) {
    console.error(`Failed to add policy to bucket '${bucketName}'`);
    console.error(error);

    throw error;
  }

  return { BucketName: bucketName, Region: targetRegion };
}

/**
 * Checks if the region is opted-in or not.
 * @param region The region to check.
 * @returns The result of check.
 */
async function checkRegionOptInStatus(region: string): Promise<boolean> {
  const describeRegionsRequestParams: DescribeRegionsRequest = {
    RegionNames: [region],
    Filters: [{ Name: 'opt-in-status', Values: ['opted-in'] }]
  };
  const describeRegionsResponse = await ec2Client.describeRegions(describeRegionsRequestParams).promise();

  return describeRegionsResponse.Regions.length > 0;
}
