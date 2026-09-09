import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('loadConfig', () => {
  it('fails fast and says which variable is wrong', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL is required/);
  });

  it('applies defaults for everything optional', () => {
    const config = loadConfig(base as NodeJS.ProcessEnv);

    expect(config.awsRegion).toBe('eu-west-1');
    expect(config.batchSize).toBe(10);
    expect(config.ingestQueueName).toBe('drone-telemetry-ingest');
    expect(config.logPretty).toBe(false);
  });

  it('rejects an out-of-range batch size rather than silently clamping it', () => {
    expect(() => loadConfig({ ...base, BATCH_SIZE: '50' } as NodeJS.ProcessEnv)).toThrow();
  });

  it('rejects a log level Pino would not understand', () => {
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'chatty' } as NodeJS.ProcessEnv)).toThrow();
  });
});

describe('boolean environment variables', () => {
  /**
   * Regression test. This was z.coerce.boolean(), which applies JavaScript's
   * Boolean(), and Boolean("false") is true. Every non-empty string enabled the
   * flag, including the one that means the opposite.
   */
  it.each(['true', 'TRUE', '1', 'yes', 'on'])('treats %s as true', (value) => {
    expect(loadConfig({ ...base, LOG_PRETTY: value } as NodeJS.ProcessEnv).logPretty).toBe(true);
  });

  it.each(['false', 'FALSE', '0', 'no', 'off', ''])('treats %s as false', (value) => {
    expect(loadConfig({ ...base, LOG_PRETTY: value } as NodeJS.ProcessEnv).logPretty).toBe(false);
  });

  it('defaults to false when unset', () => {
    expect(loadConfig(base as NodeJS.ProcessEnv).logPretty).toBe(false);
  });
});

describe('endpoint overrides', () => {
  it('falls back to AWS_ENDPOINT_URL when only it is set', () => {
    const config = loadConfig({
      ...base,
      AWS_ENDPOINT_URL: 'http://localstack:4566',
    } as NodeJS.ProcessEnv);

    expect(config.awsEndpointUrl).toBe('http://localstack:4566');
    expect(config.s3EndpointUrl).toBeUndefined();
  });

  it('keeps separate S3 and SQS endpoints when the local stack runs two servers', () => {
    const config = loadConfig({
      ...base,
      S3_ENDPOINT_URL: 'http://minio:9000',
      SQS_ENDPOINT_URL: 'http://elasticmq:9324',
    } as NodeJS.ProcessEnv);

    expect(config.s3EndpointUrl).toBe('http://minio:9000');
    expect(config.sqsEndpointUrl).toBe('http://elasticmq:9324');
  });

  it('leaves every endpoint unset for a real deployment', () => {
    const config = loadConfig(base as NodeJS.ProcessEnv);

    expect(config.awsEndpointUrl).toBeUndefined();
    expect(config.s3EndpointUrl).toBeUndefined();
    expect(config.sqsEndpointUrl).toBeUndefined();
  });
});
