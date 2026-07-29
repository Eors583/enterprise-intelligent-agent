import { ForbiddenException, Injectable, Logger } from '@nestjs/common';

import { evaluateAuthorization } from './authorization.policy.js';
import type { AuthorizationDecision, AuthorizationInput } from './authorization.types.js';

@Injectable()
export class AuthorizationDecisionService {
  private readonly logger = new Logger('AuthorizationDecision');

  decide(input: AuthorizationInput): AuthorizationDecision {
    const decision = evaluateAuthorization(input);
    this.logger.log(
      JSON.stringify({
        event: 'authorization.decision',
        decisionId: decision.decisionId,
        effect: decision.effect,
        reasonCode: decision.reasonCode,
        tenantId: input.tenantId,
        userId: input.userId,
        action: input.action,
        resourceTenantId: input.resourceTenantId,
        risk: input.risk,
        obligationTypes: decision.obligations.map((obligation) => obligation.type),
        evaluatedAt: decision.evaluatedAt,
      }),
    );
    return decision;
  }

  require(input: AuthorizationInput): AuthorizationDecision {
    const decision = this.decide(input);
    if (!decision.allowed) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'The requested action is not authorized.',
        reasonCode: decision.reasonCode,
        decisionId: decision.decisionId,
      });
    }
    return decision;
  }
}
