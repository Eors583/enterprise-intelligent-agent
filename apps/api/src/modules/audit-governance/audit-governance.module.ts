import { Module } from '@nestjs/common';

import { AdminAccessModule } from '../admin/admin-access.module.js';
import { AuditGovernanceController } from './audit-governance.controller.js';
import { AuditGovernanceService } from './audit-governance.service.js';

@Module({
  imports: [AdminAccessModule],
  controllers: [AuditGovernanceController],
  providers: [AuditGovernanceService],
})
export class AuditGovernanceModule {}
