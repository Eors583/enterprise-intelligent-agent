import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  createEvidenceLinkRequestSchema,
  createEvidenceGuidedRequestSchema,
  createEvidenceRequestSchema,
  transitionEvidenceLinkRequestSchema,
  transitionEvidenceRequestSchema,
  updateEvidenceLinkRequestSchema,
  updateEvidenceRequestSchema,
  type CreateEvidenceLinkRequest,
  type CreateEvidenceGuidedRequest,
  type CreateEvidenceRequest,
  type Evidence,
  type EvidenceLink,
  type TransitionEvidenceLinkRequest,
  type TransitionEvidenceRequest,
  type UpdateEvidenceLinkRequest,
  type UpdateEvidenceRequest,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { EvidenceAdminService } from './evidence-admin.service.js';
import { EvidenceLinkAdminService } from './evidence-link-admin.service.js';

@Controller('admin/business-semantics/evidence/:evidenceId/links')
export class EvidenceLinkAdminController {
  constructor(
    @Inject(EvidenceLinkAdminService)
    private readonly links: EvidenceLinkAdminService,
  ) {}

  @Get()
  list(
    @Param('evidenceId', new ParseUUIDPipe()) evidenceId: string,
  ): Promise<{ items: EvidenceLink[] }> {
    return this.links.list(evidenceId);
  }

  @Post()
  create(
    @Param('evidenceId', new ParseUUIDPipe()) evidenceId: string,
    @Body(new SchemaValidationPipe(createEvidenceLinkRequestSchema))
    request: CreateEvidenceLinkRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<EvidenceLink> {
    return this.links.create(evidenceId, request, idempotencyKey);
  }

  @Patch(':linkId')
  update(
    @Param('evidenceId', new ParseUUIDPipe()) evidenceId: string,
    @Param('linkId', new ParseUUIDPipe()) linkId: string,
    @Body(new SchemaValidationPipe(updateEvidenceLinkRequestSchema))
    request: UpdateEvidenceLinkRequest,
  ): Promise<EvidenceLink> {
    return this.links.update(evidenceId, linkId, request);
  }

  @Post(':linkId/transition')
  transition(
    @Param('evidenceId', new ParseUUIDPipe()) evidenceId: string,
    @Param('linkId', new ParseUUIDPipe()) linkId: string,
    @Body(new SchemaValidationPipe(transitionEvidenceLinkRequestSchema))
    request: TransitionEvidenceLinkRequest,
  ): Promise<EvidenceLink> {
    return this.links.transition(evidenceId, linkId, request);
  }
}

@Controller('admin/business-semantics/evidence')
export class EvidenceAdminController {
  constructor(
    @Inject(EvidenceAdminService)
    private readonly semantics: EvidenceAdminService,
  ) {}

  @Get()
  list(): Promise<{ items: Evidence[] }> {
    return this.semantics.listEvidence();
  }

  @Post()
  create(
    @Body(new SchemaValidationPipe(createEvidenceRequestSchema))
    request: CreateEvidenceRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Evidence> {
    return this.semantics.createEvidence(request, idempotencyKey);
  }

  @Post('guided')
  createGuided(
    @Body(new SchemaValidationPipe(createEvidenceGuidedRequestSchema))
    request: CreateEvidenceGuidedRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Evidence> {
    return this.semantics.createGuidedEvidence(request, idempotencyKey);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(updateEvidenceRequestSchema))
    request: UpdateEvidenceRequest,
  ): Promise<Evidence> {
    return this.semantics.updateEvidence(id, request);
  }

  @Post(':id/transition')
  transition(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(transitionEvidenceRequestSchema))
    request: TransitionEvidenceRequest,
  ): Promise<Evidence> {
    return this.semantics.transitionEvidence(id, request);
  }
}
