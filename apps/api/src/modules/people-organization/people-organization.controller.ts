import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  activateCompetencyVersionRequestSchema,
  analyzeOrganizationChangeRequestSchema,
  applyOrganizationChangeRequestSchema,
  confirmCompetencyAssessmentRequestSchema,
  createCompetencyAppealRequestSchema,
  createCompetencyAssessmentRequestSchema,
  createCompetencyDefinitionRequestSchema,
  createCompetencyEvidenceRequestSchema,
  createCompetencyVersionRequestSchema,
  createDevelopmentPlanRequestSchema,
  createOrganizationChangeRequestSchema,
  createTriangleTeamRequestSchema,
  decideOrganizationChangeRequestSchema,
  triangleHealthSnapshotRequestSchema,
  transitionCompetencyAppealRequestSchema,
  transitionDevelopmentActionRequestSchema,
  type ActivateCompetencyVersionRequest,
  type AnalyzeOrganizationChangeRequest,
  type ApplyOrganizationChangeRequest,
  type ConfirmCompetencyAssessmentRequest,
  type CreateCompetencyAppealRequest,
  type CreateCompetencyAssessmentRequest,
  type CreateCompetencyDefinitionRequest,
  type CreateCompetencyEvidenceRequest,
  type CreateCompetencyVersionRequest,
  type CreateDevelopmentPlanRequest,
  type CreateOrganizationChangeRequest,
  type CreateTriangleTeamRequest,
  type DecideOrganizationChangeRequest,
  type TriangleHealthSnapshotRequest,
  type TransitionCompetencyAppealRequest,
  type TransitionDevelopmentActionRequest,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { PeopleOrganizationService } from './people-organization.service.js';

@Controller('admin/people-organization')
export class PeopleOrganizationAdminController {
  constructor(
    @Inject(PeopleOrganizationService)
    private readonly service: PeopleOrganizationService,
  ) {}

  @Get('overview')
  overview() {
    return this.service.overview();
  }

  @Post('competencies')
  createCompetency(
    @Body(new SchemaValidationPipe(createCompetencyDefinitionRequestSchema))
    request: CreateCompetencyDefinitionRequest,
  ) {
    return this.service.createCompetencyDefinition(request);
  }

  @Post('competencies/:definitionId/versions')
  createCompetencyVersion(
    @Param('definitionId', new ParseUUIDPipe()) definitionId: string,
    @Body(new SchemaValidationPipe(createCompetencyVersionRequestSchema))
    request: CreateCompetencyVersionRequest,
  ) {
    return this.service.createCompetencyVersion(definitionId, request);
  }

  @Post('competencies/:definitionId/versions/:versionId/activate')
  activateCompetencyVersion(
    @Param('definitionId', new ParseUUIDPipe()) definitionId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Body(new SchemaValidationPipe(activateCompetencyVersionRequestSchema))
    request: ActivateCompetencyVersionRequest,
  ) {
    return this.service.activateCompetencyVersion(definitionId, versionId, request);
  }

  @Post('evidence')
  createEvidence(
    @Body(new SchemaValidationPipe(createCompetencyEvidenceRequestSchema))
    request: CreateCompetencyEvidenceRequest,
  ) {
    return this.service.createCompetencyEvidence(request);
  }

  @Post('assessments')
  createAssessment(
    @Body(new SchemaValidationPipe(createCompetencyAssessmentRequestSchema))
    request: CreateCompetencyAssessmentRequest,
  ) {
    return this.service.createAssessment(request);
  }

  @Post('assessments/:assessmentId/confirmations')
  confirmAssessment(
    @Param('assessmentId', new ParseUUIDPipe()) assessmentId: string,
    @Body(new SchemaValidationPipe(confirmCompetencyAssessmentRequestSchema))
    request: ConfirmCompetencyAssessmentRequest,
  ) {
    return this.service.confirmAssessment(assessmentId, request, true);
  }

  @Post('appeals/:appealId/transitions')
  transitionAppeal(
    @Param('appealId', new ParseUUIDPipe()) appealId: string,
    @Body(new SchemaValidationPipe(transitionCompetencyAppealRequestSchema))
    request: TransitionCompetencyAppealRequest,
  ) {
    return this.service.transitionAppeal(appealId, request);
  }

  @Post('development-plans')
  createDevelopmentPlan(
    @Body(new SchemaValidationPipe(createDevelopmentPlanRequestSchema))
    request: CreateDevelopmentPlanRequest,
  ) {
    return this.service.createDevelopmentPlan(request);
  }

  @Post('development-actions/:actionId/transitions')
  transitionDevelopmentAction(
    @Param('actionId', new ParseUUIDPipe()) actionId: string,
    @Body(new SchemaValidationPipe(transitionDevelopmentActionRequestSchema))
    request: TransitionDevelopmentActionRequest,
  ) {
    return this.service.transitionDevelopmentAction(actionId, request);
  }

  @Post('triangle-teams')
  createTriangleTeam(
    @Body(new SchemaValidationPipe(createTriangleTeamRequestSchema))
    request: CreateTriangleTeamRequest,
  ) {
    return this.service.createTriangleTeam(request);
  }

  @Post('triangle-teams/:teamId/health-snapshots')
  calculateTriangleHealth(
    @Param('teamId', new ParseUUIDPipe()) teamId: string,
    @Body(new SchemaValidationPipe(triangleHealthSnapshotRequestSchema))
    request: TriangleHealthSnapshotRequest,
  ) {
    return this.service.calculateHealth(teamId, request);
  }

  @Post('organization-changes')
  proposeOrganizationChange(
    @Body(new SchemaValidationPipe(createOrganizationChangeRequestSchema))
    request: CreateOrganizationChangeRequest,
  ) {
    return this.service.proposeOrganizationChange(request);
  }

  @Post('organization-changes/:proposalId/analysis')
  analyzeOrganizationChange(
    @Param('proposalId', new ParseUUIDPipe()) proposalId: string,
    @Body(new SchemaValidationPipe(analyzeOrganizationChangeRequestSchema))
    request: AnalyzeOrganizationChangeRequest,
  ) {
    return this.service.analyzeOrganizationChange(proposalId, request);
  }

  @Post('organization-changes/:proposalId/decision')
  decideOrganizationChange(
    @Param('proposalId', new ParseUUIDPipe()) proposalId: string,
    @Body(new SchemaValidationPipe(decideOrganizationChangeRequestSchema))
    request: DecideOrganizationChangeRequest,
  ) {
    return this.service.decideOrganizationChange(proposalId, request);
  }

  @Post('organization-changes/:proposalId/apply')
  applyOrganizationChange(
    @Param('proposalId', new ParseUUIDPipe()) proposalId: string,
    @Body(new SchemaValidationPipe(applyOrganizationChangeRequestSchema))
    request: ApplyOrganizationChangeRequest,
  ) {
    return this.service.applyOrganizationChange(proposalId, request);
  }
}

@Controller('workbench/people')
export class PeopleSelfServiceController {
  constructor(
    @Inject(PeopleOrganizationService)
    private readonly service: PeopleOrganizationService,
  ) {}

  @Get('me')
  profile() {
    return this.service.employeeProfile();
  }

  @Post('assessments/:assessmentId/confirmations')
  confirmOwnAssessment(
    @Param('assessmentId', new ParseUUIDPipe()) assessmentId: string,
    @Body(new SchemaValidationPipe(confirmCompetencyAssessmentRequestSchema))
    request: ConfirmCompetencyAssessmentRequest,
  ) {
    return this.service.confirmAssessment(assessmentId, request, false);
  }

  @Post('assessments/:assessmentId/appeals')
  appealOwnAssessment(
    @Param('assessmentId', new ParseUUIDPipe()) assessmentId: string,
    @Body(new SchemaValidationPipe(createCompetencyAppealRequestSchema))
    request: CreateCompetencyAppealRequest,
  ) {
    return this.service.createAppeal(assessmentId, request);
  }
}
