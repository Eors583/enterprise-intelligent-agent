import { MiddlewareConsumer, Module, RequestMethod, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { BootstrapModule } from './bootstrap/bootstrap.module.js';
import { ApiExceptionFilter } from './common/filters/api-exception.filter.js';
import { ResponseTimingInterceptor } from './common/interceptors/response-timing.interceptor.js';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware.js';
import { SecurityHeadersMiddleware } from './common/middleware/security-headers.middleware.js';
import { RequestContextModule } from './common/context/request-context.module.js';
import { validateApiEnvironment } from './config/environment.js';
import { PrismaModule } from './database/prisma.module.js';
import { HealthModule } from './health/health.module.js';
import { AgentControlModule } from './modules/agent-control/agent-control.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { AgentRunModule } from './modules/agent-run/agent-run.module.js';
import { AdminOverviewModule } from './modules/admin-overview/admin-overview.module.js';
import { AiEvaluationModule } from './modules/ai-evaluation/ai-evaluation.module.js';
import { AiSafetyModelRoutingModule } from './modules/ai-safety-model-routing/ai-safety-model-routing.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { AuthorizationModule } from './modules/authorization/authorization.module.js';
import { AuditGovernanceModule } from './modules/audit-governance/audit-governance.module.js';
import { BusinessEventModule } from './modules/business-events/business-event.module.js';
import { BusinessSemanticsModule } from './modules/business-semantics/business-semantics.module.js';
import { CollaborationCorrectionModule } from './modules/collaboration-correction/collaboration-correction.module.js';
import { ConversationModule } from './modules/conversation/conversation.module.js';
import { DirectoryModule } from './modules/directory/directory.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { IdentityGovernanceModule } from './modules/identity-governance/identity-governance.module.js';
import { ImOutboxModule } from './modules/im-outbox/im-outbox.module.js';
import { KnowledgeGraphGovernanceModule } from './modules/knowledge-graph-governance/knowledge-graph-governance.module.js';
import { MemoryExperienceModule } from './modules/memory-experience/memory-experience.module.js';
import { MarketingManagementModule } from './modules/marketing-management/marketing-management.module.js';
import { ProcessRuntimeModule } from './modules/process-runtime/process-runtime.module.js';
import { MyRoleAssignmentModule } from './modules/role-assignment/my-role-assignment.module.js';
import { ToolGatewayModule } from './modules/tool-gateway/tool-gateway.module.js';
import { PeopleOrganizationModule } from './modules/people-organization/people-organization.module.js';
import { FinanceFinopsModule } from './modules/finance-finops/finance-finops.module.js';
import { EmployeeInsightsModule } from './modules/employee-insights/employee-insights.module.js';

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
    IdentityGovernanceModule,
    DirectoryModule,
    AuthorizationModule,
    AuditGovernanceModule,
    BusinessSemanticsModule,
    ProcessRuntimeModule,
    ToolGatewayModule,
    BusinessEventModule,
    CollaborationCorrectionModule,
    KnowledgeGraphGovernanceModule,
    MemoryExperienceModule,
    EmployeeInsightsModule,
    MarketingManagementModule,
    ConversationModule,
    AgentRunModule,
    AdminOverviewModule,
    AiEvaluationModule,
    AiSafetyModelRoutingModule,
    PeopleOrganizationModule,
    FinanceFinopsModule,
    AgentControlModule,
    MyRoleAssignmentModule,
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
    consumer
      .apply(SecurityHeadersMiddleware, RequestIdMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
