import { describe, expect, it } from 'vitest';

import { applyEndpointHost } from '../../src/adapters/sqs/queue.js';
import { buildS3Notification, encodeS3Key } from '../../scripts/s3-notification.js';

describe('applyEndpointHost', () => {
  /**
   * A queue server advertises URLs using the hostname it was configured with.
   * Under Compose that hostname only resolves inside the network, so the same
   * queue is http://elasticmq:9324/... to the processor and
   * http://localhost:9324/... to a script on the host. Whichever the server
   * advertises is wrong for one of them.
   */
  it('rewrites the host to the endpoint the caller can actually reach', () => {
    expect(
      applyEndpointHost('http://elasticmq:9324/000000000000/ingest', 'http://localhost:9324'),
    ).toBe('http://localhost:9324/000000000000/ingest');
  });

  it('preserves the path, which is what identifies the queue', () => {
    expect(applyEndpointHost('http://a:1/queue/ingest', 'http://b:2')).toBe(
      'http://b:2/queue/ingest',
    );
  });

  it('leaves real SQS URLs untouched when no endpoint is configured', () => {
    const real = 'https://sqs.eu-west-1.amazonaws.com/123456789012/drone-telemetry-ingest';
    expect(applyEndpointHost(real, undefined)).toBe(real);
  });

  it('does not throw on a malformed endpoint', () => {
    expect(() => applyEndpointHost('http://a:1/q', 'not a url')).not.toThrow();
  });
});

describe('encodeS3Key', () => {
  /**
   * S3 percent-encodes keys in its notifications and encodes spaces as '+'.
   * Emitting the same encoding locally means the handler's decoding path is
   * genuinely exercised rather than only covered by unit tests.
   */
  it('encodes spaces as plus, exactly as S3 does', () => {
    expect(encodeS3Key('delivery batch.csv')).toBe('delivery+batch.csv');
  });

  it('leaves path separators readable', () => {
    expect(encodeS3Key('2026/09/batch.csv')).toBe('2026/09/batch.csv');
  });

  it('percent-encodes other reserved characters', () => {
    expect(encodeS3Key('batch#1.csv')).toBe('batch%231.csv');
  });
});

describe('buildS3Notification', () => {
  it('produces a message the handler parses as a genuine S3 event', () => {
    const message = JSON.parse(buildS3Notification('raw', 'a/b c.csv', 42, 'eu-west-1'));

    expect(message.Records[0].eventSource).toBe('aws:s3');
    expect(message.Records[0].s3.bucket.name).toBe('raw');
    expect(message.Records[0].s3.object.key).toBe('a/b+c.csv');
    expect(message.Records[0].s3.object.size).toBe(42);
  });
});
