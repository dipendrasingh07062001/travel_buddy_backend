import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const demoUserId = '10000000-0000-4000-8000-000000000001';

async function main(): Promise<void> {
  await prisma.user.upsert({
    where: { id: demoUserId },
    update: { displayName: 'Aarav Sharma', status: 'ACTIVE' },
    create: {
      id: demoUserId,
      displayName: 'Aarav Sharma',
      status: 'ACTIVE',
    },
  });
  await prisma.userProfile.upsert({
    where: { userId: demoUserId },
    update: { communityActivityVisibility: 'PUBLIC' },
    create: {
      userId: demoUserId,
      homeCity: 'Delhi',
      homeRegion: 'Delhi NCR',
      biography: 'Weekend traveller interested in mountain trips and hiking.',
      languages: ['English', 'Hindi'],
      travelInterests: ['mountains', 'hiking', 'road trips'],
      communityActivityVisibility: 'PUBLIC',
    },
  });

  const communities = [
    {
      id: '20000000-0000-4000-8000-000000000001',
      slug: 'manali',
      name: 'Manali',
      region: 'Himachal Pradesh',
      description: 'Mountain adventures and scenic valleys around Manali.',
    },
    {
      id: '20000000-0000-4000-8000-000000000002',
      slug: 'spiti-valley',
      name: 'Spiti Valley',
      region: 'Himachal Pradesh',
      description: 'High-altitude road trips through the Spiti Valley.',
    },
    {
      id: '20000000-0000-4000-8000-000000000003',
      slug: 'ladakh',
      name: 'Ladakh',
      region: 'Ladakh',
      description: 'Road trips, lakes, monasteries, and mountain passes.',
    },
  ];

  for (const community of communities) {
    await prisma.community.upsert({
      where: { slug: community.slug },
      update: community,
      create: community,
    });
  }

  await prisma.communityFollow.upsert({
    where: {
      communityId_userId: {
        communityId: communities[0].id,
        userId: demoUserId,
      },
    },
    update: {},
    create: { communityId: communities[0].id, userId: demoUserId },
  });

  const communityPosts = [
    {
      id: '60000000-0000-4000-8000-000000000001',
      communityId: communities[0].id,
      type: 'QUESTION' as const,
      title: 'Best local transport around Manali',
      body: 'What are the practical local transport options for Solang Valley and nearby villages?',
      publishedAt: new Date('2026-09-18T09:00:00.000Z'),
    },
    {
      id: '60000000-0000-4000-8000-000000000002',
      communityId: communities[1].id,
      type: 'DISCUSSION' as const,
      title: 'Preparing for the October road conditions',
      body: 'Share factual route and weather preparation tips for an October self-drive trip.',
      publishedAt: new Date('2026-09-17T09:00:00.000Z'),
    },
  ];

  for (const post of communityPosts) {
    await prisma.communityPost.upsert({
      where: { id: post.id },
      update: {
        ...post,
        authorId: demoUserId,
        status: 'PUBLISHED',
      },
      create: {
        ...post,
        authorId: demoUserId,
        status: 'PUBLISHED',
      },
    });
  }

  await prisma.communityComment.upsert({
    where: { id: '70000000-0000-4000-8000-000000000001' },
    update: {
      body: 'Local buses and shared taxis are common; confirm current routes before travelling.',
      status: 'ACTIVE',
      removedAt: null,
    },
    create: {
      id: '70000000-0000-4000-8000-000000000001',
      postId: '60000000-0000-4000-8000-000000000001',
      authorId: demoUserId,
      body: 'Local buses and shared taxis are common; confirm current routes before travelling.',
    },
  });

  const trips = [
    {
      id: '30000000-0000-4000-8000-000000000001',
      communityId: communities[0].id,
      originCity: 'Delhi',
      startDate: new Date('2026-10-10T00:00:00.000Z'),
      endDate: new Date('2026-10-15T00:00:00.000Z'),
      flexibilityDays: 2,
      durationDays: 6,
      budgetMin: 12000,
      budgetMax: 18000,
      currentGroupSize: 2,
      desiredGroupSize: 5,
      transport: 'BUS' as const,
      description:
        'A relaxed Manali trip with local hikes, cafes, and a day near Solang Valley.',
      status: 'PUBLISHED' as const,
      publishedAt: new Date('2026-09-15T09:00:00.000Z'),
    },
    {
      id: '30000000-0000-4000-8000-000000000002',
      communityId: communities[1].id,
      originCity: 'Chandigarh',
      startDate: new Date('2026-10-20T00:00:00.000Z'),
      endDate: new Date('2026-10-28T00:00:00.000Z'),
      flexibilityDays: 1,
      durationDays: 9,
      budgetMin: 25000,
      budgetMax: 35000,
      currentGroupSize: 4,
      desiredGroupSize: 4,
      transport: 'CAR' as const,
      description:
        'A full self-drive group covering Kaza, Key Monastery, and nearby villages.',
      status: 'FULL' as const,
      publishedAt: new Date('2026-09-14T09:00:00.000Z'),
    },
    {
      id: '30000000-0000-4000-8000-000000000003',
      communityId: communities[2].id,
      originCity: 'Delhi',
      startDate: new Date('2026-11-05T00:00:00.000Z'),
      endDate: new Date('2026-11-14T00:00:00.000Z'),
      flexibilityDays: 3,
      durationDays: 10,
      budgetMin: 30000,
      budgetMax: 45000,
      currentGroupSize: 1,
      desiredGroupSize: 6,
      transport: 'MOTORCYCLE' as const,
      description:
        'Draft Ladakh itinerary kept private for API visibility tests.',
      status: 'DRAFT' as const,
      publishedAt: null,
    },
  ];

  for (const trip of trips) {
    await prisma.trip.upsert({
      where: { id: trip.id },
      update: { ...trip, ownerId: demoUserId },
      create: { ...trip, ownerId: demoUserId },
    });
    await prisma.tripMembership.upsert({
      where: {
        tripId_userId: { tripId: trip.id, userId: demoUserId },
      },
      update: { role: 'OWNER', status: 'ACTIVE' },
      create: {
        tripId: trip.id,
        userId: demoUserId,
        role: 'OWNER',
      },
    });
    const conversation = await prisma.conversation.upsert({
      where: { tripId: trip.id },
      update: {},
      create: { tripId: trip.id },
    });
    await prisma.conversationParticipant.upsert({
      where: {
        conversationId_userId: {
          conversationId: conversation.id,
          userId: demoUserId,
        },
      },
      update: {},
      create: { conversationId: conversation.id, userId: demoUserId },
    });
  }
}

main()
  .then(() => console.log('Seed data is ready.'))
  .catch((error: unknown) => {
    console.error('Seeding failed.', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
