import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../config/environment.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { ImOutboxWorker } from './application/im-outbox.worker.js';
import { ImRealtimeSessionService } from './application/im-realtime-session.service.js';
import { ImDeliveryProvider } from './domain/im-delivery.provider.js';
import { OutboxDeliveryRepository } from './domain/outbox-delivery.repository.js';
import { LocalImDeliveryProvider } from './infrastructure/local/local-im-delivery.provider.js';
import { PrismaOutboxDeliveryRepository } from './infrastructure/prisma/prisma-outbox-delivery.repository.js';
import { TencentImDeliveryProvider } from './infrastructure/tencent/index.js';
import { WuKongImDeliveryProvider } from './infrastructure/wukong/index.js';
import { ImRealtimeController } from './im-realtime.controller.js';

@Module({
  imports: [IdentityModule, AuthorizationModule],
  controllers: [ImRealtimeController],
  providers: [
    ImOutboxWorker,
    ImRealtimeSessionService,
    LocalImDeliveryProvider,
    PrismaOutboxDeliveryRepository,
    {
      provide: ImDeliveryProvider,
      inject: [ConfigService, LocalImDeliveryProvider],
      useFactory: (
        config: ConfigService<EnvironmentVariables, true>,
        localProvider: LocalImDeliveryProvider,
      ): ImDeliveryProvider => {
        const provider = config.get('IM_PROVIDER', { infer: true });
        if (provider === 'local') return localProvider;

        if (provider === 'wukong') {
          return new WuKongImDeliveryProvider({
            endpoint: config.get('WUKONG_IM_API_BASE_URL', { infer: true }),
            apiToken: config.get('WUKONG_IM_API_TOKEN', { infer: true }),
            requestTimeoutMs: config.get('WUKONG_IM_HTTP_TIMEOUT_MS', { infer: true }),
          });
        }

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
