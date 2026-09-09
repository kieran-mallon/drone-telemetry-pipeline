/**
 * The object storage port.
 *
 * `getObjectText` returns the whole object as a string, which is the honest
 * signature for the current implementation and its main limitation: it assumes
 * a batch file fits comfortably in the processor's memory. The README covers
 * where the streaming version would go and why it is not here yet.
 */
export interface ObjectStore {
  getObjectText(bucket: string, key: string): Promise<string>;
}
