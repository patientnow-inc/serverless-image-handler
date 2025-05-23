// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export type YesNo = 'Yes' | 'No';

export interface SolutionConstructProps {
  readonly environment: string;
  readonly corsEnabled: string;
  readonly corsOrigin: string;
  readonly deployUI: YesNo;
  readonly logRetentionPeriod: number;
  readonly autoWebP: string;
  readonly enableSignature: YesNo;
  readonly secretsManager: string;
  readonly secretsManagerKey: string;
  readonly autoGeneratedImagePrefix: string;
  readonly presignedUrlExpiresInSeconds: string;
  readonly jwtSecretPathOnParameterStore: string;
}

export declare enum Environments {
  DEV = 'dev',
  TEST = 'test',
  STAGING = 'staging',
  PROD = 'prod'
}
