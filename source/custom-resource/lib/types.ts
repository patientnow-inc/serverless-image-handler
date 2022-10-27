// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CheckSecretManagerRequestProperties,
  CopyS3AssetsRequestProperties,
  CreateLoggingBucketRequestProperties,
  CustomResourceRequestPropertiesBase,
  PutConfigRequestProperties
} from './interfaces';

export type ResourcePropertyTypes =
  | CustomResourceRequestPropertiesBase
  | PutConfigRequestProperties
  | CopyS3AssetsRequestProperties
  | CheckSecretManagerRequestProperties
  | CreateLoggingBucketRequestProperties;

export class CustomResourceError extends Error {
  constructor(public readonly code: string, public readonly message: string) {
    super();
  }
}
