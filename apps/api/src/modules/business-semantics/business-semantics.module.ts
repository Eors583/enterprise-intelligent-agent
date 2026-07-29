import { Module } from '@nestjs/common';

import { AdminAccessModule } from '../admin/admin-access.module.js';
import { BusinessSemanticsPolicyService } from './business-semantics-policy.service.js';
import { BusinessSemanticsWorkbenchController } from './business-semantics-workbench.controller.js';
import { BusinessSemanticsWorkbenchService } from './business-semantics-workbench.service.js';
import { DeliverableAcceptanceAdminController } from './deliverable-acceptance-admin.controller.js';
import { DeliverableAcceptanceAdminService } from './deliverable-acceptance-admin.service.js';
import {
  EvidenceAdminController,
  EvidenceLinkAdminController,
} from './evidence-admin.controller.js';
import { EvidenceLinkAdminService } from './evidence-link-admin.service.js';
import { EvidenceAdminService } from './evidence-admin.service.js';
import { EmployeeTaskExecutionController } from './employee-task-execution.controller.js';
import { EmployeeTaskExecutionService } from './employee-task-execution.service.js';
import {
  MetricAdminController,
  MetricObservationAdminController,
} from './metric-admin.controller.js';
import { MetricObservationAdminService } from './metric-observation-admin.service.js';
import { MetricAdminService } from './metric-admin.service.js';
import {
  ObjectiveAdminController,
  ObjectiveRelationAdminController,
} from './objective-admin.controller.js';
import { ObjectiveRelationAdminService } from './objective-relation-admin.service.js';
import { ObjectiveAdminService } from './objective-admin.service.js';
import { ProcessAdminController } from './process-admin.controller.js';
import { ProcessAdminService } from './process-admin.service.js';
import { StrategyAdminController } from './strategy-admin.controller.js';
import { StrategyAdminService } from './strategy-admin.service.js';
import { TaskAdminController, TaskDependencyAdminController } from './task-admin.controller.js';
import { TaskDependencyAdminService } from './task-dependency-admin.service.js';
import { TaskAdminService } from './task-admin.service.js';
import { ValueAdminController } from './value-admin.controller.js';
import { ValueAdminService } from './value-admin.service.js';

@Module({
  imports: [AdminAccessModule],
  controllers: [
    ValueAdminController,
    StrategyAdminController,
    ObjectiveRelationAdminController,
    ObjectiveAdminController,
    MetricObservationAdminController,
    MetricAdminController,
    ProcessAdminController,
    TaskDependencyAdminController,
    TaskAdminController,
    DeliverableAcceptanceAdminController,
    EvidenceLinkAdminController,
    EvidenceAdminController,
    BusinessSemanticsWorkbenchController,
    EmployeeTaskExecutionController,
  ],
  providers: [
    BusinessSemanticsPolicyService,
    ValueAdminService,
    StrategyAdminService,
    ObjectiveAdminService,
    MetricAdminService,
    ProcessAdminService,
    TaskAdminService,
    EvidenceAdminService,
    ObjectiveRelationAdminService,
    MetricObservationAdminService,
    TaskDependencyAdminService,
    DeliverableAcceptanceAdminService,
    EvidenceLinkAdminService,
    BusinessSemanticsWorkbenchService,
    EmployeeTaskExecutionService,
  ],
})
export class BusinessSemanticsModule {}
