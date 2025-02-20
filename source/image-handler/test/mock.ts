// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export const mockAwsS3 = {
  headObject: jest.fn(),
  copyObject: jest.fn(),
  getObject: jest.fn(),
  putObject: jest.fn(),
  headBucket: jest.fn(),
  createBucket: jest.fn(),
  putBucketEncryption: jest.fn(),
  putBucketPolicy: jest.fn(),
  getSignedUrl: jest.fn()
};

jest.mock('aws-sdk/clients/s3', () => jest.fn(() => ({ ...mockAwsS3 })));

export const mockAwsSecretManager = {
  getSecretValue: jest.fn()
};

jest.mock('aws-sdk/clients/secretsmanager', () => jest.fn(() => ({ ...mockAwsSecretManager })));

export const mockAwsRekognition = {
  detectFaces: jest.fn(),
  detectModerationLabels: jest.fn()
};

jest.mock('aws-sdk/clients/rekognition', () => jest.fn(() => ({ ...mockAwsRekognition })));

export const mockAwsParameterStore = {
  getParameter: jest.fn()
};

jest.mock('aws-sdk/clients/ssm', () => jest.fn(() => ({ ...mockAwsParameterStore })));

export const mockJwt = {
  verify: jest.fn()
};

jest.mock('jsonwebtoken', () => ({
  ...jest.requireActual('jsonwebtoken'),
  ...mockJwt,
}));

export const mockAxios = {
  get: jest.fn()
};

jest.mock('axios', () => {
  return Object.assign(jest.fn(), mockAxios);
});