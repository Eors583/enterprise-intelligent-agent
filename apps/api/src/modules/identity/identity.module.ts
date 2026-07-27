import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../config/environment.js';
import { IdentityService } from './application/identity.service.js';
import { IdentityRepository } from './domain/identity.repository.js';
import { DevIdentityRepository } from './infrastructure/dev/dev-identity.repository.js';
import { PrismaIdentityRepository } from './infrastructure/prisma/prisma-identity.repository.js';

@Module({
  providers: [
    IdentityService,
    DevIdentityRepository,
    PrismaIdentityRepository,
    {
      provide: IdentityRepository,
      inject: [ConfigService, DevIdentityRepository, PrismaIdentityRepository],
      useFactory: (
        config: ConfigService<EnvironmentVariables, true>,
        memory: DevIdentityRepository,
        prisma: PrismaIdentityRepository,
      ): IdentityRepository =>
        config.get('REPOSITORY_DRIVER', { infer: true }) === 'prisma' ? prisma : memory,
    },
  ],
  exports: [IdentityService, IdentityRepository],
})
export class IdentityModule {}
