// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CustomResourceActions, CustomResourceRequestTypes, StatusTypes } from './enums';
import { ResourcePropertyTypes } from './types';

export interface CustomResourceRequestPropertiesBase {
  CustomAction: CustomResourceActions;
}

export interface PutConfigRequestProperties extends CustomResourceRequestPropertiesBase {
  ConfigItem: unknown;
  DestS3Bucket: string;
  DestS3key: string;
}

export interface CopyS3AssetsRequestProperties extends CustomResourceRequestPropertiesBase {
  ManifestKey: string;
  SourceS3Bucket: string;
  SourceS3key: string;
  DestS3Bucket: string;
}

export interface CheckSecretManagerRequestProperties extends CustomResourceRequestPropertiesBase {
  SecretsManagerName: string;
  SecretsManagerKey: string;
}

export interface PolicyStatement {
  Action?: string;
  Resource?: string;
  Effect?: string;
  Principal?: string;
  Sid?: string;
  Condition?: Record<string, unknown>;
}

export interface CreateLoggingBucketRequestProperties extends CustomResourceRequestPropertiesBase {
  BucketSuffix: string;
}

export interface CustomResourceRequest {
  RequestType: CustomResourceRequestTypes;
  PhysicalResourceId: string;
  StackId: string;
  ServiceToken: string;
  RequestId: string;
  LogicalResourceId: string;
  ResponseURL: string;
  ResourceType: string;
  ResourceProperties: ResourcePropertyTypes;
}

export interface CompletionStatus {
  Status: StatusTypes;
  Data: Record<string, unknown> | { Error?: { Code: string; Message: string } };
}

export interface LambdaContext {
  logStreamName: string;
}
