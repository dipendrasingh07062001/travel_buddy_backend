import type {
  ObjectStorage,
  PutObjectInput,
  StorageBucket,
} from '../../src/storage/object-storage.js';

// Stands in for R2 in tests: keeps objects in memory and fakes signed URLs.
export class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, Omit<PutObjectInput, 'bucket' | 'key'>>();
  failUploads = false;

  async putObject(input: PutObjectInput): Promise<void> {
    if (this.failUploads) throw new Error('Storage unavailable');
    this.objects.set(`${input.bucket}:${input.key}`, {
      body: input.body,
      contentType: input.contentType,
      cacheControl: input.cacheControl,
    });
  }

  async deleteObject(bucket: StorageBucket, key: string): Promise<void> {
    this.objects.delete(`${bucket}:${key}`);
  }

  async signedPrivateUrl(key: string, expiresInSeconds: number) {
    return `https://signed.example/${key}?expires=${expiresInSeconds}`;
  }

  keys(bucket: StorageBucket): string[] {
    return [...this.objects.keys()]
      .filter((entry) => entry.startsWith(`${bucket}:`))
      .map((entry) => entry.slice(bucket.length + 1));
  }
}
