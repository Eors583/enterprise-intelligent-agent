import { Module } from '@nestjs/common';

import { FinanceFinopsController } from './finance-finops.controller.js';
import { FinopsCatalogService } from './finops-catalog.service.js';
import { FinopsGovernanceService } from './finops-governance.service.js';
import { FinopsLedgerService } from './finops-ledger.service.js';
import { FinopsQueryService } from './finops-query.service.js';
import {
  FinopsAutoProjectionReconciler,
  PrismaFinopsAutoProjectionReconciler,
} from './finops-auto-projection.reconciler.js';
import { FinopsAutoProjectionWorker } from './finops-auto-projection.worker.js';
import { AdminAccessModule } from '../admin/admin-access.module.js';

@Module({
  imports: [AdminAccessModule],
  controllers: [FinanceFinopsController],
  providers: [
    FinopsCatalogService,
    FinopsLedgerService,
    FinopsGovernanceService,
    FinopsQueryService,
    {
      provide: FinopsAutoProjectionReconciler,
      useClass: PrismaFinopsAutoProjectionReconciler,
    },
    FinopsAutoProjectionWorker,
  ],
  exports: [
    FinopsCatalogService,
    FinopsLedgerService,
    FinopsGovernanceService,
    FinopsQueryService,
    FinopsAutoProjectionWorker,
  ],
})
export class FinanceFinopsModule {}
