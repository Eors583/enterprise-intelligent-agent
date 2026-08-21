import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  replayBusinessEventDeliveryRequestSchema,
  type BusinessEventDelivery,
  type BusinessEventDetailResponse,
  type BusinessEventListResponse,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import type { ReplayBusinessEventDeliveryRequest } from './business-event.repository.js';
import { BusinessEventService } from './business-event.service.js';

@Controller('admin/business-events')
export class BusinessEventController {
  constructor(
    @Inject(BusinessEventService)
    private readonly events: BusinessEventService,
  ) {}

  @Get('events')
  listEvents(@Query('cursor') cursor?: string): Promise<BusinessEventListResponse> {
    return this.events.listEvents(cursor);
  }

  @Get('events/:eventId')
  getEvent(
    @Param('eventId', new ParseUUIDPipe()) eventId: string,
  ): Promise<BusinessEventDetailResponse> {
    return this.events.getEvent(eventId);
  }

  @Post('deliveries/:deliveryId/replay')
  replayDelivery(
    @Param('deliveryId', new ParseUUIDPipe()) deliveryId: string,
    @Body(new SchemaValidationPipe(replayBusinessEventDeliveryRequestSchema))
    request: ReplayBusinessEventDeliveryRequest,
  ): Promise<BusinessEventDelivery> {
    return this.events.replayDelivery(deliveryId, request);
  }
}
