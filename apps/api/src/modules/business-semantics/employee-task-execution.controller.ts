import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  employeeAcceptanceRequestInputSchema,
  employeeDeliverableSubmissionCommandSchema,
  employeeDeliverableSubmissionRequestSchema,
  employeeEvidenceContributionCommandSchema,
  employeeEvidenceContributionRequestSchema,
  employeeTaskTransitionRequestSchema,
  type Deliverable,
  type EmployeeAcceptanceRequest,
  type EmployeeAcceptanceRequestInput,
  type EmployeeDeliverableSubmissionCommand,
  type EmployeeDeliverableSubmissionRequest,
  type EmployeeEvidenceContributionCommand,
  type EmployeeEvidenceContributionRequest,
  type EmployeeTaskExecutionSnapshot,
  type EmployeeTaskTransitionRequest,
  type Evidence,
  type Task,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { EmployeeTaskExecutionService } from './employee-task-execution.service.js';

@Controller('workbench/tasks/:taskId/execution')
export class EmployeeTaskExecutionController {
  constructor(
    @Inject(EmployeeTaskExecutionService)
    private readonly execution: EmployeeTaskExecutionService,
  ) {}

  @Get()
  snapshot(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ): Promise<EmployeeTaskExecutionSnapshot> {
    return this.execution.getSnapshot(taskId);
  }

  @Post('task-transitions')
  transitionTask(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body(new SchemaValidationPipe(employeeTaskTransitionRequestSchema))
    request: EmployeeTaskTransitionRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Task> {
    return this.execution.transitionTask(taskId, request, idempotencyKey);
  }

  @Post('deliverables/:deliverableId/submit')
  submitDeliverable(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Param('deliverableId', new ParseUUIDPipe()) deliverableId: string,
    @Body(new SchemaValidationPipe(employeeDeliverableSubmissionRequestSchema))
    request: EmployeeDeliverableSubmissionRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Deliverable> {
    return this.execution.submitDeliverable(taskId, deliverableId, request, idempotencyKey);
  }

  @Post('deliverables/:deliverableId/submissions')
  submitDeliverableCommand(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Param('deliverableId', new ParseUUIDPipe()) deliverableId: string,
    @Body(new SchemaValidationPipe(employeeDeliverableSubmissionCommandSchema))
    request: EmployeeDeliverableSubmissionCommand,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Deliverable> {
    return this.execution.submitDeliverableCommand(taskId, deliverableId, request, idempotencyKey);
  }

  @Post('evidence')
  contributeEvidence(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body(new SchemaValidationPipe(employeeEvidenceContributionRequestSchema))
    request: EmployeeEvidenceContributionRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Evidence> {
    return this.execution.contributeEvidence(taskId, request, idempotencyKey);
  }

  @Post('evidence/contributions')
  contributeEvidenceCommand(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body(new SchemaValidationPipe(employeeEvidenceContributionCommandSchema))
    request: EmployeeEvidenceContributionCommand,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Evidence> {
    return this.execution.contributeEvidenceCommand(taskId, request, idempotencyKey);
  }

  @Post('deliverables/:deliverableId/acceptance-requests')
  requestAcceptance(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Param('deliverableId', new ParseUUIDPipe()) deliverableId: string,
    @Body(new SchemaValidationPipe(employeeAcceptanceRequestInputSchema))
    request: EmployeeAcceptanceRequestInput,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<EmployeeAcceptanceRequest> {
    return this.execution.requestAcceptance(taskId, deliverableId, request, idempotencyKey);
  }
}
