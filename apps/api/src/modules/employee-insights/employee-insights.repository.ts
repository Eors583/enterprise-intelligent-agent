import type { EmployeeAiUsageSummary, EmployeeExperienceSource } from '@enterprise/contracts';

import type { TrustedRuntimePrincipal } from '../process-orchestration/application/runtime-identity.port.js';

export interface EmployeeUsageWindow {
  readonly from: Date;
  readonly to: Date;
  readonly groupLimit: number;
}

export abstract class EmployeeInsightsRepository {
  abstract experienceSources(
    principal: TrustedRuntimePrincipal,
    taskId: string,
    now: Date,
  ): Promise<EmployeeExperienceSource | null>;

  abstract aiUsage(
    principal: TrustedRuntimePrincipal,
    window: EmployeeUsageWindow,
  ): Promise<
    Pick<EmployeeAiUsageSummary, 'runs' | 'trustedUsage' | 'latency' | 'byAgent' | 'byTask'>
  >;
}
