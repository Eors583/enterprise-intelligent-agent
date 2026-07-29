import { Module } from '@nestjs/common';

import { AuthorizationDecisionService } from './authorization-decision.service.js';
import { AuthorizationService } from './authorization.service.js';

@Module({
  providers: [AuthorizationDecisionService, AuthorizationService],
  exports: [AuthorizationDecisionService, AuthorizationService],
})
export class AuthorizationModule {}
