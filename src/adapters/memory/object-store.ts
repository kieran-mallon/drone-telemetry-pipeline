import type { ObjectStore } from '../../ports/object-store.js';

/** An in-memory ObjectStore for tests. */
export class InMemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, string>();
  private pendingFailure: Error | undefined;

  put(bucket: string, key: string, body: string): void {
    this.objects.set(`${bucket}/${key}`, body);
  }

  /** The next read throws this, then the failure clears. */
  failNextWith(error: Error): void {
    this.pendingFailure = error;
  }

  async getObjectText(bucket: string, key: string): Promise<string> {
    if (this.pendingFailure !== undefined) {
      const error = this.pendingFailure;
      this.pendingFailure = undefined;
      throw error;
    }

    const body = this.objects.get(`${bucket}/${key}`);
    if (body === undefined) {
      throw new Error(`NoSuchKey: s3://${bucket}/${key}`);
    }
    return body;
  }
}
