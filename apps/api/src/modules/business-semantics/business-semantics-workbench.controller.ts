import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import type {
  BusinessSemanticTraceResponse,
  WorkbenchObjectiveListResponse,
  WorkbenchTaskListResponse,
} from '@enterprise/contracts';

import { BusinessSemanticsWorkbenchService } from './business-semantics-workbench.service.js';

@Controller('workbench')
export class BusinessSemanticsWorkbenchController {
  constructor(
    @Inject(BusinessSemanticsWorkbenchService)
    private readonly workbench: BusinessSemanticsWorkbenchService,
  ) {}

  @Get('objectives')
  listObjectives(): Promise<WorkbenchObjectiveListResponse> {
    return this.workbench.listObjectives();
  }

  @Get('tasks')
  listTasks(): Promise<WorkbenchTaskListResponse> {
    return this.workbench.listTasks();
  }

  @Get('tasks/:id/trace')
  trace(@Param('id', new ParseUUIDPipe()) id: string): Promise<BusinessSemanticTraceResponse> {
    return this.workbench.trace(id);
  }
}
