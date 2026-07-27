import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../config/environment.js';
import { ImOutboxWorker } from './application/im-outbox.worker.js';
import { ImDeliveryProvider } from './domain/im-delivery.provider.js';
import { OutboxDeliveryRepository } from './domain/outbox-delivery.repository.js';
import { LocalImDeliveryProvider } from './infrastructure/local/local-im-delivery.provider.js';
import { PrismaOutboxDeliveryRepository } from './infrastructure/prisma/prisma-outbox-delivery.repository.js';
import { TencentImDeliveryProvider } from './infrastructure/tencent/index.js';

@Module({
  providers: [
    ImOutboxWorker,
    LocalImDeliveryProvider,
    PrismaOutboxDeliveryRepository,
    {
      provide: ImDeliveryProvider,
      inject: [ConfigService, LocalImDeliveryProvider],
      useFactory: (
        config: ConfigService<EnvironmentVariables, true>,
        localProvider: LocalImDeliveryProvider,
      ): ImDeliveryProvider => {
        if (config.get('IM_PROVIDER', { infer: true }) === 'local') return localProvider;

        const sdkAppId = config.get('TENCENT_IM_SDK_APP_ID', { infer: true });
        const administratorUserId = config.get('TENCENT_IM_ADMIN_USER_ID', { infer: true });
        const secretKey = config.get('TENCENT_IM_SECRET_KEY', { infer: true });
        if (
          sdkAppId === undefined ||
          administratorUserId === undefined ||
          secretKey === undefined
        ) {
          throw new Error('Tencent IM provider configuration is incomplete.');
        }

        return new TencentImDeliveryProvider({
          sdkAppId,
          administratorUserId,
          secretKey,
          endpoint: config.get('TENCENT_IM_API_BASE_URL', { infer: true }),
          userSigTtlSeconds: config.get('TENCENT_IM_USER_SIG_TTL_SECONDS', { infer: true }),
          requestTimeoutMs: config.get('TENCENT_IM_HTTP_TIMEOUT_MS', { infer: true }),
        });
      },
    },
    { provide: OutboxDeliveryRepository, useExisting: PrismaOutboxDeliveryRepository },
  ],
  exports: [ImOutboxWorker],
})
export class ImOutboxModule {}
