export const OUTBOX_CONSUMER = {
  imDelivery: 'im-delivery',
  agentRun: 'agent-run-worker',
  toolExecution: 'tool-execution-worker',
  toolReconciliation: 'tool-reconciliation-worker',
  feishuDirectory: 'feishu-directory-worker',
} as const;

export const OUTBOX_LANE = {
  imMessage: 'im.message',
  agentRunExecution: 'agent.run.execute',
  agentRunCancellation: 'agent.run.cancel',
  toolExecution: 'tool.execute',
  toolReconciliation: 'tool.reconcile',
  feishuDirectorySync: 'directory.feishu.sync',
} as const;

export const OUTBOX_DELIVERY_ROUTES = {
  'message.created.v1': {
    consumerKey: OUTBOX_CONSUMER.imDelivery,
    lane: OUTBOX_LANE.imMessage,
  },
  'agent.run_requested.v1': {
    consumerKey: OUTBOX_CONSUMER.agentRun,
    lane: OUTBOX_LANE.agentRunExecution,
  },
  'agent.run_cancel_requested.v1': {
    consumerKey: OUTBOX_CONSUMER.agentRun,
    lane: OUTBOX_LANE.agentRunCancellation,
  },
  ToolInvocationCommandRecorded: {
    consumerKey: OUTBOX_CONSUMER.toolExecution,
    lane: OUTBOX_LANE.toolExecution,
  },
  'ToolInvocation.ReconciliationRequested': {
    consumerKey: OUTBOX_CONSUMER.toolReconciliation,
    lane: OUTBOX_LANE.toolReconciliation,
  },
  'admin.directory.feishu.sync.requested.v1': {
    consumerKey: OUTBOX_CONSUMER.feishuDirectory,
    lane: OUTBOX_LANE.feishuDirectorySync,
  },
} as const;

export const OUTBOX_FACT_ONLY_EVENT_TYPES = [
  'agent.answer-feedback.recorded.v1',
  'AiEvaluationAnnotationChanged',
  'AiEvaluationBadCaseChanged',
  'AiEvaluationCaseChanged',
  'AiEvaluationDatasetChanged',
  'AiEvaluationDatasetVersionChanged',
  'AiEvaluationReleaseReadinessChecked',
  'AiEvaluationRunChanged',
  'AiEvaluationRunnerAttestationVerified',
  'AiModelAttemptReceiptRecorded',
  'AiModelCatalogVersionChanged',
  'AiModelCircuitStateChanged',
  'AiModelRoutePolicyVersionChanged',
  'AiSafetyDecisionRecorded',
  'BusinessEventDelivery.Replayed',
  'Collaboration.Requested',
  'conversation.created.v1',
  'Correction.FeedbackSubmitted',
  'ExperienceCandidateCreated',
  'experience.knowledge-projection.status-changed.v1',
  'finops.cost.auto_projected.v1',
  'finops.projection.blocked.v1',
  'finops.projection.resolved.v1',
  'IdentityBreakGlassActivate.v1',
  'IdentityBreakGlassApprove.v1',
  'IdentityBreakGlassExpire.v1',
  'IdentityBreakGlassReject.v1',
  'IdentityBreakGlassRequest.v1',
  'IdentityBreakGlassReview_close.v1',
  'IdentityBreakGlassRevoke.v1',
  'IdentityGovernanceCommandApplied.v1',
  'IdentityGovernanceCommandRejected.v1',
  'IdentityPrincipalDeprovisioned.v1',
  'knowledge.document-version.governance-reviewed.v1',
  'knowledge.document-version.governance-updated.v1',
  'knowledge.document-version.parse-reviewed.v1',
  'knowledge.document-version.published.v1',
  'knowledge.graph.conflict.created',
  'knowledge.graph.correction.apply',
  'knowledge.graph.correction.approve',
  'knowledge.graph.correction.created',
  'knowledge.graph.correction.reject',
  'knowledge.graph.correction.submit',
  'knowledge.graph.ontology.created',
  'knowledge.graph.ontology_version.created',
  'knowledge.graph.ontology_version.publish',
  'knowledge.graph.ontology_version.request_changes',
  'knowledge.graph.ontology_version.retire',
  'knowledge.graph.ontology_version.submit',
  'MemoryCandidateCreated',
  'Process.Started',
  'ToolDefinition.Created',
  'ToolVersion.DraftCreated',
] as const;

/**
 * Dynamic lifecycle facts are intentionally restricted to reviewed namespaces.
 * Prefix routes are FACT_ONLY; any work-producing event must use an exact
 * OUTBOX_DELIVERY_ROUTES entry so a new command cannot silently gain a worker.
 */
export const OUTBOX_FACT_ONLY_PREFIXES = [
  'admin.knowledge-document-version.',
  'admin.knowledge-graph-',
  'business_semantics.',
  'Experience',
  'finops.',
  'knowledge.graph.',
  'marketing.',
  'Memory',
  'organization.',
  'people.',
  'ProcessInstance.',
  'ProcessStep.',
  'ToolVersion.',
] as const;

export type OutboxCatalogRoute =
  | {
      readonly purpose: 'DELIVERY';
      readonly consumerKey: (typeof OUTBOX_CONSUMER)[keyof typeof OUTBOX_CONSUMER];
      readonly lane: (typeof OUTBOX_LANE)[keyof typeof OUTBOX_LANE];
    }
  | { readonly purpose: 'FACT_ONLY' };

const factOnlyEventTypes = new Set<string>(OUTBOX_FACT_ONLY_EVENT_TYPES);

export function outboxCatalogRoute(eventType: string): OutboxCatalogRoute | null {
  const delivery = OUTBOX_DELIVERY_ROUTES[eventType as keyof typeof OUTBOX_DELIVERY_ROUTES];
  if (delivery !== undefined) return { purpose: 'DELIVERY', ...delivery };
  if (
    factOnlyEventTypes.has(eventType) ||
    OUTBOX_FACT_ONLY_PREFIXES.some((prefix) => eventType.startsWith(prefix))
  ) {
    return { purpose: 'FACT_ONLY' };
  }
  return null;
}
