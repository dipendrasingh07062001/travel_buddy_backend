import { randomUUID } from 'node:crypto';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';
import { MemoryStorage } from './helpers/memory-storage.js';
import { multipartFile } from './helpers/multipart.js';

const run = randomUUID();
const roles = ['owner', 'member', 'outsider'] as const;
type Role = (typeof roles)[number];
const userIds = {} as Record<Role, string>;
const communityId = randomUUID();
const tripId = randomUUID();
const ownerExpenseId = randomUUID();
const memberPaidExpenseId = randomUUID();

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return { subject: `uploads-${token}-${run}`, emailVerified: false };
  },
};
const storage = new MemoryStorage();
const app = buildApp({ logger: false, auth: { tokenVerifier }, storage });

const jpeg = (width = 1200, height = 900) =>
  sharp({ create: { width, height, channels: 3, background: '#cc6633' } })
    .jpeg()
    .toBuffer();
const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  role: Role,
  file?: { field: string; content: Buffer; contentType: string },
) {
  const body = file
    ? multipartFile(file.field, file.content, file.contentType)
    : undefined;
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${role}`, ...body?.headers },
    ...(body && { payload: body.payload }),
  });
}

const uploadPhoto = async (role: Role) =>
  send('PUT', '/me/profile-photo', role, {
    field: 'photo',
    content: await jpeg(),
    contentType: 'image/jpeg',
  });

const uploadReceipt = (
  role: Role,
  expenseId: string,
  content: Buffer,
  contentType = 'image/jpeg',
) =>
  send('POST', `/expenses/${expenseId}/receipts`, role, {
    field: 'receipt',
    content,
    contentType,
  });

const photoKey = async (role: Role) =>
  (
    await database.userProfile.findUnique({
      where: { userId: userIds[role] },
      select: { profilePhotoStorageKey: true },
    })
  )?.profilePhotoStorageKey ?? null;

beforeAll(async () => {
  await app.ready();
  for (const role of roles) {
    const response = await send('POST', '/auth/bootstrap', role);
    userIds[role] = response.json().data.id as string;
  }
  await database.community.create({
    data: {
      id: communityId,
      slug: `uploads-${communityId}`,
      name: 'Uploads Community',
    },
  });
  await database.trip.create({
    data: {
      id: tripId,
      ownerId: userIds.owner,
      communityId,
      originCity: 'Delhi',
      startDate: new Date('2027-03-01T00:00:00.000Z'),
      endDate: new Date('2027-03-05T00:00:00.000Z'),
      durationDays: 5,
      currentGroupSize: 2,
      desiredGroupSize: 4,
      description: 'Trip for upload integration testing.',
      status: 'PUBLISHED',
      publishedAt: new Date(),
      memberships: {
        create: [
          { userId: userIds.owner, role: 'OWNER' },
          { userId: userIds.member, role: 'MEMBER' },
        ],
      },
    },
  });
  for (const [id, paidBy] of [
    [ownerExpenseId, userIds.owner],
    [memberPaidExpenseId, userIds.member],
  ] as const) {
    await database.expense.create({
      data: {
        id,
        tripId,
        createdById: userIds.owner,
        paidById: paidBy,
        description: 'Hotel',
        category: 'ACCOMMODATION',
        amountPaise: 200_000,
        splitMethod: 'EQUAL',
        expenseDate: new Date('2027-03-01T00:00:00.000Z'),
        shares: {
          create: [
            { userId: userIds.owner, amountPaise: 100_000 },
            { userId: userIds.member, amountPaise: 100_000 },
          ],
        },
      },
    });
  }
});

afterAll(async () => {
  await app.close();
  await database.trip.deleteMany({ where: { id: tripId } });
  await database.community.deleteMany({ where: { id: communityId } });
  await database.user.deleteMany({
    where: { id: { in: Object.values(userIds) } },
  });
  await database.$disconnect();
});

describe('profile photos', () => {
  it('stores a processed photo and reports it on the profile', async () => {
    const response = await uploadPhoto('owner');

    expect(response.statusCode).toBe(200);
    expect(response.json().data.profile).toMatchObject({
      profilePhotoAvailable: true,
    });
    const key = await photoKey('owner');
    expect(key).toMatch(
      new RegExp(`^profile-photos/${userIds.owner}/[0-9a-f-]{36}\\.webp$`),
    );
    const stored = storage.objects.get(`public:${key}`);
    expect(stored?.contentType).toBe('image/webp');
    expect(
      await sharp(Buffer.from(stored?.body ?? [])).metadata(),
    ).toMatchObject({ format: 'webp', width: 512, height: 512 });

    const publicProfile = await send(
      'GET',
      `/users/${userIds.owner}`,
      'outsider',
    );
    expect(publicProfile.json().data).toMatchObject({
      profilePhotoAvailable: true,
    });
  });

  it('deletes the previous file when the photo is replaced', async () => {
    const previous = await photoKey('owner');
    const response = await uploadPhoto('owner');
    const current = await photoKey('owner');

    expect(response.statusCode).toBe(200);
    expect(current).not.toBe(previous);
    expect(storage.keys('public')).toContain(current);
    expect(storage.keys('public')).not.toContain(previous);
  });

  it('keeps the current photo when storage fails', async () => {
    const before = await photoKey('owner');
    storage.failUploads = true;
    try {
      const response = await uploadPhoto('owner');
      expect(response.statusCode).toBe(500);
    } finally {
      storage.failUploads = false;
    }
    expect(await photoKey('owner')).toBe(before);
  });

  it('removes the photo and its file', async () => {
    const previous = await photoKey('owner');
    const response = await send('DELETE', '/me/profile-photo', 'owner');

    expect(response.statusCode).toBe(200);
    expect(response.json().data.profile.profilePhotoAvailable).toBe(false);
    expect(await photoKey('owner')).toBeNull();
    expect(storage.keys('public')).not.toContain(previous);
  });
});

describe('expense receipts', () => {
  it('lets the recorder attach an image receipt and members download it', async () => {
    const uploaded = await uploadReceipt('owner', ownerExpenseId, await jpeg());

    expect(uploaded.statusCode).toBe(201);
    const receipt = uploaded.json().data;
    expect(receipt).toMatchObject({
      expenseId: ownerExpenseId,
      contentType: 'image/webp',
      uploadedBy: { id: userIds.owner },
    });
    expect(receipt.url).toMatch(
      new RegExp(
        `^https://signed\\.example/receipts/${tripId}/${ownerExpenseId}/[0-9a-f-]{36}\\.webp\\?expires=900$`,
      ),
    );
    expect(Date.parse(receipt.urlExpiresAt)).toBeGreaterThan(Date.now());

    const listed = await send(
      'GET',
      `/expenses/${ownerExpenseId}/receipts`,
      'member',
    );
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data.map((item: { id: string }) => item.id)).toEqual([
      receipt.id,
    ]);
  });

  it('lets the payer attach a PDF receipt', async () => {
    const uploaded = await uploadReceipt(
      'member',
      memberPaidExpenseId,
      pdf,
      'application/pdf',
    );
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().data.contentType).toBe('application/pdf');
  });

  it('refuses other members and outsiders without storing anything', async () => {
    const before = storage.keys('private').length;
    const member = await uploadReceipt('member', ownerExpenseId, await jpeg());
    const outsider = await uploadReceipt(
      'outsider',
      ownerExpenseId,
      await jpeg(),
    );
    const outsiderList = await send(
      'GET',
      `/expenses/${ownerExpenseId}/receipts`,
      'outsider',
    );

    expect(member.statusCode).toBe(403);
    expect(member.json().error.code).toBe('RECEIPT_FORBIDDEN');
    expect(outsider.statusCode).toBe(404);
    expect(outsider.json().error.code).toBe('EXPENSE_NOT_FOUND');
    expect(outsiderList.statusCode).toBe(404);
    expect(storage.keys('private')).toHaveLength(before);
  });

  it('allows at most five receipts per expense and cleans up a rejected file', async () => {
    for (let index = 0; index < 4; index += 1) {
      const response = await uploadReceipt(
        'owner',
        ownerExpenseId,
        await jpeg(),
      );
      expect(response.statusCode).toBe(201);
    }
    const before = storage.keys('private').length;
    const sixth = await uploadReceipt('owner', ownerExpenseId, await jpeg());

    expect(sixth.statusCode).toBe(409);
    expect(sixth.json().error.code).toBe('RECEIPT_LIMIT_REACHED');
    expect(storage.keys('private')).toHaveLength(before);
  });

  it('removes a receipt file but keeps the audit record', async () => {
    const listed = await send(
      'GET',
      `/expenses/${ownerExpenseId}/receipts`,
      'owner',
    );
    const receiptId = listed.json().data[0].id as string;
    const row = await database.expenseReceipt.findUniqueOrThrow({
      where: { id: receiptId },
    });

    const byMember = await send(
      'DELETE',
      `/expense-receipts/${receiptId}`,
      'member',
    );
    expect(byMember.statusCode).toBe(403);

    const byOwner = await send(
      'DELETE',
      `/expense-receipts/${receiptId}`,
      'owner',
    );
    expect(byOwner.statusCode).toBe(204);
    expect(storage.keys('private')).not.toContain(row.storageKey);
    expect(
      await database.expenseReceipt.findUniqueOrThrow({
        where: { id: receiptId },
      }),
    ).toMatchObject({ removedById: userIds.owner });
    const remaining = await send(
      'GET',
      `/expenses/${ownerExpenseId}/receipts`,
      'owner',
    );
    expect(remaining.json().data).toHaveLength(4);
  });

  it('rejects receipts for voided expenses and read-only ledgers', async () => {
    await database.expense.update({
      where: { id: memberPaidExpenseId },
      data: { status: 'VOIDED', voidedAt: new Date() },
    });
    const voided = await uploadReceipt('member', memberPaidExpenseId, pdf);
    expect(voided.statusCode).toBe(409);
    expect(voided.json().error.code).toBe('EXPENSE_VOIDED');

    await database.trip.update({
      where: { id: tripId },
      data: { status: 'COMPLETED' },
    });
    try {
      const readOnly = await uploadReceipt('owner', ownerExpenseId, pdf);
      expect(readOnly.statusCode).toBe(409);
      expect(readOnly.json().error.code).toBe('EXPENSE_LEDGER_READ_ONLY');
    } finally {
      await database.trip.update({
        where: { id: tripId },
        data: { status: 'PUBLISHED' },
      });
    }
  });

  it('includes uploaded receipts, without links, in the data export', async () => {
    const response = await send('POST', '/me/data-export', 'owner');
    const receipts = response.json().activity.expenseReceipts as {
      removedAt: string | null;
    }[];

    expect(receipts).toHaveLength(5);
    expect(receipts.filter((item) => item.removedAt !== null)).toHaveLength(1);
    expect(response.body).not.toContain('signed.example');
  });
});
