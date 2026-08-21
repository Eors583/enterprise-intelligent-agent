import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  OUTBOX_CONSUMER,
  OUTBOX_DELIVERY_ROUTES,
  OUTBOX_FACT_ONLY_EVENT_TYPES,
  OUTBOX_FACT_ONLY_PREFIXES,
  OUTBOX_LANE,
  outboxCatalogRoute,
} from './outbox-routing.js';

const apiRoot = resolve(process.cwd());
const migration = readFileSync(
  resolve(apiRoot, 'prisma/migrations/20260729001700_outbox_delivery_routing/migration.sql'),
  'utf8',
);
const knowledgeGraphFactsMigration = readFileSync(
  resolve(
    apiRoot,
    'prisma/migrations/20260729002700_outbox_delivery_knowledge_graph_facts/migration.sql',
  ),
  'utf8',
);
const catalogPrefixesMigration = readFileSync(
  resolve(apiRoot, 'prisma/migrations/20260729002900_outbox_event_catalog_prefixes/migration.sql'),
  'utf8',
);
const unknownEvidenceGuardMigration = readFileSync(
  resolve(
    apiRoot,
    'prisma/migrations/20260729001900_delivery_unknown_evidence_guard/migration.sql',
  ),
  'utf8',
);
const workerRepositories = [
  'src/modules/im-outbox/infrastructure/prisma/prisma-outbox-delivery.repository.ts',
  'src/modules/agent-run/infrastructure/prisma/prisma-agent-run-queue.repository.ts',
  'src/modules/tool-gateway/infrastructure/prisma/prisma-tool-execution-queue.repository.ts',
  'src/modules/tool-gateway/infrastructure/prisma/prisma-tool-reconciliation-queue.repository.ts',
].map((path) => readFileSync(resolve(apiRoot, path), 'utf8'));

function extractExactRouteTypes(sql: string, purpose: 'DELIVERY' | 'FACT_ONLY'): string[] {
  return [...sql.matchAll(/\(\s*'([^']+)',\s*'(DELIVERY|FACT_ONLY)'/g)]
    .filter((match) => match[1] !== 'FACT_ONLY' && match[2] === purpose)
    .map((match) => match[1] as string);
}

function extractFactOnlyPrefixes(sql: string): string[] {
  const valuesBlock = sql.match(
    /INSERT INTO public\."outbox_event_route_prefixes"[\s\S]+?\bVALUES\b([\s\S]+?);/,
  )?.[1];
  if (valuesBlock === undefined) return [];
  return [...valuesBlock.matchAll(/\(\s*'([^']+)',\s*'FACT_ONLY'/g)].map(
    (match) => match[1] as string,
  );
}

describe('Outbox event and consumer delivery separation', () => {
  it('routes every active worker event to one explicit consumer and lane', () => {
    const expectedRoutes = [
      ['message.created.v1', OUTBOX_CONSUMER.imDelivery, OUTBOX_LANE.imMessage],
      ['agent.run_requested.v1', OUTBOX_CONSUMER.agentRun, OUTBOX_LANE.agentRunExecution],
      ['agent.run_cancel_requested.v1', OUTBOX_CONSUMER.agentRun, OUTBOX_LANE.agentRunCancellation],
      ['ToolInvocationCommandRecorded', OUTBOX_CONSUMER.toolExecution, OUTBOX_LANE.toolExecution],
      [
        'ToolInvocation.ReconciliationRequested',
        OUTBOX_CONSUMER.toolReconciliation,
        OUTBOX_LANE.toolReconciliation,
      ],
      [
        'admin.directory.feishu.sync.requested.v1',
        OUTBOX_CONSUMER.feishuDirectory,
        OUTBOX_LANE.feishuDirectorySync,
      ],
    ] as const;

    for (const [eventType, consumerKey, lane] of expectedRoutes) {
      expect(migration).toContain(`'${eventType}', 'DELIVERY'`);
      expect(migration).toContain(`'${consumerKey}'`);
      expect(migration).toContain(`'${lane}'`);
    }
  });

  it('keeps delivery attempts unique per event and consumer', () => {
    expect(migration).toContain('CREATE TABLE public."outbox_event_deliveries"');
    expect(migration).toContain('UNIQUE ("tenant_id", "event_id", "consumer_key")');
    expect(migration).toContain('CREATE INDEX "outbox_event_deliveries_claim_idx"');
    expect(unknownEvidenceGuardMigration).toContain(
      'ON public."outbox_event_deliveries" ("event_id", "consumer_key")',
    );
  });

  it('requires provider attempt, receipt, and diagnostic evidence for UNKNOWN', () => {
    expect(unknownEvidenceGuardMigration).toContain(
      'outbox_event_deliveries_unknown_evidence_check',
    );
    expect(unknownEvidenceGuardMigration).toContain('"attempts" > 0');
    expect(unknownEvidenceGuardMigration).toContain('"first_attempted_at" IS NOT NULL');
    expect(unknownEvidenceGuardMigration).toContain('"provider_receipt" IS NOT NULL');
    expect(unknownEvidenceGuardMigration).toContain(
      'jsonb_typeof("provider_receipt") = \'object\'',
    );
    expect(unknownEvidenceGuardMigration).toContain('"last_error" IS NOT NULL');
  });

  it('makes workers lease and transition delivery rows rather than source events', () => {
    for (const repository of workerRepositories) {
      expect(repository).toContain('public."outbox_event_deliveries"');
      expect(repository).toContain('FOR UPDATE OF delivery SKIP LOCKED');
      expect(repository).not.toContain('UPDATE public."outbox_events"');
    }
  });

  it('classifies facts without delivery and quarantines unregistered types', () => {
    const registeredFacts = [
      'conversation.created.v1',
      'knowledge.document-version.published.v1',
      'AiEvaluationDatasetChanged',
      'AiEvaluationDatasetVersionChanged',
      'AiEvaluationCaseChanged',
      'AiEvaluationAnnotationChanged',
      'AiEvaluationRunChanged',
      'AiEvaluationBadCaseChanged',
      'AiEvaluationReleaseReadinessChecked',
      'AiEvaluationRunnerAttestationVerified',
      'AiModelCatalogVersionChanged',
      'AiModelRoutePolicyVersionChanged',
      'AiModelCircuitStateChanged',
      'AiModelAttemptReceiptRecorded',
      'AiSafetyDecisionRecorded',
      'IdentityGovernanceCommandApplied.v1',
      'IdentityGovernanceCommandRejected.v1',
      'IdentityBreakGlassRequest.v1',
      'IdentityBreakGlassApprove.v1',
      'IdentityBreakGlassReject.v1',
      'IdentityBreakGlassActivate.v1',
      'IdentityBreakGlassRevoke.v1',
      'IdentityBreakGlassExpire.v1',
      'IdentityBreakGlassReview_close.v1',
      'IdentityPrincipalDeprovisioned.v1',
      'knowledge.graph.conflict.created',
      'knowledge.graph.ontology.created',
      'knowledge.graph.ontology_version.created',
      'knowledge.graph.ontology_version.submit',
      'knowledge.graph.ontology_version.request_changes',
      'knowledge.graph.ontology_version.publish',
      'knowledge.graph.ontology_version.retire',
      'knowledge.graph.correction.created',
      'knowledge.graph.correction.submit',
      'knowledge.graph.correction.approve',
      'knowledge.graph.correction.reject',
      'knowledge.graph.correction.apply',
    ] as const;
    for (const eventType of registeredFacts) {
      const allRoutesSql = migration + knowledgeGraphFactsMigration;
      expect(allRoutesSql).toContain(`'${eventType}', 'FACT_ONLY'`);
    }
    expect(migration).toContain(`"routing_error" = 'UNREGISTERED_EVENT_TYPE'`);
    expect(migration).toContain(`"routing_purpose" = 'QUARANTINED'`);
  });

  it('keeps the code catalog and exact migration routes bidirectionally synchronized', () => {
    const exactRoutesSql = migration + knowledgeGraphFactsMigration;

    expect(extractExactRouteTypes(exactRoutesSql, 'DELIVERY').sort()).toEqual(
      Object.keys(OUTBOX_DELIVERY_ROUTES).sort(),
    );
    expect(extractExactRouteTypes(exactRoutesSql, 'FACT_ONLY').sort()).toEqual(
      [...OUTBOX_FACT_ONLY_EVENT_TYPES].sort(),
    );

    for (const [eventType, expected] of Object.entries(OUTBOX_DELIVERY_ROUTES)) {
      expect(outboxCatalogRoute(eventType)).toEqual({
        purpose: 'DELIVERY',
        ...expected,
      });
    }
    for (const eventType of OUTBOX_FACT_ONLY_EVENT_TYPES) {
      expect(outboxCatalogRoute(eventType)).toEqual({ purpose: 'FACT_ONLY' });
    }
  });

  it('keeps reviewed FACT_ONLY prefixes synchronized with the forward migration', () => {
    expect(extractFactOnlyPrefixes(catalogPrefixesMigration).sort()).toEqual(
      [...OUTBOX_FACT_ONLY_PREFIXES].sort(),
    );
    for (const prefix of OUTBOX_FACT_ONLY_PREFIXES) {
      expect(outboxCatalogRoute(`${prefix}static-coverage-probe`)).toEqual({
        purpose: 'FACT_ONLY',
      });
    }
    expect(catalogPrefixesMigration).toContain(
      `CHECK ("purpose" = 'FACT_ONLY'::public."OutboxEventRoutingPurpose")`,
    );
    expect(catalogPrefixesMigration).toContain('-- Exact routes always win.');
  });

  it('keeps unknown event types quarantined instead of granting implicit delivery', () => {
    expect(outboxCatalogRoute('Unregistered.CommandRequested.v1')).toBeNull();
    expect(outboxCatalogRoute('agent.run_requested.v2')).toBeNull();
    expect(catalogPrefixesMigration).toContain(`"routing_error" = 'UNREGISTERED_EVENT_TYPE'`);
    expect(catalogPrefixesMigration).toContain(`"routing_purpose" = 'QUARANTINED'`);
  });

  it('reclassifies only previously quarantined prefix facts without replaying them', () => {
    expect(catalogPrefixesMigration).toContain(
      `event."routing_purpose" = 'QUARANTINED'::public."OutboxEventRoutingPurpose"`,
    );
    expect(catalogPrefixesMigration).toContain(`event."routing_error" = 'UNREGISTERED_EVENT_TYPE'`);
    expect(catalogPrefixesMigration).toContain(
      `SET "routing_purpose" = 'FACT_ONLY'::public."OutboxEventRoutingPurpose"`,
    );
    expect(catalogPrefixesMigration).toContain(
      'left(event."event_type", length(prefix."event_type_prefix"))',
    );
    expect(catalogPrefixesMigration).not.toMatch(
      /UPDATE public\."outbox_events"[\s\S]+?SET[\s\S]+?"status"\s*=/,
    );
    expect(catalogPrefixesMigration).not.toContain(
      'INSERT INTO public."outbox_event_deliveries"\nSELECT',
    );
  });

  it('gives the worker role delivery state while tenant roles remain RLS-bound', () => {
    expect(migration).toContain(
      'ALTER TABLE public."outbox_event_deliveries" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain('CREATE POLICY "enterprise_agent_outbox_access"');
    expect(migration).toContain('TO enterprise_agent_outbox');
  });
});
