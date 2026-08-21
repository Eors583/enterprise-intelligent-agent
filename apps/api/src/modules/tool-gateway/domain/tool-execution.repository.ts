import type { PreparedHttpTarget } from '../tool-execution.port.js';
import type {
  ParsedToolCommandEvent,
  PreparedToolExecution,
  ToolDnsProofInput,
  ToolExecutionInspection,
  ToolExecutionSettlement,
  ToolExecutionStartResult,
} from './tool-execution.models.js';

export abstract class ToolExecutionRepository {
  abstract inspect(
    tenantId: string,
    invocationId: string,
    event: ParsedToolCommandEvent,
  ): Promise<ToolExecutionInspection>;

  abstract start(execution: PreparedToolExecution): Promise<ToolExecutionStartResult>;

  abstract recordDnsProof(input: ToolDnsProofInput): Promise<void>;

  abstract settle(
    execution: PreparedToolExecution,
    settlement: ToolExecutionSettlement,
    target: PreparedHttpTarget | null,
  ): Promise<boolean>;

  abstract failBeforeDispatch(
    execution: PreparedToolExecution,
    reasonCode: string,
    detail: string,
  ): Promise<boolean>;

  abstract markAmbiguous(execution: PreparedToolExecution, reasonCode: string): Promise<boolean>;
}
