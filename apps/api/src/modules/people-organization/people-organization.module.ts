import { Module } from '@nestjs/common';

import { AdminAccessModule } from '../admin/admin-access.module.js';
import {
  PeopleOrganizationAdminController,
  PeopleSelfServiceController,
} from './people-organization.controller.js';
import { PersonalManualSelfService } from './personal-manual-self.service.js';
import { EmployeeCollaborationContextPort } from './employee-collaboration-context.port.js';
import { EmployeeCollaborationContextService } from './employee-collaboration-context.service.js';
import { PeopleOrganizationService } from './people-organization.service.js';
import { WorkAvailabilitySelfService } from './work-availability-self.service.js';

@Module({
  imports: [AdminAccessModule],
  controllers: [PeopleOrganizationAdminController, PeopleSelfServiceController],
  providers: [
    PeopleOrganizationService,
    PersonalManualSelfService,
    WorkAvailabilitySelfService,
    EmployeeCollaborationContextService,
    {
      provide: EmployeeCollaborationContextPort,
      useExisting: EmployeeCollaborationContextService,
    },
  ],
  exports: [PeopleOrganizationService, EmployeeCollaborationContextPort],
})
export class PeopleOrganizationModule {}
