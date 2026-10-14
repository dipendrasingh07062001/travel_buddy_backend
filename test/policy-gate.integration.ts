import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';
import type { PolicyCatalog } from '../src/modules/policies/policy.service.js';
import { multipartFile } from './helpers/multipart.js';

const run = randomUUID();
const roles = ['owner', 'joiner', 'newcomer'] as const;
type Role = (typeof roles)[number];
const userIds = {} as Record<Role, string>;
const communityId = randomUUID();
let tripId = '';

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return {
      subject: `policy-gate-${token}-${run}`,
      displayName: `Policy ${token}`,
      emailVerified: false,
    };
  },
};
const catalog = {
  TERMS: { version: '2026-10', url: 'https://example.org/terms' },
  PRIVACY: { version: '2026-10', url: 'https://example.org/privacy' },
  COMMUNITY_STANDARDS: {
    version: '2026-10',
    url: 'https://example.org/community-standards',
  },
} satisfies NonNullable<PolicyCatalog>;
const app = buildApp({
  logger: false,
  auth: { tokenVerifier },
  policyCatalog: catalog,
  storage: null,
});
const updatedTermsApp = buildApp({
  logger: false,
  auth: { tokenVerifier },
  policyCatalog: {
    ...catalog,
    TERMS: { ...catalog.TERMS, version: '2027-01' },
  },
});

function api(
  method: 'GET' | 'POST',
  url: string,
  role: Role,
  payload?: object,
  target = app,
) {
  return target.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${role}` },
    ...(payload && { payload }),
  });
}

async function accept(
  role: Role,
  policyTypes: (keyof typeof catalog)[],
  target = app,
  versions: Partial<Record<keyof typeof catalog, string>> = {},
) {
  for (const policyType of policyTypes) {
    const response = await api(
      'POST',
      '/me/policy-acceptances',
      role,
      {
        policyType,
        version: versions[policyType] ?? catalog[policyType].version,
        accepted: true,
      },
      target,
    );
    expect(response.statusCode).toBe(200);
  }
}

const publish = (target = app) =>
  api(
    'POST',
    `/trips/${tripId}/publish`,
    'owner',
    { expectedVersion: 1 },
    target,
  );

function expectGate(
  response: Awaited<ReturnType<typeof api>>,
  missing: string[],
) {
  expect(response.statusCode).toBe(409);
  expect(response.json().error.code).toBe('POLICY_ACCEPTANCE_REQUIRED');
  for (const name of missing) {
    expect(response.json().error.message).toContain(name);
  }
}

beforeAll(async () => {
  await database.community.create({
    data: {
      id: communityId,
      slug: `policy-gate-${communityId}`,
      name: 'Policy Gate Community',
      region: 'Himachal Pradesh',
    },
  });
  await Promise.all([app.ready(), updatedTermsApp.ready()]);
  for (const role of roles) {
    const response = await api('POST', '/auth/bootstrap', role);
    userIds[role] = response.json().data.id as string;
    await database.user.update({
      where: { id: userIds[role] },
      data: {
        birthDate: new Date('1995-05-20T00:00:00.000Z'),
        profile: {
          create: {
            homeCity: 'Delhi',
            biography: 'Integration profile for the policy gate.',
            languages: ['english'],
          },
        },
      },
    });
  }
});

afterAll(async () => {
  await Promise.all([app.close(), updatedTermsApp.close()]);
  await database.trip.deleteMany({ where: { id: tripId } });
  await database.communityPost.deleteMany({ where: { communityId } });
  await database.community.deleteMany({ where: { id: communityId } });
  const ids = Object.values(userIds);
  await database.policyAcceptance.deleteMany({
    where: { userId: { in: ids } },
  });
  await database.user.deleteMany({ where: { id: { in: ids } } });
  await database.$disconnect();
});

describe('policy acceptance gate', () => {
  it('lets a user draft a trip but not publish it until every policy is accepted', async () => {
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const created = await api('POST', '/trips', 'owner', {
      communityId,
      originCity: 'Delhi',
      startDate: day(30),
      endDate: day(35),
      currentGroupSize: 1,
      desiredGroupSize: 4,
      transport: 'BUS',
      description: 'Draft trip for the policy acceptance gate test.',
    });
    expect(created.statusCode).toBe(201);
    tripId = created.json().data.id as string;

    expectGate(await publish(), [
      'Terms of Service',
      'Privacy Notice',
      'Community Standards',
    ]);

    await accept('owner', ['TERMS', 'PRIVACY']);
    const partly = await publish();
    expectGate(partly, ['Community Standards']);
    expect(partly.json().error.message).not.toContain('Terms of Service');

    await accept('owner', ['COMMUNITY_STANDARDS']);
    expect((await publish()).statusCode).toBe(200);
  });

  it('lets anyone browse, but requires acceptance to ask to join or post', async () => {
    expect((await api('GET', '/trips', 'joiner')).statusCode).toBe(200);

    const join = () =>
      api('POST', `/trips/${tripId}/connection-requests`, 'joiner', {
        message: 'I would like to join this trip on these dates.',
      });
    expectGate(await join(), ['Terms of Service']);
    const post = () =>
      api('POST', `/communities/${communityId}/posts`, 'joiner', {
        type: 'QUESTION',
        title: 'Road conditions question',
        body: 'Which road conditions should travellers prepare for this month?',
      });
    expectGate(await post(), ['Community Standards']);

    await accept('joiner', ['TERMS', 'PRIVACY', 'COMMUNITY_STANDARDS']);
    expect((await join()).statusCode).toBe(201);
    expect((await post()).statusCode).toBe(201);
  });

  it('checks acceptance before handling an uploaded photo', async () => {
    const body = multipartFile(
      'photo',
      Buffer.from('not checked'),
      'image/jpeg',
    );
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/profile-photo',
      headers: { authorization: 'Bearer newcomer', ...body.headers },
      payload: body.payload,
    });
    expectGate(response, ['Terms of Service']);
  });

  it('asks again for a policy whose version changed', async () => {
    const request = await database.connectionRequest.findFirstOrThrow({
      where: { tripId, requesterId: userIds.joiner },
    });
    const accepted = await api(
      'POST',
      `/connection-requests/${request.id}/accept`,
      'owner',
    );
    expect(accepted.statusCode).toBe(200);

    const sent = await api(
      'POST',
      `/trips/${tripId}/messages`,
      'owner',
      { body: 'Welcome to the trip room.' },
      updatedTermsApp,
    );
    expectGate(sent, ['Terms of Service']);
    expect(sent.json().error.message).not.toContain('Privacy Notice');

    await accept('owner', ['TERMS'], updatedTermsApp, { TERMS: '2027-01' });
    const retried = await api(
      'POST',
      `/trips/${tripId}/messages`,
      'owner',
      { body: 'Welcome to the trip room.' },
      updatedTermsApp,
    );
    expect(retried.statusCode).toBe(201);
  });
});
