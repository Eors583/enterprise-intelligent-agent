import { Prisma } from '@prisma/client';

export type FinopsAutoProjectionDiagnosticCode =
  | 'SOURCE_UNKNOWN'
  | 'SOURCE_NOT_TERMINAL'
  | 'SOURCE_MUTATED_AFTER_PROJECTION'
  | 'USAGE_UNREPORTED'
  | 'COST_UNREPORTED'
  | 'EMPTY_USAGE'
  | 'PROVIDER_IDENTITY_MISSING'
  | 'PRICE_MISSING'
  | 'PRICE_AMBIGUOUS'
  | 'PRICE_CURRENCY_MISMATCH'
  | 'PRICE_PRECISION_UNSUPPORTED'
  | 'SETTLEMENT_MISMATCH'
  | 'SOURCE_RECEIPT_INVALID';

export interface FinopsProjectionPrice {
  readonly id: string;
  readonly version: number;
  readonly resourceKind: 'MODEL' | 'TOOL';
  readonly provider: string;
  readonly sku: string;
  readonly currency: string;
  readonly billingUnit: 'INPUT_TOKEN' | 'OUTPUT_TOKEN' | 'TOKEN' | 'REQUEST' | 'CALL' | 'SECOND';
  readonly unitSize: string;
  readonly unitPrice: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly approvedAt: Date | null;
}

export interface AgentRunProjectionSource {
  readonly kind: 'AGENT_RUN';
  readonly id: string;
  readonly version: number;
  readonly status:
    'QUEUED' | 'DISPATCHING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED';
  readonly requesterUserId: string;
  readonly taskId: string | null;
  readonly agentId: string;
  readonly agentVersionId: string;
  readonly runtimeProvider: string | null;
  readonly runtimeModel: string | null;
  readonly tokenEvidence: 'UNREPORTED' | 'PROVIDER_REPORTED' | 'QUOTA_UPPER_BOUND';
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly toolCalls: number;
  readonly costMicros: bigint;
  readonly latencyMs: number | null;
  readonly usageRecordedAt: Date | null;
  readonly costRecordedAt: Date | null;
  readonly finishedAt: Date | null;
}

export interface ToolReceiptProjectionSource {
  readonly kind: 'TOOL_RECEIPT';
  readonly id: string;
  readonly receiptHash: string;
  readonly invocationId: string;
  readonly invocationStatus: string;
  readonly requesterUserId: string;
  readonly roleAssignmentId: string;
  readonly taskId: string;
  readonly processInstanceId: string | null;
  readonly processStepInstanceId: string | null;
  readonly agentRunId: string | null;
  readonly toolVersionId: string;
  readonly toolVersion: number;
  readonly toolKey: string;
  readonly adapter: string;
  readonly source: 'PROVIDER' | 'COMPENSATOR';
  readonly outcome:
    'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED' | 'COMPENSATED' | 'COMPENSATION_FAILED';
  readonly providerRequestId: string | null;
  readonly providerDryRun: boolean;
  readonly executionAttempt: number;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly latencyMs: number;
  readonly costAttestation: 'UNATTESTED' | 'PROVIDER_ATTESTED' | 'GATEWAY_ATTESTED';
  readonly costMicros: bigint | null;
}

export type FinopsProjectionSource = AgentRunProjectionSource | ToolReceiptProjectionSource;

export interface FinopsProjectionLine {
  readonly price: FinopsProjectionPrice;
  readonly quantity: Prisma.Decimal;
  readonly calculatedAmount: Prisma.Decimal;
  readonly billingUnit: FinopsProjectionPrice['billingUnit'];
}

export type FinopsAutoProjectionDecision =
  | {
      readonly kind: 'BLOCKED';
      readonly code: FinopsAutoProjectionDiagnosticCode;
      readonly detail: string;
      readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
    }
  | {
      readonly kind: 'PROJECT';
      readonly currency: string;
      readonly expectedCostMicros: bigint;
      readonly lines: readonly FinopsProjectionLine[];
      readonly incurredAt: Date;
      readonly recordedByUserId: string;
      readonly provider: string;
      readonly sku: string;
      readonly sourceAuthority: 'RUNTIME_ATTESTED' | 'TRUSTED_SYSTEM';
      readonly dimensions: Readonly<Record<string, string | number | boolean | null>>;
    };

const TERMINAL_AGENT_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const TERMINAL_TOOL_STATUSES = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'COMPENSATED',
  'COMPENSATION_FAILED',
]);
const MICROS_PER_CURRENCY_UNIT = new Prisma.Decimal(1_000_000);

export function decideFinopsAutoProjection(
  source: FinopsProjectionSource,
  prices: readonly FinopsProjectionPrice[],
): FinopsAutoProjectionDecision {
  return source.kind === 'AGENT_RUN'
    ? decideAgentRunProjection(source, prices)
    : decideToolReceiptProjection(source, prices);
}

function decideAgentRunProjection(
  source: AgentRunProjectionSource,
  prices: readonly FinopsProjectionPrice[],
): FinopsAutoProjectionDecision {
  if (source.status === 'UNKNOWN') {
    return blocked(
      'SOURCE_UNKNOWN',
      'UNKNOWN Agent Runs are never admitted to the trusted ledger.',
      {
        status: source.status,
      },
    );
  }
  if (!TERMINAL_AGENT_STATUSES.has(source.status) || source.finishedAt === null) {
    return blocked(
      'SOURCE_NOT_TERMINAL',
      'The Agent Run does not have a confirmed terminal settlement.',
      { status: source.status },
    );
  }
  if (source.tokenEvidence !== 'PROVIDER_REPORTED' || source.usageRecordedAt === null) {
    return blocked(
      'USAGE_UNREPORTED',
      'Only positive provider-reported Token evidence can enter the trusted cost ledger.',
      { tokenEvidence: source.tokenEvidence },
    );
  }
  if (
    source.inputTokens < 0 ||
    source.outputTokens < 0 ||
    source.totalTokens <= 0 ||
    source.totalTokens < source.inputTokens + source.outputTokens
  ) {
    return blocked(
      'EMPTY_USAGE',
      'Unreported or all-zero token usage cannot be represented as a trusted zero-cost run.',
      {
        inputTokens: source.inputTokens,
        outputTokens: source.outputTokens,
        totalTokens: source.totalTokens,
      },
    );
  }
  const provider = normalizedIdentity(source.runtimeProvider);
  const sku = normalizedIdentity(source.runtimeModel);
  if (provider === null || sku === null) {
    return blocked(
      'PROVIDER_IDENTITY_MISSING',
      'The settled Agent Run is missing its exact Runtime provider or model identity.',
      {},
    );
  }

  const eligible = effectivePrices(prices, 'MODEL', provider, sku, source.finishedAt);
  const tokenPrices = byUnit(eligible, 'TOKEN');
  const inputPrices = byUnit(eligible, 'INPUT_TOKEN');
  const outputPrices = byUnit(eligible, 'OUTPUT_TOKEN');
  const needsInput = source.inputTokens > 0;
  const needsOutput = source.outputTokens > 0;
  const hasSplitPricing =
    (needsInput && inputPrices.length > 0) || (needsOutput && outputPrices.length > 0);

  if (tokenPrices.length > 0 && hasSplitPricing) {
    return priceAmbiguous(provider, sku, 'TOKEN and split INPUT/OUTPUT prices overlap.');
  }

  let selected: Array<{ price: FinopsProjectionPrice; quantity: number }>;
  if (tokenPrices.length > 0) {
    if (tokenPrices.length !== 1) {
      return priceAmbiguous(provider, sku, 'Multiple effective TOKEN prices overlap.');
    }
    selected = [{ price: tokenPrices[0]!, quantity: source.totalTokens }];
  } else {
    if ((needsInput && inputPrices.length === 0) || (needsOutput && outputPrices.length === 0)) {
      return blocked(
        'PRICE_MISSING',
        'No complete approved and effective model price set matches this provider/model.',
        { provider, sku },
      );
    }
    if (inputPrices.length > 1 || outputPrices.length > 1) {
      return priceAmbiguous(provider, sku, 'Multiple effective INPUT/OUTPUT prices overlap.');
    }
    selected = [
      ...(needsInput ? [{ price: inputPrices[0]!, quantity: source.inputTokens }] : []),
      ...(needsOutput ? [{ price: outputPrices[0]!, quantity: source.outputTokens }] : []),
    ];
  }

  return finalizeProjection(
    selected,
    source.costRecordedAt === null ? null : source.costMicros,
    source.finishedAt,
    source.requesterUserId,
    provider,
    sku,
    {
      sourceKind: source.kind,
      runStatus: source.status,
      taskId: source.taskId,
      requesterUserId: source.requesterUserId,
      agentId: source.agentId,
      agentVersionId: source.agentVersionId,
      inputTokens: source.inputTokens,
      outputTokens: source.outputTokens,
      totalTokens: source.totalTokens,
      toolCalls: source.toolCalls,
      latencyMs: source.latencyMs,
      tokenEvidence: source.tokenEvidence,
      costBasis: source.costRecordedAt === null ? 'APPROVED_PRICE_SNAPSHOT' : 'PROVIDER_ATTESTED',
    },
  );
}

function decideToolReceiptProjection(
  source: ToolReceiptProjectionSource,
  prices: readonly FinopsProjectionPrice[],
): FinopsAutoProjectionDecision {
  if (source.outcome === 'UNKNOWN' || source.invocationStatus === 'UNKNOWN') {
    return blocked(
      'SOURCE_UNKNOWN',
      'UNKNOWN Tool delivery cannot enter the trusted ledger before reconciliation.',
      { outcome: source.outcome, invocationStatus: source.invocationStatus },
    );
  }
  if (!TERMINAL_TOOL_STATUSES.has(source.invocationStatus)) {
    return blocked(
      'SOURCE_NOT_TERMINAL',
      'The Tool Invocation does not have a confirmed terminal settlement.',
      { outcome: source.outcome, invocationStatus: source.invocationStatus },
    );
  }
  if (
    source.providerRequestId === null ||
    source.receiptHash.length !== 64 ||
    source.completedAt < source.startedAt ||
    source.latencyMs < 0 ||
    (source.costMicros !== null && source.costMicros < 0n) ||
    (source.costAttestation === 'UNATTESTED' && source.costMicros !== null) ||
    (source.costAttestation !== 'UNATTESTED' && source.costMicros === null)
  ) {
    return blocked(
      'SOURCE_RECEIPT_INVALID',
      'The immutable Tool settlement receipt is incomplete or internally inconsistent.',
      {},
    );
  }
  const provider = normalizedIdentity(source.adapter);
  const sku = normalizedIdentity(source.toolKey);
  if (provider === null || sku === null) {
    return blocked(
      'PROVIDER_IDENTITY_MISSING',
      'The settled Tool receipt is missing its exact adapter or Tool key.',
      {},
    );
  }
  const eligible = effectivePrices(prices, 'TOOL', provider, sku, source.completedAt).filter(
    ({ billingUnit }) =>
      billingUnit === 'CALL' || billingUnit === 'REQUEST' || billingUnit === 'SECOND',
  );
  if (eligible.length === 0) {
    return blocked(
      'PRICE_MISSING',
      'No approved and effective Tool price matches this adapter/Tool key.',
      { provider, sku },
    );
  }
  if (eligible.length !== 1) {
    return priceAmbiguous(provider, sku, 'Multiple effective Tool billing prices overlap.');
  }
  const price = eligible[0]!;
  const quantity =
    price.billingUnit === 'SECOND'
      ? new Prisma.Decimal(source.latencyMs).div(1_000)
      : new Prisma.Decimal(1);
  return finalizeProjection(
    [{ price, quantity }],
    source.costMicros,
    source.completedAt,
    source.requesterUserId,
    provider,
    sku,
    {
      sourceKind: source.kind,
      outcome: source.outcome,
      source: source.source,
      invocationStatus: source.invocationStatus,
      invocationId: source.invocationId,
      requesterUserId: source.requesterUserId,
      roleAssignmentId: source.roleAssignmentId,
      taskId: source.taskId,
      processInstanceId: source.processInstanceId,
      processStepInstanceId: source.processStepInstanceId,
      agentRunId: source.agentRunId,
      toolVersionId: source.toolVersionId,
      toolVersion: source.toolVersion,
      executionAttempt: source.executionAttempt,
      providerDryRun: source.providerDryRun,
      latencyMs: source.latencyMs,
      costBasis:
        source.costAttestation === 'UNATTESTED'
          ? 'APPROVED_PRICE_SNAPSHOT'
          : source.costAttestation,
    },
  );
}

function finalizeProjection(
  selected: readonly {
    readonly price: FinopsProjectionPrice;
    readonly quantity: number | Prisma.Decimal;
  }[],
  reportedCostMicros: bigint | null,
  incurredAt: Date,
  recordedByUserId: string,
  provider: string,
  sku: string,
  dimensions: Readonly<Record<string, string | number | boolean | null>>,
): FinopsAutoProjectionDecision {
  if (selected.length === 0) {
    return blocked('PRICE_MISSING', 'No billable quantity has an approved price.', {
      provider,
      sku,
    });
  }
  const currencies = new Set(selected.map(({ price }) => price.currency));
  if (currencies.size !== 1) {
    return blocked(
      'PRICE_CURRENCY_MISMATCH',
      'One settlement cannot be verified against prices in different currencies.',
      { provider, sku },
    );
  }
  const lines = selected.map(({ price, quantity }) => {
    const decimalQuantity =
      quantity instanceof Prisma.Decimal ? quantity : new Prisma.Decimal(quantity);
    return {
      price,
      quantity: decimalQuantity,
      calculatedAmount: decimalQuantity
        .div(new Prisma.Decimal(price.unitSize))
        .mul(new Prisma.Decimal(price.unitPrice)),
      billingUnit: price.billingUnit,
    } satisfies FinopsProjectionLine;
  });
  if (lines.some(({ quantity }) => quantity.lte(0))) {
    return blocked(
      'EMPTY_USAGE',
      'A trusted ledger entry must have a strictly positive billable quantity.',
      { provider, sku },
    );
  }
  const totalAmount = lines.reduce(
    (total, line) => total.add(line.calculatedAmount),
    new Prisma.Decimal(0),
  );
  const decimalMicros = totalAmount.mul(MICROS_PER_CURRENCY_UNIT);
  if (!decimalMicros.isInteger()) {
    return blocked(
      'PRICE_PRECISION_UNSUPPORTED',
      'The approved price produces sub-micro currency precision and cannot be verified exactly.',
      { provider, sku },
    );
  }
  const expectedCostMicros = BigInt(decimalMicros.toFixed(0));
  if (reportedCostMicros !== null && expectedCostMicros !== reportedCostMicros) {
    return blocked(
      'SETTLEMENT_MISMATCH',
      'The attested settlement cost does not equal the approved price calculation.',
      {
        provider,
        sku,
        expectedCostMicros: expectedCostMicros.toString(),
        reportedCostMicros: reportedCostMicros.toString(),
      },
    );
  }
  return {
    kind: 'PROJECT',
    currency: [...currencies][0]!,
    expectedCostMicros,
    lines,
    incurredAt,
    recordedByUserId,
    provider,
    sku,
    sourceAuthority: reportedCostMicros === null ? 'TRUSTED_SYSTEM' : 'RUNTIME_ATTESTED',
    dimensions,
  };
}

function effectivePrices(
  prices: readonly FinopsProjectionPrice[],
  resourceKind: FinopsProjectionPrice['resourceKind'],
  provider: string,
  sku: string,
  incurredAt: Date,
): readonly FinopsProjectionPrice[] {
  return prices.filter(
    (price) =>
      price.resourceKind === resourceKind &&
      price.provider === provider &&
      price.sku === sku &&
      price.approvedAt !== null &&
      price.effectiveFrom <= incurredAt &&
      (price.effectiveTo === null || price.effectiveTo > incurredAt),
  );
}

function byUnit(
  prices: readonly FinopsProjectionPrice[],
  unit: FinopsProjectionPrice['billingUnit'],
): readonly FinopsProjectionPrice[] {
  return prices.filter(({ billingUnit }) => billingUnit === unit);
}

function normalizedIdentity(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? null : normalized;
}

function priceAmbiguous(
  provider: string,
  sku: string,
  detail: string,
): FinopsAutoProjectionDecision {
  return blocked('PRICE_AMBIGUOUS', detail, { provider, sku });
}

function blocked(
  code: FinopsAutoProjectionDiagnosticCode,
  detail: string,
  metadata: Readonly<Record<string, string | number | boolean | null>>,
): FinopsAutoProjectionDecision {
  return { kind: 'BLOCKED', code, detail, metadata };
}
