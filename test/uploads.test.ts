import { createHash } from 'node:crypto';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  TokenVerifier,
} from '../src/modules/auth/auth.types.js';
import {
  createR2Storage,
  publicObjectUrl,
} from '../src/storage/object-storage.js';
import { processProfilePhoto, processReceipt } from '../src/storage/uploads.js';
import { MemoryStorage } from './helpers/memory-storage.js';
import { multipartFile } from './helpers/multipart.js';

const settings = {
  accountId: '0123456789abcdef0123456789abcdef',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  publicBucket: 'travel-buddy-public',
  privateBucket: 'travel-buddy-private',
};

function recordingFetch(status = 200) {
  const requests: Request[] = [];
  const send = (async (input: RequestInfo | URL) => {
    requests.push(input as Request);
    return new Response(null, { status });
  }) as typeof fetch;
  return { requests, send };
}

function image(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: '#3366cc' },
  });
}

describe('R2 storage client', () => {
  it('signs uploads to the right bucket with the payload hash', async () => {
    const { requests, send } = recordingFetch();
    const storage = createR2Storage(settings, send);
    const body = Buffer.from('photo bytes');

    await storage.putObject({
      bucket: 'public',
      key: 'profile-photos/user 1/photo.webp',
      body,
      contentType: 'image/webp',
      cacheControl: 'public, max-age=31536000, immutable',
    });

    const request = requests[0] as Request;
    expect(request.method).toBe('PUT');
    expect(request.url).toBe(
      'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/travel-buddy-public/profile-photos/user%201/photo.webp',
    );
    expect(request.headers.get('content-type')).toBe('image/webp');
    expect(request.headers.get('x-amz-content-sha256')).toBe(
      createHash('sha256').update(body).digest('hex'),
    );
    expect(request.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=test-access-key\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[^,]*x-amz-content-sha256[^,]*, Signature=[0-9a-f]{64}$/,
    );
  });

  it('fails an upload that R2 rejects', async () => {
    const storage = createR2Storage(settings, recordingFetch(403).send);
    await expect(
      storage.putObject({
        bucket: 'private',
        key: 'receipts/a.pdf',
        body: Buffer.from('%PDF-1.7'),
        contentType: 'application/pdf',
        cacheControl: 'private, no-store',
      }),
    ).rejects.toThrow('HTTP 403');
  });

  it('treats deleting a missing object as success but surfaces other errors', async () => {
    await expect(
      createR2Storage(settings, recordingFetch(404).send).deleteObject(
        'public',
        'gone.webp',
      ),
    ).resolves.toBeUndefined();
    await expect(
      createR2Storage(settings, recordingFetch(500).send).deleteObject(
        'public',
        'gone.webp',
      ),
    ).rejects.toThrow('HTTP 500');
  });

  it('downloads objects, returning null for missing ones', async () => {
    const found = createR2Storage(
      settings,
      (async () =>
        new Response('photo bytes', { status: 200 })) as typeof fetch,
    );
    const missing = createR2Storage(settings, recordingFetch(404).send);
    const failing = createR2Storage(settings, recordingFetch(500).send);

    expect(
      Buffer.from((await found.getObject('public', 'a.webp')) ?? []).toString(),
    ).toBe('photo bytes');
    await expect(missing.getObject('public', 'a.webp')).resolves.toBeNull();
    await expect(failing.getObject('public', 'a.webp')).rejects.toThrow(
      'HTTP 500',
    );
  });

  it('creates expiring signed URLs for the private bucket only', async () => {
    const storage = createR2Storage(settings, recordingFetch().send);
    const url = new URL(
      await storage.signedPrivateUrl('receipts/trip/expense/r.webp', 900),
    );

    expect(url.pathname).toBe(
      '/travel-buddy-private/receipts/trip/expense/r.webp',
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(
      /^test-access-key\/\d{8}\/auto\/s3\/aws4_request$/,
    );
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('builds public URLs from the configured base URL', () => {
    expect(
      publicObjectUrl('profile-photos/u/p.webp', 'https://media.example/'),
    ).toBe('https://media.example/profile-photos/u/p.webp');
    expect(publicObjectUrl(null, 'https://media.example')).toBeNull();
    expect(publicObjectUrl('profile-photos/u/p.webp', undefined)).toBeNull();
  });
});

describe('image processing', () => {
  it('crops profile photos to 512x512 WebP and strips location metadata', async () => {
    const original = await image(1600, 900)
      .jpeg()
      .withExif({
        IFD0: { Copyright: 'Test camera' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '28/1 36/1 0/1' },
      })
      .toBuffer();
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const processed = await processProfilePhoto(original);
    const metadata = await sharp(processed.body).metadata();

    expect(processed.contentType).toBe('image/webp');
    expect(metadata).toMatchObject({
      format: 'webp',
      width: 512,
      height: 512,
    });
    expect(metadata.exif).toBeUndefined();
  });

  it('shrinks large receipt images but never enlarges small ones', async () => {
    const large = await processReceipt(
      await image(3000, 1500).png().toBuffer(),
    );
    const small = await processReceipt(await image(800, 600).png().toBuffer());

    expect(await sharp(large.body).metadata()).toMatchObject({
      format: 'webp',
      width: 2000,
      height: 1000,
    });
    expect(await sharp(small.body).metadata()).toMatchObject({
      width: 800,
      height: 600,
    });
  });

  it('keeps PDF receipts as they are', async () => {
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
    await expect(processReceipt(pdf)).resolves.toEqual({
      body: pdf,
      contentType: 'application/pdf',
      extension: 'pdf',
    });
  });

  it('rejects files that are not supported images', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
    );
    // A PNG header that claims 100,000 x 100,000 pixels with no image data.
    const bomb = Buffer.concat([
      Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
      Buffer.from('000186a0000186a00802000000', 'hex'),
      Buffer.from('00000000', 'hex'),
    ]);
    for (const body of [svg, bomb, Buffer.from('not an image at all')]) {
      await expect(processProfilePhoto(body)).rejects.toMatchObject({
        statusCode: 415,
        code: 'UNSUPPORTED_IMAGE',
      });
      await expect(processReceipt(body)).rejects.toMatchObject({
        statusCode: 415,
        code: 'UNSUPPORTED_RECEIPT',
      });
    }
  });
});

describe('profile photo upload validation', () => {
  const user: AuthenticatedUser = {
    id: '91000000-0000-4000-8000-000000000001',
    displayName: 'Upload Tester',
    birthDate: null,
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    profile: null,
  };
  const tokenVerifier: TokenVerifier = {
    async verify(token) {
      return { subject: token, emailVerified: false };
    },
  };
  const authRepository: AuthRepository = {
    async bootstrapFirebaseUser() {
      return { user, created: false };
    },
    async findFirebaseUser() {
      return user;
    },
  };
  const auth = { tokenVerifier, repository: authRepository };
  const storage = new MemoryStorage();
  const app = buildApp({ logger: false, auth, storage });
  const unconfigured = buildApp({ logger: false, auth, storage: null });
  const authorization = { authorization: 'Bearer upload-tester' };

  beforeAll(async () => Promise.all([app.ready(), unconfigured.ready()]));
  afterAll(async () => Promise.all([app.close(), unconfigured.close()]));

  async function upload(
    target: typeof app,
    field: string,
    content: Buffer,
    contentType = 'image/jpeg',
  ) {
    const body = multipartFile(field, content, contentType);
    return target.inject({
      method: 'PUT',
      url: '/api/v1/me/profile-photo',
      headers: { ...authorization, ...body.headers },
      payload: body.payload,
    });
  }

  it('reports that uploads are unavailable when R2 is not configured', async () => {
    const response = await upload(
      unconfigured,
      'photo',
      await image(10, 10).jpeg().toBuffer(),
    );
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('STORAGE_UNAVAILABLE');
  });

  it('requires a multipart request with the file in the photo field', async () => {
    const json = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/profile-photo',
      headers: authorization,
      payload: { photo: 'base64-is-not-accepted' },
    });
    const wrongField = await upload(
      app,
      'avatar',
      await image(10, 10).jpeg().toBuffer(),
    );

    expect(json.statusCode).toBe(415);
    expect(json.json().error.code).toBe('UPLOAD_REQUIRED');
    expect(wrongField.statusCode).toBe(400);
    expect(wrongField.json().error.code).toBe('UPLOAD_MISSING');
  });

  it('rejects files over 5 MB and files that are not images', async () => {
    const tooLarge = await upload(app, 'photo', Buffer.alloc(6 * 1024 * 1024));
    const notImage = await upload(
      app,
      'photo',
      Buffer.from('%PDF-1.7'),
      'image/jpeg',
    );

    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error.code).toBe('UPLOAD_TOO_LARGE');
    expect(notImage.statusCode).toBe(415);
    expect(notImage.json().error.code).toBe('UNSUPPORTED_IMAGE');
    expect(storage.objects.size).toBe(0);
  });
});
