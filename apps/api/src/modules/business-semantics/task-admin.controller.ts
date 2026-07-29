import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  createTaskDependencyRequestSchema,
  createTaskRequestSchema,
  transitionTaskDependencyRequestSchema,
  transitionTaskRequestSchema,
  updateTaskDependencyRequestSchema,
  updateTaskRequestSchema,
  type CreateTaskDependencyRequest,
  type CreateTaskRequest,
  type Task,
  type TaskDependency,
  type TransitionTaskDependencyRequest,
  type TransitionTaskRequest,
  type UpdateTaskDependencyRequest,
  type UpdateTaskRequest,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { TaskAdminService } from './task-admin.service.js';
import { TaskDependencyAdminService } from './task-dependency-admin.service.js';

@Controller('admin/business-semantics/tasks/dependencies')
export class TaskDependencyAdminController {
  constructor(
    @Inject(TaskDependencyAdminService)
    private readonly dependencies: TaskDependencyAdminService,
  ) {}

  @Get()
  list(): Promise<{ items: TaskDependency[] }> {
    return this.dependencies.list();
  }

  @Post()
  create(
    @Body(new SchemaValidationPipe(createTaskDependencyRequestSchema))
    request: CreateTaskDependencyRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<TaskDependency> {
    return this.dependencies.create(request, idempotencyKey);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(updateTaskDependencyRequestSchema))
    request: UpdateTaskDependencyRequest,
  ): Promise<TaskDependency> {
    return this.dependencies.update(id, request);
  }

  @Post(':id/transition')
  transition(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(transitionTaskDependencyRequestSchema))
    request: TransitionTaskDependencyRequest,
  ): Promise<TaskDependency> {
    return this.dependencies.transition(id, request);
  }
}

@Controller('admin/business-semantics/tasks')
export class TaskAdminController {
  constructor(
    @Inject(TaskAdminService)
    private readonly semantics: TaskAdminService,
  ) {}

  @Get()
  list(): Promise<{ items: Task[] }> {
    return this.semantics.listTasks();
  }

  @Post()
  create(
    @Body(new SchemaValidationPipe(createTaskRequestSchema))
    request: CreateTaskRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Task> {
    return this.semantics.createTask(request, idempotencyKey);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(updateTaskRequestSchema))
    request: UpdateTaskRequest,
  ): Promise<Task> {
    return this.semantics.updateTask(id, request);
  }

  @Post(':id/transition')
  transition(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(transitionTaskRequestSchema))
    request: TransitionTaskRequest,
  ): Promise<Task> {
    return this.semantics.transitionTask(id, request);
  }
}
