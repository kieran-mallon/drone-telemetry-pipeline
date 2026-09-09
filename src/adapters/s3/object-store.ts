import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { s3Endpoint, type Config } from '../../config.js';
import type { ObjectStore } from '../../ports/object-store.js';

export function createS3Client(config: Config): S3Client {
  const endpoint = s3Endpoint(config);

  return new S3Client({
    region: config.awsRegion,

    ...(endpoint !== undefined
      ? {
          /**
           * Present locally, absent in a real deployment. Path-style addressing
           * is required because local S3 servers serve buckets as a path on one
           * host rather than as bucket.host virtual subdomains.
           */
          endpoint,
          forcePathStyle: true,

          /**
           * Only send a checksum when the operation requires one.
           *
           * Since v3.729 the SDK defaults to WHEN_SUPPORTED, which attaches an
           * x-amz-checksum-crc32 header to ordinary PutObject calls. Real S3
           * expects it; several S3-compatible stores reject it outright, and it
           * has broken uploads against MinIO, Cloudflare R2 and others.
           *
           * Narrowed to the local case on purpose. Against real AWS the default
           * stands, because those checksums are genuine end-to-end integrity
           * protection and worth having. This is a compatibility shim for
           * emulators, not a considered opinion about checksums.
           */
          requestChecksumCalculation: 'WHEN_REQUIRED' as const,
          responseChecksumValidation: 'WHEN_REQUIRED' as const,
        }
      : {}),
  });
}

export class S3ObjectStore implements ObjectStore {
  constructor(private readonly client: S3Client) {}

  async getObjectText(bucket: string, key: string): Promise<string> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );

    if (response.Body === undefined) {
      throw new Error(`S3 object s3://${bucket}/${key} has no body`);
    }

    // Reads the whole object into memory. Fine for the batch sizes this handles
    // today; the README covers when this needs to become a streaming read.
    return response.Body.transformToString('utf8');
  }
}
