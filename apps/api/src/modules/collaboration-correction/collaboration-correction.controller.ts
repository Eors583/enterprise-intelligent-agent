import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  collaborationCommandRequestSchema,
  createCollaborationRequestSchema,
  correctionFeedbackRequestSchema,
  type CollaborationCandidateList,
  type CollaborationCommandRequest,
  type CollaborationDetailResponse,
  type CollaborationListResponse,
  type CorrectionCase,
  type CorrectionCaseListResponse,
  type CorrectionFeedbackRequest,
  type CreateCollaborationRequest,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { CollaborationCorrectionService } from './collaboration-correction.service.js';

@Controller('workbench/tasks/:taskId')
export class CollaborationCorrectionController {
  constructor(
    @Inject(CollaborationCorrectionService)
    private readonly interactions: CollaborationCorrectionService,
  ) {}

  @Get('collaboration-candidates')
  listCollaborationCandidates(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ): Promise<CollaborationCandidateList> {
    return this.interactions.listCollaborationCandidates(taskId);
  }

  @Get('collaborations')
  listCollaborations(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Query('cursor') cursor?: string,
  ): Promise<CollaborationListResponse> {
    return this.interactions.listCollaborations(taskId, cursor);
  }

  @Post('collaborations')
  createCollaboration(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body(new SchemaValidationPipe(createCollaborationRequestSchema))
    request: CreateCollaborationRequest,
  ): Promise<CollaborationDetailResponse> {
    return this.interactions.createCollaboration(taskId, request);
  }

  @Post('collaborations/:collaborationId/commands')
  submitCollaborationCommand(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Param('collaborationId', new ParseUUIDPipe()) collaborationId: string,
    @Body(new SchemaValidationPipe(collaborationCommandRequestSchema))
    request: CollaborationCommandRequest,
  ): Promise<CollaborationDetailResponse> {
    return this.interactions.submitCollaborationCommand(taskId, collaborationId, request);
  }

  @Get('collaborations/:collaborationId')
  getCollaboration(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Param('collaborationId', new ParseUUIDPipe()) collaborationId: string,
  ): Promise<CollaborationDetailResponse> {
    return this.interactions.getCollaboration(taskId, collaborationId);
  }

  @Get('corrections')
  listCorrections(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Query('cursor') cursor?: string,
  ): Promise<CorrectionCaseListResponse> {
    return this.interactions.listCorrections(taskId, cursor);
  }

  @Post('corrections/:correctionId/feedback')
  submitCorrectionFeedback(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Param('correctionId', new ParseUUIDPipe()) correctionId: string,
    @Body(new SchemaValidationPipe(correctionFeedbackRequestSchema))
    feedback: CorrectionFeedbackRequest,
  ): Promise<CorrectionCase> {
    return this.interactions.submitCorrectionFeedback(taskId, correctionId, feedback);
  }
}
