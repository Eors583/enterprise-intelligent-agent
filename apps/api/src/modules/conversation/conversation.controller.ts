import {
  Body,
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  Headers,
  Inject,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  AGENT_RUN_STREAM_MAX_CURSOR,
  type AgentRunStreamPage,
  type AgentRunResponse,
  conversationListQuerySchema,
  createConversationRequestSchema,
  createMessageRequestSchema,
  markConversationReadRequestSchema,
  messageListQuerySchema,
  messageSearchQuerySchema,
  type Conversation,
  type ConversationListQuery,
  type ConversationListResponse,
  type CreateConversationRequest,
  type CreateMessageRequest,
  type Message,
  type MessageListQuery,
  type MessageListResponse,
  type MessageSearchQuery,
  type MessageSearchResponse,
  type MarkConversationReadRequest,
  type UpdateConversationStateRequest,
  type UpdateGroupMembersRequest,
  type UpdateGroupRequest,
  updateConversationStateRequestSchema,
  updateGroupMembersRequestSchema,
  updateGroupRequestSchema,
} from '@enterprise/contracts';
import type { Request, Response } from 'express';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { ConversationService } from './conversation.service.js';
import { AgentRunControlService } from '../agent-run/application/agent-run-control.service.js';
import { AgentRunStreamService } from '../agent-run/application/agent-run-stream.service.js';

@Controller('conversations')
export class ConversationController {
  constructor(
    @Inject(ConversationService) private readonly conversations: ConversationService,
    @Inject(AgentRunControlService) private readonly agentRuns: AgentRunControlService,
    @Inject(AgentRunStreamService) private readonly runStreams: AgentRunStreamService,
  ) {}

  @Get()
  list(
    @Query(new SchemaValidationPipe(conversationListQuerySchema)) query: ConversationListQuery,
  ): Promise<ConversationListResponse> {
    return this.conversations.list(query);
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
    @Query(new SchemaValidationPipe(messageListQuerySchema)) query: MessageListQuery,
  ): Promise<MessageListResponse> {
    return this.conversations.listMessages(conversationId, query);
  }

  @Get(':id/messages/search')
  searchMessages(
    @Param('id', new ParseUUIDPipe()) conversationId: string,
    @Query(new SchemaValidationPipe(messageSearchQuerySchema)) query: MessageSearchQuery,
  ): Promise<MessageSearchResponse> {
    return this.conversations.searchMessages(conversationId, query);
  }

  @Post(':id/messages')
  createMessage(
    @Param('id', new ParseUUIDPipe()) conversationId: string,
    @Body(new SchemaValidationPipe(createMessageRequestSchema)) request: CreateMessageRequest,
  ): Promise<Message> {
    return this.conversations.createMessage(conversationId, request);
  }

  @Post(':id/read')
  markRead(
    @Param('id', new ParseUUIDPipe()) conversationId: string,
    @Body(new SchemaValidationPipe(markConversationReadRequestSchema))
    request: MarkConversationReadRequest,
  ): Promise<Conversation> {
    return this.conversations.markRead(conversationId, request);
  }

  @Patch(':id/state')
  updateState(
    @Param('id', new ParseUUIDPipe()) conversationId: string,
    @Body(new SchemaValidationPipe(updateConversationStateRequestSchema))
    request: UpdateConversationStateRequest,
  ): Promise<Conversation> {
    return this.conversations.updateState(conversationId, request);
  }

  @Patch(':id/group')
  renameGroup(
    @Param('id', new ParseUUIDPipe()) conversationId: string,
    @Body(new SchemaValidationPipe(updateGroupRequestSchema)) request: UpdateGroupRequest,
  ): Promise<Conversation> {
    return this.conversations.renameGroup(conversationId, request);
  }

  @Patch(':id/group/members')
  updateGroupMembers(
    @Param('id', new ParseUUIDPipe()) conversationId: string,
    @Body(new SchemaValidationPipe(updateGroupMembersRequestSchema))
    request: UpdateGroupMembersRequest,
  ): Promise<Conversation> {
    return this.conversations.updateGroupMembers(conversationId, request);
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

  @Post(':id/runs/:runId/abandon')
  abandonUnknownRun(
    @Param('id', new ParseUUIDPipe()) conversationId: string,
    @Param('runId', new ParseUUIDPipe()) runId: string,
  ): Promise<AgentRunResponse> {
    return this.agentRuns.abandonUnknown(conversationId, runId);
  }

  @Get(':id/runs/:runId/events')
  listRunEvents(
    @Param('id', new ParseUUIDPipe()) conversationId: string,
    @Param('runId', new ParseUUIDPipe()) runId: string,
    @Query('cursor', new DefaultValuePipe(0), new ParseIntPipe()) cursor: number,
    @Query('limit', new DefaultValuePipe(128), new ParseIntPipe()) limit: number,
  ): Promise<AgentRunStreamPage> {
    assertCursor(cursor);
    return this.runStreams.list(conversationId, runId, cursor, limit);
  }

  @Get(':id/runs/:runId/stream')
  async streamRunEvents(
    @Param('id', new ParseUUIDPipe()) conversationId: string,
    @Param('runId', new ParseUUIDPipe()) runId: string,
    @Query('cursor', new DefaultValuePipe(0), new ParseIntPipe()) queryCursor: number,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    let cursor = Math.max(queryCursor, parseLastEventId(runId, lastEventId));
    assertCursor(cursor);
    // Authorize before committing streaming headers.
    let page = await this.runStreams.list(conversationId, runId, cursor, 128);
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store, no-transform');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    let closed = false;
    const markClosed = (): void => {
      closed = true;
    };
    request.once('close', markClosed);
    let lastHeartbeat = Date.now();
    try {
      while (!closed) {
        for (const event of page.items) {
          if (closed) return;
          const writable = await writeSseChunk(
            request,
            response,
            `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
          if (!writable) return;
          cursor = event.sequence;
        }
        if (page.terminal) return;
        if (Date.now() - lastHeartbeat >= 15_000) {
          if (!(await writeSseChunk(request, response, ': heartbeat\n\n'))) return;
          lastHeartbeat = Date.now();
        }
        await waitForNextPage(request, 250);
        if (closed) return;
        page = await this.runStreams.list(conversationId, runId, cursor, 128);
      }
    } finally {
      request.removeListener('close', markClosed);
      response.end();
    }
  }
}

function assertCursor(cursor: number): void {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > AGENT_RUN_STREAM_MAX_CURSOR) {
    throw new BadRequestException('Agent Run stream cursor is out of bounds.');
  }
}

export function parseLastEventId(runId: string, value: string | undefined): number {
  if (value === undefined) return 0;
  const prefix = `${runId}:`;
  if (!value.startsWith(prefix)) {
    throw new BadRequestException('Last-Event-ID does not belong to this Run.');
  }
  const suffix = value.slice(prefix.length);
  if (!/^(?:0|[1-9][0-9]{0,4})$/.test(suffix)) {
    throw new BadRequestException('Last-Event-ID has an invalid cursor.');
  }
  const cursor = Number(suffix);
  assertCursor(cursor);
  return cursor;
}

function waitForNextPage(request: Request, delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const onClose = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      request.removeListener('close', onClose);
      resolve();
    }, delayMs);
    timer.unref();
    request.once('close', onClose);
  });
}

function writeSseChunk(request: Request, response: Response, chunk: string): Promise<boolean> {
  if (request.destroyed || response.destroyed || response.writableEnded) {
    return Promise.resolve(false);
  }
  if (response.write(chunk)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const cleanup = (): void => {
      request.removeListener('close', onClose);
      response.removeListener('drain', onDrain);
    };
    const onClose = (): void => {
      cleanup();
      resolve(false);
    };
    const onDrain = (): void => {
      cleanup();
      resolve(true);
    };
    request.once('close', onClose);
    response.once('drain', onDrain);
    if (request.destroyed || response.destroyed || response.writableEnded) onClose();
  });
}
