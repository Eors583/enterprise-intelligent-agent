import type {
  Collaboration,
  CollaborationCandidate,
  CollaborationCommandRequest,
  CollaborationDetailResponse,
  CorrectionCase,
  CorrectionFeedbackRequest,
  CreateCollaborationRequest,
} from '@enterprise/contracts';

import type {
  RuntimeCursorPage,
  RuntimeCursorRequest,
  RuntimeMutationResult,
} from '../process-orchestration/application/runtime-mutation-result.js';
import type { TrustedRuntimePrincipal } from '../process-orchestration/application/runtime-identity.port.js';
import type { AuthorizedRuntimeTaskScope } from './collaboration-correction-authorization.port.js';

export interface ApplyCorrectionFeedbackInput {
  readonly principal: TrustedRuntimePrincipal;
  readonly scope: AuthorizedRuntimeTaskScope;
  readonly correctionId: string;
  readonly trustedActorRoleAssignmentId: string;
  readonly nextStatus: CorrectionCase['status'];
  readonly feedback: CorrectionFeedbackRequest;
}

export interface CreateCollaborationInput {
  readonly principal: TrustedRuntimePrincipal;
  readonly scope: AuthorizedRuntimeTaskScope;
  readonly request: CreateCollaborationRequest;
}

export interface ApplyCollaborationCommandInput {
  readonly principal: TrustedRuntimePrincipal;
  readonly scope: AuthorizedRuntimeTaskScope;
  readonly collaborationId: string;
  readonly request: CollaborationCommandRequest;
}

/**
 * Employee collaboration/correction persistence boundary. Implementations must
 * apply every trusted scope filter, never widen it, and atomically persist
 * feedback, CAS state, audit, event and outbox records.
 */
export abstract class CollaborationCorrectionRepository {
  abstract listCollaborationCandidates(
    scope: AuthorizedRuntimeTaskScope,
  ): Promise<readonly CollaborationCandidate[]>;

  abstract createCollaboration(
    input: CreateCollaborationInput,
  ): Promise<RuntimeMutationResult<CollaborationDetailResponse>>;

  abstract applyCollaborationCommand(
    input: ApplyCollaborationCommandInput,
  ): Promise<RuntimeMutationResult<CollaborationDetailResponse>>;

  abstract listCollaborations(
    scope: AuthorizedRuntimeTaskScope,
    page: RuntimeCursorRequest,
  ): Promise<RuntimeCursorPage<Collaboration>>;

  abstract findCollaboration(
    scope: AuthorizedRuntimeTaskScope,
    collaborationId: string,
  ): Promise<CollaborationDetailResponse | null>;

  abstract listCorrections(
    scope: AuthorizedRuntimeTaskScope,
    page: RuntimeCursorRequest,
  ): Promise<RuntimeCursorPage<CorrectionCase>>;

  abstract findCorrectionForFeedback(
    scope: AuthorizedRuntimeTaskScope,
    correctionId: string,
  ): Promise<CorrectionCase | null>;

  abstract applyCorrectionFeedback(
    input: ApplyCorrectionFeedbackInput,
  ): Promise<RuntimeMutationResult<CorrectionCase>>;
}
