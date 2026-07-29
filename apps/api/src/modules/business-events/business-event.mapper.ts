import { ConflictException } from '@nestjs/common';
import {
  businessEventDeliverySchema,
  businessEventDetailResponseSchema,
  businessEventListResponseSchema,
  type BusinessEventDelivery,
  type BusinessEventDetailResponse,
  type BusinessEventEnvelope,
  type BusinessEventListResponse,
} from '@enterprise/contracts';

import type { RuntimeCursorPage } from '../process-orchestration/application/runtime-mutation-result.js';

export function mapBusinessEventPage(
  tenantId: string,
  page: RuntimeCursorPage<BusinessEventEnvelope>,
): BusinessEventListResponse {
  return parseEventContract(
    businessEventListResponseSchema,
    {
      items: page.items,
      pageInfo: {
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
      },
    },
    'Business Event list',
    (response) => response.items.every((event) => event.tenantId === tenantId),
  );
}

export function mapBusinessEventDetail(
  tenantId: string,
  eventId: string,
  value: BusinessEventDetailResponse,
): BusinessEventDetailResponse {
  return parseEventContract(
    businessEventDetailResponseSchema,
    value,
    'Business Event detail',
    (response) =>
      response.event.tenantId === tenantId &&
      response.event.eventId === eventId &&
      response.deliveries.every((delivery) => delivery.tenantId === tenantId),
  );
}

export function mapReplayedDelivery(
  tenantId: string,
  deliveryId: string,
  value: BusinessEventDelivery,
): BusinessEventDelivery {
  return parseEventContract(
    businessEventDeliverySchema,
    value,
    'Business Event delivery replay',
    (response) => response.tenantId === tenantId && response.id === deliveryId,
  );
}

interface ContractSchema<T> {
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: T } | { readonly success: false };
}

function parseEventContract<T>(
  schema: ContractSchema<T>,
  value: unknown,
  resource: string,
  additionalInvariant: (parsed: T) => boolean,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success || !additionalInvariant(parsed.data)) {
    throw new ConflictException(
      `${resource} returned by the persistence adapter is structurally inconsistent.`,
    );
  }
  return parsed.data;
}
