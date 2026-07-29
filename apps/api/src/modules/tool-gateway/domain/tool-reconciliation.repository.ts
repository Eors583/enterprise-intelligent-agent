import type {
  ClaimedToolReconciliationEvent,
  ParsedToolReconciliationEvent,
  PreparedToolReconciliation,
  ToolReconciliationCompletion,
  ToolReconciliationPreparation,
  ToolReconciliationResolution,
} from './tool-reconciliation.models.js';

export abstract class ToolReconciliationRepository {
  abstract prepare(
    event: ClaimedToolReconciliationEvent,
    request: ParsedToolReconciliationEvent,
  ): Promise<ToolReconciliationPreparation>;

  abstract complete(
    reconciliation: PreparedToolReconciliation,
    resolution: ToolReconciliationResolution,
  ): Promise<ToolReconciliationCompletion>;
}
