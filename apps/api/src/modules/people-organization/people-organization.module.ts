import { Module } from '@nestjs/common';

import { AdminAccessModule } from '../admin/admin-access.module.js';
import {
  PeopleOrganizationAdminController,
  PeopleSelfServiceController,
} from './people-organization.controller.js';
import { PeopleOrganizationService } from './people-organization.service.js';

@Module({
  imports: [AdminAccessModule],
  controllers: [PeopleOrganizationAdminController, PeopleSelfServiceController],
  providers: [PeopleOrganizationService],
  exports: [PeopleOrganizationService],
})
export class PeopleOrganizationModule {}
