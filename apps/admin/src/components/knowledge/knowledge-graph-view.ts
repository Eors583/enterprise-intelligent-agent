import type {
  KnowledgeGraphOverview,
  KnowledgeGraphReadinessReason,
  KnowledgeGraphStatus,
  KnowledgeRelationshipEvidence,
  KnowledgeRelationshipPathEdge,
  KnowledgeRetrievalDiagnostic,
  KnowledgeRetrievalTestResponse,
} from '@enterprise/contracts';

export type KnowledgeGraphReadinessSummary = 'READY' | 'BUILDING' | 'DEGRADED' | 'FAILED' | 'EMPTY';

export function knowledgeGraphReadinessSummary(
  overview: KnowledgeGraphOverview,
): KnowledgeGraphReadinessSummary {
  if (overview.status === 'BUILDING') return 'BUILDING';
  if (overview.status === 'FAILED') return 'FAILED';
  if (overview.status === 'READY') return 'READY';
  if (overview.entityCount === 0 && overview.relationCount === 0) return 'EMPTY';
  return 'DEGRADED';
}

export function knowledgeGraphStatusLabel(status: KnowledgeGraphStatus): string {
  return {
    NOT_BUILT: '尚未构建',
    BUILDING: '正在构建',
    READY: '关系检索就绪',
    DEGRADED: '关系检索降级',
    FAILED: '构建失败',
  }[status];
}

export function knowledgeGraphReadinessReasonLabel(reason: KnowledgeGraphReadinessReason): string {
  return {
    NO_ENTITIES: '尚未从已发布文档提取实体',
    NO_RELATIONS: '尚未建立可检索的实体关系',
    NO_PUBLISHED_ONTOLOGY: '尚未发布用于约束关系检索的本体版本',
    UNGOVERNED_RELATIONS: '存在尚未绑定已发布本体谓词的活动关系',
    OPEN_GRAPH_CONFLICTS: '存在尚未解决的实体或关系冲突',
    MENTION_COVERAGE_INCOMPLETE: '仍有已发布切片未建立实体提及',
    RELATIONS_WITHOUT_EVIDENCE: '存在没有来源证据的关系',
    GRAPH_EXTRACTION_PROCESSING: '关系抽取任务仍在运行',
    GRAPH_EXTRACTION_FAILED: '存在关系抽取失败的文档或切片',
  }[reason];
}

export function knowledgeRetrievalDiagnosticStageLabel(
  stage: KnowledgeRetrievalDiagnostic['stage'],
): string {
  return {
    ROUTER: '问题路由',
    LEXICAL: '关键词召回',
    VECTOR: '向量召回',
    SQL: '表格 SQL',
    RELATIONSHIP: '关系扩展',
    BUSINESS_API: '业务 API',
    EXTERNAL: '外部知识检索',
    RERANK: '模型重排',
  }[stage];
}

export function knowledgeRetrievalDiagnosticStatusLabel(
  status: KnowledgeRetrievalDiagnostic['status'],
): string {
  return {
    APPLIED: '已执行',
    SKIPPED: '未执行',
    DEGRADED: '已降级',
  }[status];
}

export function relationshipEvidencePath(evidence: KnowledgeRelationshipEvidence): string {
  const [firstEdge] = evidence.path;
  if (firstEdge === undefined) {
    return evidence.direction === 'OUTBOUND'
      ? `${evidence.sourceEntityName} → ${evidence.relationType} → ${evidence.targetEntityName}`
      : `${evidence.sourceEntityName} ← ${evidence.relationType} ← ${evidence.targetEntityName}`;
  }

  return evidence.path.reduce(
    (path, edge) =>
      `${path} ${edge.direction === 'OUTBOUND' ? '→' : '←'} ${edge.predicate} ${
        edge.direction === 'OUTBOUND' ? '→' : '←'
      } ${edge.targetEntityName}`,
    firstEdge.sourceEntityName,
  );
}

export function relationshipPathEdgeLabel(edge: KnowledgeRelationshipPathEdge): string {
  const arrow = edge.direction === 'OUTBOUND' ? '→' : '←';
  return `${edge.sourceEntityName} ${arrow} ${edge.predicate} ${arrow} ${edge.targetEntityName}`;
}

export function hasStrongRelationshipRetrieval(response: KnowledgeRetrievalTestResponse): boolean {
  const relationshipDiagnostic = response.diagnostics?.find(
    (diagnostic) => diagnostic.stage === 'RELATIONSHIP',
  );
  return (
    relationshipDiagnostic?.status === 'APPLIED' &&
    (response.relationshipExpandedCount ?? 0) > 0 &&
    response.items.some((item) => (item.relationshipEvidence?.length ?? 0) > 0)
  );
}
