import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  createExperienceCandidateRequestSchema,
  createMemoryCandidateRequestSchema,
  experienceListQuerySchema,
  experienceTransitionRequestSchema,
  memoryListQuerySchema,
  memoryTransitionRequestSchema,
  prepareExperienceKnowledgeProjectionRequestSchema,
  type CreateExperienceCandidateRequest,
  type CreateMemoryCandidateRequest,
  type ExperienceCandidate,
  type ExperienceListQuery,
  type ExperienceListResponse,
  type ExperienceKnowledgeProjection,
  type ExperienceTransitionRequest,
  type MemoryListQuery,
  type MemoryListResponse,
  type MemoryRecord,
  type MemoryTransitionRequest,
  type PrepareExperienceKnowledgeProjectionRequest,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { MemoryExperienceService } from './memory-experience.service.js';

@Controller('admin/experiences')
export class ExperienceAdminController {
  constructor(
    @Inject(MemoryExperienceService)
    private readonly service: MemoryExperienceService,
  ) {}

  @Get()
  list(
    @Query(new SchemaValidationPipe(experienceListQuerySchema))
    query: ExperienceListQuery,
  ): Promise<ExperienceListResponse> {
    return this.service.listExperiences(query);
  }

  @Get(':experienceId')
  get(
    @Param('experienceId', new ParseUUIDPipe()) experienceId: string,
  ): Promise<ExperienceCandidate> {
    return this.service.getExperience(experienceId);
  }

  @Post()
  create(
    @Body(new SchemaValidationPipe(createExperienceCandidateRequestSchema))
    request: CreateExperienceCandidateRequest,
  ): Promise<ExperienceCandidate> {
    return this.service.createExperience(request);
  }

  @Post(':experienceId/transitions')
  transition(
    @Param('experienceId', new ParseUUIDPipe()) experienceId: string,
    @Body(new SchemaValidationPipe(experienceTransitionRequestSchema))
    request: ExperienceTransitionRequest,
  ): Promise<ExperienceCandidate> {
    return this.service.transitionExperienceCandidate(experienceId, request);
  }

  @Get(':experienceId/knowledge-projection')
  getKnowledgeProjection(
    @Param('experienceId', new ParseUUIDPipe()) experienceId: string,
  ): Promise<ExperienceKnowledgeProjection> {
    return this.service.getExperienceKnowledgeProjection(experienceId);
  }

  @Post(':experienceId/knowledge-projection')
  prepareKnowledgeProjection(
    @Param('experienceId', new ParseUUIDPipe()) experienceId: string,
    @Body(new SchemaValidationPipe(prepareExperienceKnowledgeProjectionRequestSchema))
    request: PrepareExperienceKnowledgeProjectionRequest,
  ): Promise<ExperienceKnowledgeProjection> {
    return this.service.prepareExperienceKnowledgeProjection(experienceId, request);
  }
}

@Controller('workbench/memories')
export class MemoryWorkbenchController {
  constructor(
    @Inject(MemoryExperienceService)
    private readonly service: MemoryExperienceService,
  ) {}

  @Get()
  list(
    @Query(new SchemaValidationPipe(memoryListQuerySchema))
    query: MemoryListQuery,
  ): Promise<MemoryListResponse> {
    return this.service.listMemories(query);
  }

  @Get(':memoryId')
  get(
    @Param('memoryId', new ParseUUIDPipe()) memoryId: string,
    @Query('purpose') purpose?: string,
  ): Promise<MemoryRecord> {
    return this.service.getMemory(memoryId, purpose);
  }

  @Post()
  create(
    @Body(new SchemaValidationPipe(createMemoryCandidateRequestSchema))
    request: CreateMemoryCandidateRequest,
  ): Promise<MemoryRecord> {
    return this.service.createMemory(request);
  }

  @Post(':memoryId/transitions')
  transition(
    @Param('memoryId', new ParseUUIDPipe()) memoryId: string,
    @Body(new SchemaValidationPipe(memoryTransitionRequestSchema))
    request: MemoryTransitionRequest,
  ): Promise<MemoryRecord> {
    return this.service.transitionMemoryRecord(memoryId, request);
  }
}
