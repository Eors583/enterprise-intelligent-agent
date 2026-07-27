import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import {
  type AnswerFeedback,
  type CurrentAnswerFeedbackResponse,
  type UpsertAnswerFeedbackRequest,
  upsertAnswerFeedbackRequestSchema,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { AnswerFeedbackService } from './answer-feedback.service.js';

@Controller('messages')
export class AnswerFeedbackController {
  constructor(@Inject(AnswerFeedbackService) private readonly feedback: AnswerFeedbackService) {}

  @Get(':messageId/feedback')
  getCurrent(
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
  ): Promise<CurrentAnswerFeedbackResponse> {
    return this.feedback.getCurrent(messageId);
  }

  @Put(':messageId/feedback')
  upsert(
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
    @Body(new SchemaValidationPipe(upsertAnswerFeedbackRequestSchema))
    request: UpsertAnswerFeedbackRequest,
  ): Promise<AnswerFeedback> {
    return this.feedback.upsert(messageId, request);
  }
}
