import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

import type { Config } from '../../config.js';
import type { ObjectStore } from '../../ports/object-store.js';

export function createS3Client(config: Config): S3Client {
  return new S3Client({
    region: config.awsRegion,
    // Present for LocalStack, absent in a real deployment. Path-style addressing
    // is required because LocalStack does not serve virtual-host-style buckets
    // on localhost.
    ...(config.awsEndpointUrl !== undefined
      ? { endpoint: config.awsEndpointUrl, forcePathStyle: true }
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
