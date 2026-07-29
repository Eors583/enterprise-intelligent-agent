import { Module } from '@nestjs/common';

import { MarketingEvidenceService } from './marketing-evidence.service.js';
import { MarketingManagementController } from './marketing-management.controller.js';
import { MarketingMasterDataService } from './marketing-master-data.service.js';
import { MarketingPlanningService } from './marketing-planning.service.js';
import { AdminAccessModule } from '../admin/admin-access.module.js';

@Module({
  imports: [AdminAccessModule],
  controllers: [MarketingManagementController],
  providers: [MarketingEvidenceService, MarketingMasterDataService, MarketingPlanningService],
  exports: [MarketingEvidenceService, MarketingMasterDataService, MarketingPlanningService],
})
export class MarketingManagementModule {}
