import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../config/environment.js';
import { DirectoryService } from './application/directory.service.js';
import { DirectoryRepository } from './domain/directory.repository.js';
import { DevDirectoryRepository } from './infrastructure/dev/dev-directory.repository.js';
import { PrismaDirectoryRepository } from './infrastructure/prisma/prisma-directory.repository.js';

@Module({
  providers: [
    DirectoryService,
    DevDirectoryRepository,
    PrismaDirectoryRepository,
    {
      provide: DirectoryRepository,
      inject: [ConfigService, DevDirectoryRepository, PrismaDirectoryRepository],
      useFactory: (
        config: ConfigService<EnvironmentVariables, true>,
        memory: DevDirectoryRepository,
        prisma: PrismaDirectoryRepository,
      ): DirectoryRepository =>
        config.get('REPOSITORY_DRIVER', { infer: true }) === 'prisma' ? prisma : memory,
    },
  ],
  exports: [DirectoryService, DirectoryRepository],
})
export class DirectoryModule {}
