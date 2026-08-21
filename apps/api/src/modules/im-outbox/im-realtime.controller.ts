import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { ImRealtimeSession } from '@enterprise/contracts';

import { ImRealtimeSessionService } from './application/im-realtime-session.service.js';

@Controller('im')
export class ImRealtimeController {
  constructor(
    @Inject(ImRealtimeSessionService)
    private readonly realtime: ImRealtimeSessionService,
  ) {}

  @Get('session')
  @Header('Cache-Control', 'no-store')
  createSession(): Promise<ImRealtimeSession> {
    return this.realtime.create();
  }
}
