import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service.js';
import { AdminPrismaService } from './admin-prisma.service.js';
import { AuthPrismaService } from './auth-prisma.service.js';
import { LifecyclePrismaService } from './lifecycle-prisma.service.js';
import { OutboxPrismaService } from './outbox-prisma.service.js';
import { ScimPrismaService } from './scim-prisma.service.js';

@Global()
@Module({
  providers: [
    PrismaService,
    AuthPrismaService,
    AdminPrismaService,
    LifecyclePrismaService,
    OutboxPrismaService,
    ScimPrismaService,
  ],
  exports: [
    PrismaService,
    AuthPrismaService,
    AdminPrismaService,
    LifecyclePrismaService,
    OutboxPrismaService,
    ScimPrismaService,
  ],
})
export class PrismaModule {}
