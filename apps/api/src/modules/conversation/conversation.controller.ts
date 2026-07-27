import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  type AgentRunResponse,
  createConversationRequestSchema,
  createMessageRequestSchema,
  type Conversation,
  type ConversationListResponse,
  type CreateConversationRequest,
  type CreateMessageRequest,
  type Message,
  type MessageListResponse,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { ConversationService } from './conversation.service.js';
import { AgentRunControlService } from '../agent-run/application/agent-run-control.service.js';

@Controller('conversations')
export class ConversationController {
  constructor(
    @Inject(ConversationService) private readonly conversations: ConversationService,
    @Inject(AgentRunControlService) private readonly agentRuns: AgentRunControlService,
  ) {}

  @Get()
  list(): Promise<ConversationListResponse> {
    return this.conversations.list();
  }

  @Post()
  create(
    @Body(new SchemaValidationPipe(createConversationRequestSchema))
    request: CreateConversationRequest,
  ): Promise<Conversation> {
    return this.conversations.create(request);
  }

  @Get(':id/messages')
  listMessages(
    @Param('id', new ParseUUIDPipe()) conversationId: string,
  ): Promise<MessageListResponse> {
    return this.conversations.listMessages(conversationId);
  }

  @Post(':id/messages')
  createMessage(
    @Param('id', new ParseUUIDPipe()) conversationId: string,
    @Body(new SchemaValidationPipe(createMessageRequestSchema)) request: CreateMessageRequest,
  ): Promise<Message> {
    return this.conversations.createMessage(conversationId, request);
  }

  @Post(':id/runs/:runId/cancel')
  cancelRun(
    @Param('id', new ParseUUIDPipe()) conversationId: string,
    @Param('runId', new ParseUUIDPipe()) runId: string,
  ): Promise<AgentRunResponse> {
    return this.agentRuns.cancel(conversationId, runId);
  }

  @Post(':id/runs/:runId/retry')
  retryRun(
    @Param('id', new ParseUUIDPipe()) conversationId: string,
    @Param('runId', new ParseUUIDPipe()) runId: string,
  ): Promise<AgentRunResponse> {
    return this.agentRuns.retry(conversationId, runId);
  }
}
