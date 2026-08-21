import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import {
  type AuditEventListQuery,
  type AuditEventListResponse,
  type AuditExportResponse,
  type AuditIntegrityResponse,
  type CreateAuditExportRequest,
  auditEventListQuerySchema,
  createAuditExportRequestSchema,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { AuditGovernanceService } from './audit-governance.service.js';

@Controller('admin/audit')
export class AuditGovernanceController {
  constructor(
    @Inject(AuditGovernanceService)
    private readonly audit: AuditGovernanceService,
  ) {}

  @Get('events')
  list(
    @Query(new SchemaValidationPipe(auditEventListQuerySchema))
    query: AuditEventListQuery,
  ): Promise<AuditEventListResponse> {
    return this.audit.list(query);
  }

  @Get('integrity')
  verifyIntegrity(): Promise<AuditIntegrityResponse> {
    return this.audit.verifyIntegrity();
  }

  @Post('exports')
  export(
    @Body(new SchemaValidationPipe(createAuditExportRequestSchema))
    request: CreateAuditExportRequest,
  ): Promise<AuditExportResponse> {
    return this.audit.export(request);
  }
}
