import type { CorrectionCase, CorrectionFeedbackRequest } from '@enterprise/contracts';

import type { CorrectionFeedbackContext } from '../process-orchestration/domain/correction-state-machine.js';
import type { TrustedRuntimePrincipal } from '../process-orchestration/application/runtime-identity.port.js';

export type RuntimeTaskReadAction =
  | 'collaboration.list'
  | 'collaboration.read'
  | 'collaboration.candidates'
  | 'collaboration.create'
  | 'collaboration.command'
  | 'correction.list'
  | 'correction.feedback';

export interface AuthorizedRuntimeTaskScope {
  readonly tenantId: string;
  readonly userId: string;
  readonly taskId: string;
  readonly decisionId: string;
  readonly managementBypass: boolean;
  readonly roleAssignmentIds: readonly string[];
  readonly organizationIds: readonly string[];
  readonly projectIds: readonly string[];
  /**
   * Label grants stay grouped by assignment. Taking their union would allow a
   * label combination that no single trusted assignment actually grants.
   */
  readonly permissionLabelScopes: readonly (readonly string[])[];
  readonly permissionLabels: readonly string[];
}

/**
 * Trusted PDP/identity boundary for employee runtime data. Implementations must
 * resolve current Role Assignments and evidence visibility from server-side
 * records and execute every returned scope obligation in the repository query.
 */
export abstract class CollaborationCorrectionAuthorizationPort {
  abstract requireTaskAccess(input: {
    readonly principal: TrustedRuntimePrincipal;
    readonly taskId: string;
    readonly action: RuntimeTaskReadAction;
  }): Promise<AuthorizedRuntimeTaskScope>;

  abstract buildCorrectionFeedbackContext(input: {
    readonly principal: TrustedRuntimePrincipal;
    readonly scope: AuthorizedRuntimeTaskScope;
    readonly correction: CorrectionCase;
    readonly feedback: CorrectionFeedbackRequest;
  }): Promise<CorrectionFeedbackContext>;
}
