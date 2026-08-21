import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  BusinessEventDelivery,
  BusinessEventDetailResponse,
  BusinessEventListResponse,
} from '@enterprise/contracts';

import { requireRuntimeAdministrator } from '../process-orchestration/application/runtime-admin.policy.js';
import {
  normalizeRuntimeCursor,
  unwrapRuntimeMutation,
} from '../process-orchestration/application/runtime-http-errors.js';
import { RuntimeIdentityPort } from '../process-orchestration/application/runtime-identity.port.js';
import {
  BusinessEventRepository,
  type ReplayBusinessEventDeliveryRequest,
} from './business-event.repository.js';
import {
  mapBusinessEventDetail,
  mapBusinessEventPage,
  mapReplayedDelivery,
} from './business-event.mapper.js';

const PAGE_SIZE = 100;

@Injectable()
export class BusinessEventService {
  constructor(
    @Inject(BusinessEventRepository)
    private readonly repository: BusinessEventRepository,
    @Inject(RuntimeIdentityPort)
    private readonly identity: RuntimeIdentityPort,
  ) {}

  async listEvents(cursor?: string): Promise<BusinessEventListResponse> {
    const principal = this.requireAdministrator();
    const page = await this.repository.listEvents(principal, {
      cursor: normalizeRuntimeCursor(cursor),
      limit: PAGE_SIZE,
    });
    return mapBusinessEventPage(principal.tenantId, page);
  }

  async getEvent(eventId: string): Promise<BusinessEventDetailResponse> {
    const principal = this.requireAdministrator();
    const detail = await this.repository.findEvent(principal, eventId);
    if (detail === null) {
      throw new NotFoundException('Business Event was not found.');
    }
    return mapBusinessEventDetail(principal.tenantId, eventId, detail);
  }

  async replayDelivery(
    deliveryId: string,
    request: ReplayBusinessEventDeliveryRequest,
  ): Promise<BusinessEventDelivery> {
    const principal = this.requireAdministrator();
    const value = unwrapRuntimeMutation(
      await this.repository.replayDelivery({
        principal,
        deliveryId,
        request,
      }),
      'Business Event delivery',
    );
    return mapReplayedDelivery(principal.tenantId, deliveryId, value);
  }

  private requireAdministrator() {
    const principal = this.identity.current();
    requireRuntimeAdministrator(principal);
    return principal;
  }
}
