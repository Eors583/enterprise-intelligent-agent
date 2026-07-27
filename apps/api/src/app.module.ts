import { MiddlewareConsumer, Module, RequestMethod, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { BootstrapModule } from './bootstrap/bootstrap.module.js';
import { ApiExceptionFilter } from './common/filters/api-exception.filter.js';
import { ResponseTimingInterceptor } from './common/interceptors/response-timing.interceptor.js';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware.js';
import { RequestContextModule } from './common/context/request-context.module.js';
import { validateApiEnvironment } from './config/environment.js';
import { PrismaModule } from './database/prisma.module.js';
import { HealthModule } from './health/health.module.js';
import { AgentControlModule } from './modules/agent-control/agent-control.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { AgentRunModule } from './modules/agent-run/agent-run.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { AuthorizationModule } from './modules/authorization/authorization.module.js';
import { ConversationModule } from './modules/conversation/conversation.module.js';
import { DirectoryModule } from './modules/directory/directory.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { ImOutboxModule } from './modules/im-outbox/im-outbox.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      envFilePath: ['.env', '../../.env'],
      isGlobal: true,
      validate: validateApiEnvironment,
    }),
    RequestContextModule,
    PrismaModule,
    HealthModule,
    AuthModule,
    IdentityModule,
    DirectoryModule,
    AuthorizationModule,
    ConversationModule,
    AgentRunModule,
    AgentControlModule,
    AdminModule,
    BootstrapModule,
    ImOutboxModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseTimingInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
