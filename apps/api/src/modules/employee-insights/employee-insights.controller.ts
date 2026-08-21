import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import {
  employeeAiUsageQuerySchema,
  employeeCreateExperienceRequestSchema,
  employeeExperienceListQuerySchema,
  employeeExperienceSourceQuerySchema,
  type EmployeeAiUsageQuery,
  type EmployeeAiUsageSummary,
  type EmployeeCreateExperienceRequest,
  type EmployeeExperienceCandidate,
  type EmployeeExperienceListQuery,
  type EmployeeExperienceListResponse,
  type EmployeeExperienceSource,
  type EmployeeExperienceSourceQuery,
} from '@enterprise/contracts';

import { EmployeeInsightsService } from './employee-insights.service.js';
import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';

@Controller('workbench/experiences')
export class EmployeeExperienceController {
  constructor(
    @Inject(EmployeeInsightsService)
    private readonly service: EmployeeInsightsService,
  ) {}

  @Get()
  list(
    @Query(new SchemaValidationPipe(employeeExperienceListQuerySchema))
    query: EmployeeExperienceListQuery,
  ): Promise<EmployeeExperienceListResponse> {
    return this.service.listExperiences(query);
  }

  @Post()
  create(
    @Body(new SchemaValidationPipe(employeeCreateExperienceRequestSchema))
    request: EmployeeCreateExperienceRequest,
  ): Promise<EmployeeExperienceCandidate> {
    return this.service.createExperience(request);
  }
}

@Controller('workbench/experience-sources')
export class EmployeeExperienceSourceController {
  constructor(
    @Inject(EmployeeInsightsService)
    private readonly service: EmployeeInsightsService,
  ) {}

  @Get()
  list(
    @Query(new SchemaValidationPipe(employeeExperienceSourceQuerySchema))
    query: EmployeeExperienceSourceQuery,
  ): Promise<EmployeeExperienceSource> {
    return this.service.experienceSources(query.taskId);
  }
}

@Controller('workbench/ai-usage')
export class EmployeeAiUsageController {
  constructor(
    @Inject(EmployeeInsightsService)
    private readonly service: EmployeeInsightsService,
  ) {}

  @Get()
  summary(
    @Query(new SchemaValidationPipe(employeeAiUsageQuerySchema))
    query: EmployeeAiUsageQuery,
  ): Promise<EmployeeAiUsageSummary> {
    return this.service.aiUsage(query);
  }
}
