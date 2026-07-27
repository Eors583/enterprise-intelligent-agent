import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service.js';
import { AdminPrismaService } from './admin-prisma.service.js';
import { AuthPrismaService } from './auth-prisma.service.js';
import { OutboxPrismaService } from './outbox-prisma.service.js';

@Global()
@Module({
  providers: [PrismaService, AuthPrismaService, AdminPrismaService, OutboxPrismaService],
  exports: [PrismaService, AuthPrismaService, AdminPrismaService, OutboxPrismaService],
})
export class PrismaModule {}
