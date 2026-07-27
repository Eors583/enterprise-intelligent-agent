import { PrismaClient } from '@prisma/client';

import { PasswordHasher } from '../src/modules/auth/application/password-hasher.js';

const prisma = new PrismaClient();

const ids = {
  tenant: '00000000-0000-7000-8000-000000000001',
  organization: '00000000-0000-7000-8000-000000000401',
  users: [
    '00000000-0000-7000-8000-000000000101',
    '00000000-0000-7000-8000-000000000102',
    '00000000-0000-7000-8000-000000000103',
  ],
  departments: [
    '00000000-0000-7000-8000-000000000201',
    '00000000-0000-7000-8000-000000000202',
    '00000000-0000-7000-8000-000000000203',
  ],
  positions: [
    '00000000-0000-7000-8000-000000000501',
    '00000000-0000-7000-8000-000000000502',
    '00000000-0000-7000-8000-000000000503',
  ],
  employments: [
    '00000000-0000-7000-8000-000000000601',
    '00000000-0000-7000-8000-000000000602',
    '00000000-0000-7000-8000-000000000603',
  ],
  agentTemplate: '00000000-0000-7000-8000-000000000701',
  agentVersion: '00000000-0000-7000-8000-000000000702',
  agents: ['00000000-0000-7000-8000-000000000301', '00000000-0000-7000-8000-000000000302'],
} as const;

async function seed(): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    // Provisioning is deliberately separate from the read-mostly API role.
    // The migration login may SET this NOLOGIN/NOBYPASSRLS role; API logins must not.
    await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_provisioner');
    await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${ids.tenant}, true)`;

    await transaction.tenant.upsert({
      where: { id: ids.tenant },
      update: { name: '未来协作科技', status: 'ACTIVE' },
      create: {
        id: ids.tenant,
        slug: 'future-collaboration',
        name: '未来协作科技',
        status: 'ACTIVE',
      },
    });

    const users = [
      {
        id: ids.users[0],
        email: 'lin.xiao@example.local',
        role: 'OWNER',
        displayName: '林晓',
        avatarUrl: 'https://api.dicebear.com/9.x/initials/svg?seed=LX',
      },
      {
        id: ids.users[1],
        email: 'zhou.rui@example.local',
        role: 'ADMIN',
        displayName: '周睿',
        avatarUrl: 'https://api.dicebear.com/9.x/initials/svg?seed=ZR',
      },
      {
        id: ids.users[2],
        email: 'chen.yao@example.local',
        role: 'MEMBER',
        displayName: '陈瑶',
        avatarUrl: null,
      },
    ] as const;
    for (const user of users) {
      await transaction.user.upsert({
        where: { id: user.id },
        update: {
          email: user.email,
          emailNormalized: user.email,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          role: user.role,
          status: 'ACTIVE',
        },
        create: {
          ...user,
          tenantId: ids.tenant,
          emailNormalized: user.email,
          status: 'ACTIVE',
        },
      });
    }

    await transaction.organization.upsert({
      where: { id: ids.organization },
      update: { name: '未来协作科技有限公司' },
      create: {
        id: ids.organization,
        tenantId: ids.tenant,
        externalKey: 'future-collaboration',
        name: '未来协作科技有限公司',
        countryCode: 'CN',
      },
    });

    const departmentNames = ['产品中心', '研发中心', '组织与人才'] as const;
    const positionNames = ['产品负责人', '后端工程师', '人力资源伙伴'] as const;
    for (const [index, departmentId] of ids.departments.entries()) {
      const departmentName = departmentNames[index]!;
      const positionId = ids.positions[index]!;
      const positionName = positionNames[index]!;
      const employmentId = ids.employments[index]!;
      const userId = ids.users[index]!;
      const user = users[index]!;
      await transaction.orgUnit.upsert({
        where: { id: departmentId },
        update: { name: departmentName, sortOrder: index },
        create: {
          id: departmentId,
          tenantId: ids.tenant,
          organizationId: ids.organization,
          externalKey: `department-${index + 1}`,
          name: departmentName,
          sortOrder: index,
        },
      });
      await transaction.position.upsert({
        where: { id: positionId },
        update: { name: positionName },
        create: {
          id: positionId,
          tenantId: ids.tenant,
          organizationId: ids.organization,
          orgUnitId: departmentId,
          code: `POSITION_${index + 1}`,
          name: positionName,
        },
      });
      await transaction.employment.upsert({
        where: { id: employmentId },
        update: {
          orgUnitId: departmentId,
          positionId,
          status: 'ACTIVE',
          isPrimary: true,
        },
        create: {
          id: employmentId,
          tenantId: ids.tenant,
          userId,
          organizationId: ids.organization,
          orgUnitId: departmentId,
          positionId,
          employeeNumber: `E${String(index + 1).padStart(4, '0')}`,
          workEmail: user.email,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          isPrimary: true,
        },
      });
    }

    await transaction.agentTemplate.upsert({
      where: { id: ids.agentTemplate },
      update: { name: '个人工作助手' },
      create: {
        id: ids.agentTemplate,
        tenantId: ids.tenant,
        key: 'personal-work-assistant',
        name: '个人工作助手',
        description: '企业成员的个人工作代理模板。',
      },
    });
    await transaction.agentVersion.upsert({
      where: { id: ids.agentVersion },
      update: { status: 'PUBLISHED' },
      create: {
        id: ids.agentVersion,
        tenantId: ids.tenant,
        templateId: ids.agentTemplate,
        version: 1,
        status: 'PUBLISHED',
        systemPrompt: '仅在租户权限和用户授权范围内协助处理工作。',
        modelPolicy: { route: 'default' },
        toolPolicy: { allow: [] },
        knowledgeScope: { mode: 'owner-authorized' },
        publishedAt: new Date(),
      },
    });

    const agents = [
      {
        id: ids.agents[0],
        key: 'lin-xiao-assistant',
        ownerUserId: ids.users[0],
        name: '林晓的产品助手',
        summary: '可协助查询产品路线、需求背景和会议结论。',
      },
      {
        id: ids.agents[1],
        key: 'zhou-rui-assistant',
        ownerUserId: ids.users[1],
        name: '周睿的研发助手',
        summary: '可协助定位系统模块、接口约定和研发进度。',
      },
    ] as const;
    for (const agent of agents) {
      await transaction.agentInstance.upsert({
        where: { id: agent.id },
        update: {
          name: agent.name,
          summary: agent.summary,
          status: 'ONLINE',
          settings: { visibility: 'tenant' },
        },
        create: {
          ...agent,
          tenantId: ids.tenant,
          versionId: ids.agentVersion,
          createdById: ids.users[0],
          status: 'ONLINE',
          settings: { visibility: 'tenant' },
        },
      });
    }
  });

  const passwordHasher = new PasswordHasher();
  const developmentPassword = 'DevPassword!2026';
  const passwordHashes = await Promise.all(
    ids.users.map(() => passwordHasher.hash(developmentPassword)),
  );
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_auth');
    for (const [index, userId] of ids.users.entries()) {
      await transaction.passwordCredential.upsert({
        where: { userId },
        update: { passwordHash: passwordHashes[index]! },
        create: {
          tenantId: ids.tenant,
          userId,
          passwordHash: passwordHashes[index]!,
        },
      });
    }
  });
}

seed()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
