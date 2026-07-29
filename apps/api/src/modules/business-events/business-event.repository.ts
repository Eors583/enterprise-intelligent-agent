import type {
  BusinessEventDelivery,
  BusinessEventDetailResponse,
  BusinessEventEnvelope,
} from '@enterprise/contracts';
import { replayBusinessEventDeliveryRequestSchema } from '@enterprise/contracts';

import type { TrustedRuntimePrincipal } from '../process-orchestration/application/runtime-identity.port.js';
import type {
  RuntimeCursorPage,
  RuntimeCursorRequest,
  RuntimeMutationResult,
} from '../process-orchestration/application/runtime-mutation-result.js';

export type ReplayBusinessEventDeliveryRequest = ReturnType<
  typeof replayBusinessEventDeliveryRequestSchema.parse
>;

export interface ReplayBusinessEventDeliveryInput {
  readonly principal: TrustedRuntimePrincipal;
  readonly deliveryId: string;
  readonly request: ReplayBusinessEventDeliveryRequest;
}

/**
 * Business Event/DLQ persistence boundary. Replay must CAS the DEAD_LETTERED
 * state and write the replay audit/event/outbox records atomically.
 */
export abstract class BusinessEventRepository {
  abstract listEvents(
    principal: TrustedRuntimePrincipal,
    page: RuntimeCursorRequest,
  ): Promise<RuntimeCursorPage<BusinessEventEnvelope>>;

  abstract findEvent(
    principal: TrustedRuntimePrincipal,
    eventId: string,
  ): Promise<BusinessEventDetailResponse | null>;

  abstract replayDelivery(
    input: ReplayBusinessEventDeliveryInput,
  ): Promise<RuntimeMutationResult<BusinessEventDelivery>>;
}
