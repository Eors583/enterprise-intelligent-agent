import type {
  AdminMember,
  KnowledgeBase,
  KnowledgeRetrievalTestResponse,
} from '@enterprise/contracts';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { getOrganization, testKnowledgeRetrieval } from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { EmptyState, FieldError, Notice, Spinner } from '@/components/ui';

import {
  hasStrongRelationshipRetrieval,
  knowledgeRetrievalDiagnosticStageLabel,
  knowledgeRetrievalDiagnosticStatusLabel,
  relationshipEvidencePath,
  relationshipPathEdgeLabel,
} from './knowledge-graph-view';
import {
  KnowledgeSourcePreviewModal,
  knowledgeSourceLocatorLabel,
} from './KnowledgeSourcePreviewModal';

function score(value: number): string {
  return value.toFixed(3);
}

export function KnowledgeRetrievalTestPanel({
  knowledgeBaseId,
  knowledgeBaseStatus,
  storageProvider,
  documents,
}: {
  knowledgeBaseId: string;
  knowledgeBaseStatus: KnowledgeBase['status'];
  storageProvider: KnowledgeBase['storageProvider'];
  documents: KnowledgeBase['documents'];
}): ReactNode {
  const managedByLexiang = storageProvider === 'LEXIANG';
  const [query, setQuery] = useState('');
  const [userId, setUserId] = useState('');
  const [members, setMembers] = useState<readonly AdminMember[]>([]);
  const [limit, setLimit] = useState(8);
  const [documentVersionId, setDocumentVersionId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<KnowledgeRetrievalTestResponse | null>(null);
  const [sourceItem, setSourceItem] = useState<
    KnowledgeRetrievalTestResponse['items'][number] | null
  >(null);
  const candidateVersions = documents.flatMap((document) =>
    document.versions
      .filter(
        (version) =>
          version.status === 'READY' && version.publishedAt === null && version.chunkCount > 0,
      )
      .map((version) => ({
        id: version.id,
        label: `${document.title} · 候选 v${version.versionNumber}`,
      })),
  );

  useEffect(() => {
    const controller = new AbortController();
    void getOrganization(controller.signal)
      .then((response) =>
        setMembers(response.members.filter((member) => member.status === 'ACTIVE')),
      )
      .catch(() => setMembers([]));
    return () => controller.abort();
  }, []);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setResult(null);
    const normalizedQuery = query.trim();
    const normalizedUserId = userId.trim();
    if (normalizedQuery.length < 2) {
      setError('请输入至少 2 个字符的问题。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      setResult(
        await testKnowledgeRetrieval(knowledgeBaseId, {
          query: normalizedQuery,
          limit,
          ...(normalizedUserId ? { userId: normalizedUserId } : {}),
          ...(documentVersionId ? { documentVersionId } : {}),
        }),
      );
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="card knowledge-retrieval-panel knowledge-tab-panel">
      <header className="card-header">
        <div>
          <h2>检索测试</h2>
          <p>
            {managedByLexiang
              ? '先按本系统权限校验访问范围，再调用腾讯乐享 AI 搜索检索当前知识库。'
              : '用真实权限验证已发布版本，或精确预览一个已审核候选版本。'}
          </p>
        </div>
      </header>
      {knowledgeBaseStatus === 'DRAFT' ? (
        <Notice tone="info">
          当前知识库仍是草稿。这里的结果仅供管理员预览，不会被员工智能体使用；验证完成并启用知识库后才会进入正式检索。
        </Notice>
      ) : null}
      {knowledgeBaseStatus === 'ARCHIVED' ? (
        <Notice tone="info">
          当前知识库已删除。这里保留历史检索诊断记录，但员工智能体不会使用该知识库。
        </Notice>
      ) : null}
      <form className="knowledge-retrieval-form" onSubmit={(event) => void submit(event)}>
        <label className="knowledge-retrieval-query">
          <span>测试问题</span>
          <textarea
            rows={3}
            value={query}
            maxLength={2000}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="例如：员工出差报销需要哪些材料？"
          />
        </label>
        <div className="form-grid two">
          <label>
            <span>以哪位成员的权限测试（可选）</span>
            <select value={userId} onChange={(event) => setUserId(event.target.value)}>
              <option value="">当前管理员</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.displayName} · {member.email}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>最多返回</span>
            <select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
              {[5, 8, 10, 15, 20].map((value) => (
                <option value={value} key={value}>
                  {value} 个切片
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>检索版本</span>
            <select
              value={documentVersionId}
              onChange={(event) => setDocumentVersionId(event.target.value)}
              disabled={managedByLexiang}
            >
              <option value="">
                {managedByLexiang ? '腾讯乐享当前内容（远程检索）' : '当前已发布版本（正式口径）'}
              </option>
              {!managedByLexiang &&
                candidateVersions.map((version) => (
                  <option value={version.id} key={version.id}>
                    {version.label}
                  </option>
                ))}
            </select>
          </label>
        </div>
        {documentVersionId ? (
          <Notice tone="info">
            当前为管理员候选预览：仅检索所选版本的词法/向量索引；候选图谱在发布前不会进入可信关系扩展。
          </Notice>
        ) : null}
        <FieldError message={error} />
        <div className="editor-footer align-end">
          <button className="button primary" type="submit" disabled={submitting}>
            {submitting ? <Spinner label="正在检索…" /> : '运行检索测试'}
          </button>
        </div>
      </form>

      {result ? (
        <div className="knowledge-retrieval-results" aria-live="polite">
          {managedByLexiang && lexiangSearchApplied(result) ? (
            <Notice tone="success">
              本次检索已通过本系统知识库权限校验，并由腾讯乐享 AI 搜索返回证据。
            </Notice>
          ) : managedByLexiang ? (
            <Notice tone="error">
              {lexiangSearchFailureMessage(result.degradedReason) ??
                '本次没有执行腾讯乐享 AI 搜索，请检查知识库绑定和知识来源连接状态。'}
            </Notice>
          ) : null}
          {result.noAnswer || result.items.length === 0 ? (
            <Notice tone="info">
              未找到达到阈值且当前用户有权访问的内容。智能体应返回“暂无可信答案”，不会拼接无依据回复。
            </Notice>
          ) : (
            <>
              <KnowledgeEvidenceSummary result={result} managedByLexiang={managedByLexiang} />
              <div className="knowledge-retrieval-result-list">
                {result.items.map((item, index) => (
                  <article key={item.chunkId}>
                    <header>
                      <span className="knowledge-result-rank">{index + 1}</span>
                      <div>
                        <strong>{item.title}</strong>
                        <small>
                          {item.knowledgeBaseName}
                          {managedByLexiang ? '' : ` · v${item.documentVersion}`}
                          {item.headingPath.length > 0 ? ` · ${item.headingPath.join(' / ')}` : ''}
                        </small>
                      </div>
                      <span className="knowledge-result-score">
                        相关度 {score(item.finalScore)}
                      </span>
                    </header>
                    <p>{knowledgeEvidenceExcerpt(item.excerpt)}</p>
                    <div className="knowledge-result-source-action">
                      <span>{knowledgeSourceLocatorLabel(item)}</span>
                      <button
                        className="button secondary"
                        type="button"
                        onClick={() => setSourceItem(item)}
                      >
                        查看原文位置
                      </button>
                    </div>
                    <details className="knowledge-result-technical">
                      <summary>查看匹配分数与内部定位</summary>
                      <footer>
                        <span>关键词 {score(item.keywordScore)}</span>
                        <span>模糊匹配 {score(item.fuzzyScore)}</span>
                        <span>
                          向量 {item.semanticScore === null ? '—' : score(item.semanticScore)}
                        </span>
                        <span>融合 {score(item.fusionScore)}</span>
                        <span>
                          Reranker {item.rerankerScore === null ? '—' : score(item.rerankerScore)}
                        </span>
                        <span>
                          关系{' '}
                          {item.relationshipScore === undefined
                            ? '—'
                            : score(item.relationshipScore)}
                        </span>
                        <code>{item.chunkId}</code>
                      </footer>
                    </details>
                    {item.relationshipEvidence && item.relationshipEvidence.length > 0 ? (
                      <details className="knowledge-result-relationship-evidence">
                        <summary>查看关系来源（{item.relationshipEvidence.length}）</summary>
                        <div>
                          {item.relationshipEvidence.map((evidence) => (
                            <article
                              key={`${evidence.relationId}-${evidence.sourceChunkId}-${evidence.direction}`}
                            >
                              <header>
                                <strong>{relationshipEvidencePath(evidence)}</strong>
                                <span>{evidence.hopDistance} 跳</span>
                              </header>
                              <ol
                                className="knowledge-relationship-path"
                                aria-label={`${evidence.hopDistance} 跳完整关系路径`}
                              >
                                {evidence.path.map((edge, edgeIndex) => (
                                  <li key={`${edge.relationId}-${edgeIndex}`}>
                                    <span>第 {edgeIndex + 1} 跳</span>
                                    <strong>{relationshipPathEdgeLabel(edge)}</strong>
                                    <code>{edge.relationId}</code>
                                  </li>
                                ))}
                              </ol>
                              <footer>
                                <span>置信度 {score(evidence.confidence)}</span>
                                <span>排序贡献 {score(evidence.contribution)}</span>
                                <code>source:{evidence.sourceChunkId}</code>
                              </footer>
                            </article>
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </article>
                ))}
              </div>
            </>
          )}
          <details className="knowledge-retrieval-technical">
            <summary>查看检索过程与技术指标</summary>
            <div>
              <div className="knowledge-retrieval-summary">
                {result.queryRoute ? (
                  <span>
                    问题路由 <strong>{knowledgeQueryRouteLabel(result.queryRoute.primary)}</strong>
                  </span>
                ) : null}
                <span>
                  检索模式{' '}
                  <strong>
                    {managedByLexiang
                      ? '腾讯乐享 AI 搜索'
                      : result.mode === 'HYBRID'
                        ? '语义混合检索'
                        : '仅词法检索'}
                  </strong>
                </span>
                <span>
                  重排{' '}
                  <strong>
                    {managedByLexiang
                      ? '乐享内置 Rerank'
                      : result.reranker === 'CROSS_ENCODER'
                        ? '模型 Reranker'
                        : result.reranker}
                  </strong>
                </span>
                <span>
                  命中 <strong>{result.items.length}</strong> 个切片
                </span>
                <span>
                  耗时 <strong>{Math.round(result.elapsedMs)} ms</strong>
                </span>
                <span>
                  权限内知识库 <strong>{result.accessibleKnowledgeBaseIds.length}</strong> 个
                </span>
                <span>
                  候选 <strong>{result.lexicalCandidateCount}</strong> 词法 /{' '}
                  <strong>{result.vectorCandidateCount}</strong> 向量
                </span>
                <span>
                  向量覆盖 <strong>{Math.round(result.semanticCoverage * 100)}%</strong>
                </span>
                <span>
                  关系候选 <strong>{result.relationshipCandidateCount ?? 0}</strong> / 扩展{' '}
                  <strong>{result.relationshipExpandedCount ?? 0}</strong>
                </span>
              </div>
              {result.structuredQuerySql ? (
                <details className="knowledge-structured-query-plan">
                  <summary>查看只读 SQL 计划</summary>
                  <code>{result.structuredQuerySql}</code>
                </details>
              ) : null}
              {result.diagnostics ? (
                <div className="knowledge-retrieval-diagnostics" aria-label="检索阶段诊断">
                  {result.diagnostics.map((diagnostic) => (
                    <article
                      key={diagnostic.stage}
                      className={`status-${diagnostic.status.toLowerCase()}`}
                    >
                      <header>
                        <strong>{knowledgeRetrievalDiagnosticStageLabel(diagnostic.stage)}</strong>
                        <span>{knowledgeRetrievalDiagnosticStatusLabel(diagnostic.status)}</span>
                      </header>
                      <p>{diagnostic.code}</p>
                      <small>{diagnostic.candidateCount.toLocaleString()} 个候选</small>
                    </article>
                  ))}
                </div>
              ) : null}
              {result.degradedReason === 'KNOWLEDGE_RERANK_NO_RESULT_FALLBACK' ? (
                <Notice tone="info">
                  模型重排未产生可靠分数，已保留混合召回排序；向量与关键词检索仍已执行。
                </Notice>
              ) : null}
              {result.degradedReason &&
              !managedByLexiang &&
              result.degradedReason !== 'KNOWLEDGE_RERANK_NO_RESULT_FALLBACK' &&
              !result.degradedReason.startsWith('LEXIANG_') ? (
                <Notice tone="info">
                  语义检索已安全降级（{result.degradedReason}）。当前结果不可标记为完整语义 RAG。
                </Notice>
              ) : null}
              {!managedByLexiang && !hasStrongRelationshipRetrieval(result) ? (
                <Notice tone="info">
                  本次查询没有完成可验证的关系扩展。结果可能仍来自关键词或向量匹配，不能作为“强关系检索”验收通过。
                </Notice>
              ) : !managedByLexiang ? (
                <Notice tone="success">
                  本次查询已执行关系扩展，命中结果包含可追溯到来源切片的一至两跳关系证据。
                </Notice>
              ) : null}
            </div>
          </details>
        </div>
      ) : (
        <EmptyState
          title="验证知识是否可检索"
          description="输入一个员工可能提出的问题，查看命中的文档版本、章节、分数与耗时。"
        />
      )}
      {sourceItem ? (
        <KnowledgeSourcePreviewModal item={sourceItem} onClose={() => setSourceItem(null)} />
      ) : null}
    </section>
  );
}

function KnowledgeEvidenceSummary({
  result,
  managedByLexiang,
}: {
  result: KnowledgeRetrievalTestResponse;
  managedByLexiang: boolean;
}): ReactNode {
  const first = result.items[0];
  if (!first) return null;
  const calculation = structuredCalculationResult(first.excerpt);
  return (
    <section className="knowledge-evidence-summary" aria-label="本次检索结论">
      <span>{calculation ? '精准计算结果' : '最相关证据'}</span>
      <h3>{calculation ?? knowledgeEvidenceExcerpt(first.excerpt)}</h3>
      <p>
        来源：{first.title}
        {managedByLexiang ? '' : ` · v${first.documentVersion}`}
        {first.headingPath.length > 0 ? ` · ${first.headingPath.join(' / ')}` : ''}
      </p>
      <small>
        共找到 {result.items.length} 条权限内证据，用时 {Math.round(result.elapsedMs)} ms。
      </small>
    </section>
  );
}

function lexiangSearchFailureMessage(reason: string | null): string | null {
  if (reason === 'LEXIANG_FORBIDDEN') {
    return '腾讯乐享拒绝了 AI 搜索。请确认当前 AppKey 已开通“AI 助手”权限，并检查可信 IP 和操作成员账号。';
  }
  if (reason === 'LEXIANG_SEARCH_INVALID_RESPONSE') {
    return '腾讯乐享返回了无法识别的搜索结果，请检查接口版本后重试。';
  }
  if (reason?.startsWith('LEXIANG_') === true) {
    return `腾讯乐享搜索暂不可用（${reason}），请检查知识来源连接后重试。`;
  }
  return null;
}

function lexiangSearchApplied(result: KnowledgeRetrievalTestResponse): boolean {
  return (
    result.diagnostics?.some(
      (diagnostic) =>
        diagnostic.stage === 'EXTERNAL' &&
        diagnostic.status === 'APPLIED' &&
        diagnostic.code === 'LEXIANG_AI_SEARCH_APPLIED',
    ) === true
  );
}

export function structuredCalculationResult(excerpt: string): string | null {
  if (!excerpt.startsWith('[结构化 SQL 查询结果]')) return null;
  return /结果：([\s\S]+?)(?:\s+SQL：|$)/u.exec(excerpt)?.[1]?.trim() ?? null;
}

export function knowledgeEvidenceExcerpt(excerpt: string): string {
  if (!excerpt.startsWith('[结构化 SQL 查询结果]')) return excerpt;
  return excerpt
    .replace(/^\[结构化 SQL 查询结果\]\s*/u, '')
    .replace(/\s+SQL：[\s\S]*$/u, '')
    .replace(/\s+(问题|工作表|指标|结果)：/gu, ' · $1：')
    .trim();
}

function knowledgeQueryRouteLabel(
  route: NonNullable<KnowledgeRetrievalTestResponse['queryRoute']>['primary'],
): string {
  return {
    DOCUMENT: '文档检索',
    SQL: '表格精确计算',
    RELATIONSHIP: '关系检索',
    BUSINESS_API: '实时业务数据',
  }[route];
}
