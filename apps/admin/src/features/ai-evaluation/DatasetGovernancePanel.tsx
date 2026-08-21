import type {
  AdminAgent,
  AiEvaluationBadCase,
  AiEvaluationCase,
  AiEvaluationCategory,
  AiEvaluationDataset,
  AiEvaluationDatasetVersion,
  AiEvaluationJudgeType,
  AiEvaluationMetric,
  Evidence,
  KnowledgeRetrievalBenchmarkRunSummary,
  KnowledgeBase,
  ProcessDefinition,
  RoleAssignment,
  ToolDefinition,
} from '@enterprise/contracts';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import {
  listAgents,
  listKnowledgeBases,
  listRoleAssignments,
  listToolDefinitions,
} from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { Spinner, StatusPill } from '@/components/ui';
import { listEvidence, listProcessDefinitions } from '@/features/business-semantics/api';

import {
  annotateEvaluationCase,
  createEvaluationCase,
  createEvaluationDataset,
  createEvaluationDatasetVersion,
  listEvaluationCases,
  listEvaluationBadCases,
  listEvaluationDatasetVersions,
  transitionEvaluationDatasetVersion,
} from './api';
import {
  selectedFormValues,
  stableEvaluationCaseKey,
  stableEvaluationDatasetCode,
} from './governance-form';
import {
  datasetStatusLabel,
  EVALUATION_CATEGORIES,
  EVALUATION_METRICS,
  evaluationCategoryLabel,
  parseTextList,
  parseUuidList,
} from './view';
import { KnowledgeRetrievalEvaluationPanel } from './KnowledgeRetrievalEvaluationPanel';

export function DatasetGovernancePanel({
  datasets,
  refreshToken,
  reloadDatasets,
  onLatestRetrievalRunChange,
  onNotice,
  onError,
}: {
  datasets: readonly AiEvaluationDataset[];
  refreshToken: number;
  reloadDatasets: () => void;
  onLatestRetrievalRunChange: (run: KnowledgeRetrievalBenchmarkRunSummary | null) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}): ReactNode {
  const [selectedDatasetId, setSelectedDatasetId] = useState('');
  const [preferredDatasetId, setPreferredDatasetId] = useState('');
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [versions, setVersions] = useState<readonly AiEvaluationDatasetVersion[]>([]);
  const [cases, setCases] = useState<readonly AiEvaluationCase[]>([]);
  const [agents, setAgents] = useState<readonly AdminAgent[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<readonly KnowledgeBase[]>([]);
  const [toolDefinitions, setToolDefinitions] = useState<readonly ToolDefinition[]>([]);
  const [roleAssignments, setRoleAssignments] = useState<readonly RoleAssignment[]>([]);
  const [processDefinitions, setProcessDefinitions] = useState<readonly ProcessDefinition[]>([]);
  const [evidence, setEvidence] = useState<readonly Evidence[]>([]);
  const [badCases, setBadCases] = useState<readonly AiEvaluationBadCase[]>([]);
  const [referencesReady, setReferencesReady] = useState(false);
  const [caseCategory, setCaseCategory] = useState<AiEvaluationCategory>('FACTUALITY');
  const [versionProfile, setVersionProfile] = useState<
    'ENTERPRISE_RELEASE' | 'KNOWLEDGE_RETRIEVAL'
  >('KNOWLEDGE_RETRIEVAL');
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);

  const selectedDataset = datasets.find(({ id }) => id === selectedDatasetId) ?? null;
  const selectedVersion = versions.find(({ id }) => id === selectedVersionId) ?? null;
  const verifiedEvidence = evidence.filter(
    (item) => item.status === 'ACTIVE' && item.trustLevel === 'VERIFIED',
  );
  const publishedAgents = agents.filter(({ versionStatus }) => versionStatus === 'PUBLISHED');
  const publishedTools = toolDefinitions.filter(
    (definition) => definition.status === 'PUBLISHED' && definition.currentVersionId !== null,
  );
  const activeAssignments = roleAssignments.filter(
    (assignment) => assignment.status === 'ACTIVE' && assignment.roleVersionId !== undefined,
  );
  const publishedProcesses = processDefinitions.filter(
    (process) => process.status === 'ACTIVE' && process.currentVersionId !== null,
  );
  const mappedBadCases = badCases.filter(
    (badCase) =>
      badCase.status === 'TRIAGED' && badCase.mappedDatasetVersionId === selectedVersionId,
  );
  const knowledgeVersions = knowledgeBases.flatMap((knowledgeBase) =>
    knowledgeBase.documents.flatMap((document) => {
      if (document.currentVersionId === null) return [];
      const version = document.versions.find(
        (candidate) => candidate.id === document.currentVersionId && candidate.status === 'READY',
      );
      return version
        ? [
            {
              id: version.id,
              label: `${knowledgeBase.name} / ${document.title} · v${version.versionNumber}`,
            },
          ]
        : [];
    }),
  );
  const reload = (): void => setReloadKey((value) => value + 1);

  useEffect(() => {
    const controller = new AbortController();
    setReferencesReady(false);
    void Promise.all([
      listAgents(controller.signal),
      listKnowledgeBases(controller.signal),
      listToolDefinitions(controller.signal),
      listRoleAssignments(controller.signal),
      listProcessDefinitions(controller.signal),
      listEvidence(controller.signal),
      listEvaluationBadCases({ limit: 200 }, controller.signal),
    ])
      .then(
        ([
          agentResponse,
          knowledgeResponse,
          toolResponse,
          assignmentResponse,
          processResponse,
          evidenceResponse,
          badCaseResponse,
        ]) => {
          setAgents(agentResponse.items);
          setKnowledgeBases(knowledgeResponse.items);
          setToolDefinitions(toolResponse.items);
          setRoleAssignments(assignmentResponse.items);
          setProcessDefinitions(processResponse);
          setEvidence(evidenceResponse);
          setBadCases(badCaseResponse.items);
          setReferencesReady(true);
        },
      )
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          onError(`评测引用目录加载失败：${messageFromError(caught)}`);
        }
      });
    return () => controller.abort();
  }, [onError, refreshToken, reloadKey]);

  useEffect(() => {
    if (preferredDatasetId && datasets.some(({ id }) => id === preferredDatasetId)) {
      setSelectedDatasetId(preferredDatasetId);
      setPreferredDatasetId('');
      return;
    }
    if (selectedDatasetId === '' && datasets[0]) setSelectedDatasetId(datasets[0].id);
    if (
      selectedDatasetId !== '' &&
      selectedDatasetId !== preferredDatasetId &&
      !datasets.some(({ id }) => id === selectedDatasetId)
    ) {
      setSelectedDatasetId(datasets[0]?.id ?? '');
    }
  }, [datasets, preferredDatasetId, selectedDatasetId]);

  useEffect(() => {
    if (selectedDatasetId === '') {
      setVersions([]);
      setSelectedVersionId('');
      return;
    }
    const controller = new AbortController();
    void listEvaluationDatasetVersions(selectedDatasetId, { limit: 100 }, controller.signal)
      .then((response) => {
        setVersions(response.items);
        setSelectedVersionId((current) =>
          response.items.some(({ id }) => id === current) ? current : (response.items[0]?.id ?? ''),
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) onError(messageFromError(caught));
      });
    return () => controller.abort();
  }, [onError, refreshToken, reloadKey, selectedDatasetId]);

  useEffect(() => {
    if (selectedVersionId === '') {
      setCases([]);
      return;
    }
    const controller = new AbortController();
    void listEvaluationCases(selectedVersionId, { limit: 200 }, controller.signal)
      .then((response) => setCases(response.items))
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) onError(messageFromError(caught));
      });
    return () => controller.abort();
  }, [onError, refreshToken, reloadKey, selectedVersionId]);

  const createDataset = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      const name = text(data, 'name');
      const created = await createEvaluationDataset({
        code: stableEvaluationDatasetCode(name),
        name,
        description: text(data, 'description'),
        idempotencyKey: crypto.randomUUID(),
      });
      form.reset();
      setPreferredDatasetId(created.id);
      reloadDatasets();
      onNotice(`评测数据集“${created.name}”已创建。`);
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };

  const createVersion = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selectedDataset) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      const metric = text(data, 'metric') as AiEvaluationMetric;
      const agentVersionIds = mergeUnique(
        selectedFormValues(data, 'agentVersionIds'),
        parseUuidList(text(data, 'agentVersionIdsOverride'), '兼容智能体版本'),
      );
      const knowledgeVersionIds = mergeUnique(
        selectedFormValues(data, 'knowledgeVersionIds'),
        parseUuidList(text(data, 'knowledgeVersionIdsOverride'), '兼容知识版本'),
      );
      const toolVersionIds = mergeUnique(
        selectedFormValues(data, 'toolVersionIds'),
        parseUuidList(text(data, 'toolVersionIdsOverride'), '兼容工具版本'),
      );
      const modelRoutes = parseTextList(text(data, 'modelRoutes'));
      const promptHashes = parseTextList(text(data, 'promptHashes'));
      if (
        agentVersionIds.length === 0 &&
        knowledgeVersionIds.length === 0 &&
        toolVersionIds.length === 0 &&
        modelRoutes.length === 0 &&
        promptHashes.length === 0
      ) {
        throw new Error('请选择至少一个真实发布版本；目录缺失时只能使用高级兼容导入。');
      }
      const created = await createEvaluationDatasetVersion(selectedDataset.id, {
        description: text(data, 'description'),
        targets: {
          agentVersionIds,
          knowledgeVersionIds,
          toolVersionIds,
          modelRoutes,
          promptHashes,
        },
        thresholds:
          versionProfile === 'KNOWLEDGE_RETRIEVAL'
            ? knowledgeRetrievalThresholds()
            : [
                {
                  metric,
                  direction: text(data, 'direction') as 'AT_LEAST' | 'AT_MOST' | 'ZERO',
                  threshold: Number(text(data, 'threshold')),
                  minimumSampleCount: Number(text(data, 'minimumSampleCount')),
                  required: true,
                },
              ],
        requiredCategories:
          versionProfile === 'KNOWLEDGE_RETRIEVAL'
            ? ['CITATION']
            : (data.getAll('requiredCategories') as AiEvaluationCategory[]),
        idempotencyKey: crypto.randomUUID(),
      });
      setSelectedVersionId(created.id);
      reload();
      reloadDatasets();
      onNotice(`数据集版本 v${created.version} 已创建；请新增并标注用例。`);
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };

  const createCase = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selectedVersion) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      const input = text(data, 'input');
      const expectedBehavior = text(data, 'expectedBehavior');
      const category = text(data, 'category') as AiEvaluationCategory;
      const selectedAssignment = activeAssignments.find(
        ({ id }) => id === text(data, 'roleAssignmentSelection'),
      );
      const selectedProcessVersionId = text(data, 'processVersionSelection');
      const sourceBadCaseId =
        text(data, 'sourceBadCaseSelection') || text(data, 'sourceBadCaseIdOverride');
      const requiredEvidenceIds = mergeUnique(
        selectedFormValues(data, 'requiredEvidenceIds'),
        parseUuidList(text(data, 'requiredEvidenceIdsOverride'), '兼容可信证据'),
      );
      await createEvaluationCase(selectedVersion.id, {
        caseKey:
          text(data, 'caseKeyOverride').toUpperCase() ||
          stableEvaluationCaseKey(category, input, expectedBehavior),
        category,
        input,
        context: {
          roleAssignmentId:
            selectedAssignment?.id ?? nullableUuid(data, 'roleAssignmentIdOverride'),
          roleVersionId:
            selectedAssignment?.roleVersionId ?? nullableUuid(data, 'roleVersionIdOverride'),
          objectiveId: null,
          objectiveVersion: null,
          processVersionId:
            selectedProcessVersionId || nullableUuid(data, 'processVersionIdOverride'),
          permissionLabels: parseTextList(text(data, 'permissionLabels')),
          knowledgeVersionIds: mergeUnique(
            selectedFormValues(data, 'contextKnowledgeVersionIds'),
            parseUuidList(text(data, 'contextKnowledgeVersionIdsOverride'), '兼容上下文知识版本'),
          ),
          toolVersionIds: mergeUnique(
            selectedFormValues(data, 'contextToolVersionIds'),
            parseUuidList(text(data, 'contextToolVersionIdsOverride'), '兼容上下文工具版本'),
          ),
          structuredContext: {},
        },
        expectedBehavior,
        requiredEvidenceIds,
        forbiddenBehaviors: parseTextList(text(data, 'forbiddenBehaviors')),
        scoring: {
          judgeTypes: [text(data, 'judgeType') as AiEvaluationJudgeType],
          rubric: text(data, 'rubric'),
          metricWeights: [
            {
              metric: text(data, 'metric') as AiEvaluationMetric,
              weight: 1,
            },
          ],
        },
        ...(sourceBadCaseId ? { sourceBadCaseId } : {}),
        idempotencyKey: crypto.randomUUID(),
      });
      form.reset();
      reload();
      reloadDatasets();
      onNotice('评测用例已写入草稿版本；事实、引用和目标用例不会接受空证据。');
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };

  const annotate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      const label = text(data, 'label') as 'PASS' | 'FAIL' | 'ABSTAIN';
      await annotateEvaluationCase(text(data, 'caseId'), {
        label,
        expectedScore: label === 'ABSTAIN' ? null : Number(text(data, 'expectedScore')),
        rationale: text(data, 'rationale'),
        evidenceIds: mergeUnique(
          selectedFormValues(data, 'evidenceIds'),
          parseUuidList(text(data, 'evidenceIdsOverride'), '兼容标注证据'),
        ),
        expectedRevision: 0,
        idempotencyKey: crypto.randomUUID(),
      });
      reload();
      onNotice('标注已保存。提交数据集后标注不可变更。');
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };

  const transition = async (
    action: 'SUBMIT' | 'APPROVE' | 'REJECT' | 'PUBLISH' | 'RETIRE',
    data?: FormData,
  ): Promise<void> => {
    if (!selectedVersion) return;
    setBusy(true);
    try {
      const expectedRevision = selectedVersion.revision;
      const idempotencyKey = crypto.randomUUID();
      if (action === 'APPROVE' || action === 'REJECT') {
        const form = requiredData(data);
        await transitionEvaluationDatasetVersion(selectedVersion.id, {
          action,
          expectedRevision,
          idempotencyKey,
          reason: text(form, 'reason'),
          evidenceIds: mergeUnique(
            selectedFormValues(form, 'evidenceIds'),
            parseUuidList(text(form, 'evidenceIdsOverride'), '兼容审核证据'),
          ),
        });
      } else if (action === 'RETIRE') {
        await transitionEvaluationDatasetVersion(selectedVersion.id, {
          action,
          expectedRevision,
          idempotencyKey,
          reason: text(requiredData(data), 'reason'),
        });
      } else {
        await transitionEvaluationDatasetVersion(selectedVersion.id, {
          action,
          expectedRevision,
          idempotencyKey,
        });
      }
      reload();
      reloadDatasets();
      onNotice(`数据集版本已执行“${action}”，状态由服务端状态机确认。`);
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="evaluation-grid-section" aria-labelledby="evaluation-dataset-heading">
      <header>
        <div>
          <span className="eyebrow">DATASET GOVERNANCE</span>
          <h2 id="evaluation-dataset-heading">数据集、版本与受控用例</h2>
        </div>
        <span>{datasets.length} 个数据集</span>
      </header>

      <div className="evaluation-two-column">
        <form className="card evaluation-form" onSubmit={(event) => void createDataset(event)}>
          <h3>创建数据集</h3>
          <label>
            名称
            <input name="name" required />
            <small>数据集代码会按名称稳定生成。</small>
          </label>
          <label>
            说明
            <textarea name="description" required rows={3} />
          </label>
          <button className="button primary" type="submit" disabled={busy}>
            创建数据集
          </button>
        </form>

        <article className="card evaluation-form">
          <h3>版本上下文</h3>
          <label>
            数据集
            <select
              value={selectedDatasetId}
              onChange={(event) => setSelectedDatasetId(event.target.value)}
            >
              <option value="">请选择数据集</option>
              {datasets.map((dataset) => (
                <option key={dataset.id} value={dataset.id}>
                  {dataset.code} · {dataset.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            版本
            <select
              value={selectedVersionId}
              onChange={(event) => setSelectedVersionId(event.target.value)}
              disabled={versions.length === 0}
            >
              <option value="">请选择版本</option>
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  v{version.version} · {datasetStatusLabel(version.status)} · r{version.revision}
                </option>
              ))}
            </select>
          </label>
          {selectedVersion ? (
            <dl className="evaluation-definition">
              <div>
                <dt>状态</dt>
                <dd>
                  <StatusPill
                    value={selectedVersion.status}
                    label={datasetStatusLabel(selectedVersion.status)}
                  />
                </dd>
              </div>
              <div>
                <dt>用例 / 标注覆盖率</dt>
                <dd>
                  {selectedVersion.caseCount} /{' '}
                  {Math.round(selectedVersion.annotationCoverage * 100)}%
                </dd>
              </div>
              <div>
                <dt>内容哈希</dt>
                <dd>
                  <code>{selectedVersion.contentHash}</code>
                </dd>
              </div>
            </dl>
          ) : (
            <p>先创建数据集版本，再新增受控用例。</p>
          )}
        </article>
      </div>

      {selectedDataset ? (
        <details className="card evaluation-disclosure" open={versions.length === 0}>
          <summary>创建不可变评测版本</summary>
          <form className="evaluation-form" onSubmit={(event) => void createVersion(event)}>
            <label>
              版本说明
              <textarea name="description" required rows={2} />
            </label>
            <label>
              评测用途
              <select
                name="versionProfile"
                value={versionProfile}
                onChange={(event) =>
                  setVersionProfile(
                    event.target.value as 'ENTERPRISE_RELEASE' | 'KNOWLEDGE_RETRIEVAL',
                  )
                }
              >
                <option value="KNOWLEDGE_RETRIEVAL">知识库检索效果（推荐）</option>
                <option value="ENTERPRISE_RELEASE">完整智能体发布评测</option>
              </select>
              <small>
                “知识库检索效果”会自动配置 Recall@5、MRR、nDCG@10、来源支撑率和
                P95，无需理解内部指标字段。
              </small>
            </label>
            <div className="evaluation-three-column">
              {versionProfile === 'ENTERPRISE_RELEASE' ? (
                <label>
                  已发布智能体版本
                  <select
                    name="agentVersionIds"
                    multiple
                    size={Math.min(5, publishedAgents.length + 1)}
                  >
                    {publishedAgents.map((agent) => (
                      <option key={agent.versionId} value={agent.versionId}>
                        {agent.name} · v{agent.version}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                当前 READY 知识版本
                <select
                  name="knowledgeVersionIds"
                  multiple
                  size={Math.min(5, knowledgeVersions.length + 1)}
                >
                  {knowledgeVersions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.label}
                    </option>
                  ))}
                </select>
              </label>
              {versionProfile === 'ENTERPRISE_RELEASE' ? (
                <label>
                  当前已发布工具版本
                  <select
                    name="toolVersionIds"
                    multiple
                    size={Math.min(5, publishedTools.length + 1)}
                  >
                    {publishedTools.map((tool) => (
                      <option key={tool.currentVersionId!} value={tool.currentVersionId!}>
                        {tool.name} · v{tool.currentVersion}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            {!referencesReady ? (
              <p>真实发布目录尚未加载完成；创建操作将被阻断。</p>
            ) : publishedAgents.length + knowledgeVersions.length + publishedTools.length === 0 ? (
              <p>当前没有可选的已发布版本。请先发布业务对象，或使用高级兼容导入。</p>
            ) : (
              <small>按住 Ctrl/Cmd 可多选；这里只列出当前真实发布或 READY 版本。</small>
            )}
            <small>
              模型、智能体、知识和工具版本只从当前已发布目录选择，旧对象兼容请通过迁移任务处理。
            </small>
            <div
              className="evaluation-three-column"
              hidden={versionProfile === 'KNOWLEDGE_RETRIEVAL'}
            >
              <label>
                必需指标
                <select name="metric" defaultValue="FACTUAL_ACCURACY">
                  {EVALUATION_METRICS.map((metric) => (
                    <option key={metric.value} value={metric.value}>
                      {metric.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                阈值方向
                <select name="direction" defaultValue="AT_LEAST">
                  <option value="AT_LEAST">至少</option>
                  <option value="AT_MOST">至多</option>
                  <option value="ZERO">必须为零</option>
                </select>
              </label>
              <label>
                阈值
                <input name="threshold" type="number" step="0.01" min="0" defaultValue="0.8" />
              </label>
              <label>
                最小样本数
                <input name="minimumSampleCount" type="number" min="1" defaultValue="1" />
              </label>
            </div>
            <fieldset hidden={versionProfile === 'KNOWLEDGE_RETRIEVAL'}>
              <legend>必需类别</legend>
              <div className="evaluation-check-grid">
                {EVALUATION_CATEGORIES.map((category) => (
                  <label key={category.value}>
                    <input
                      type="checkbox"
                      name="requiredCategories"
                      value={category.value}
                      defaultChecked={category.value === 'FACTUALITY'}
                    />
                    {category.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <button className="button primary" type="submit" disabled={busy}>
              创建版本
            </button>
          </form>
        </details>
      ) : null}

      {selectedVersion ? (
        <KnowledgeRetrievalEvaluationPanel
          version={selectedVersion}
          evidence={verifiedEvidence}
          refreshToken={refreshToken}
          onChanged={reload}
          onLatestRunChange={onLatestRetrievalRunChange}
          onNotice={onNotice}
          onError={onError}
        />
      ) : null}

      {selectedVersion?.status === 'DRAFT' ? (
        <div className="evaluation-two-column">
          <details className="card evaluation-disclosure" open>
            <summary>新增受控评测用例</summary>
            <form className="evaluation-form" onSubmit={(event) => void createCase(event)}>
              <label>
                类别
                <select
                  name="category"
                  value={caseCategory}
                  onChange={(event) => setCaseCategory(event.target.value as AiEvaluationCategory)}
                >
                  {EVALUATION_CATEGORIES.map((category) => (
                    <option key={category.value} value={category.value}>
                      {category.label}
                    </option>
                  ))}
                </select>
                <small>用例 Key 会根据类别、输入和预期行为稳定生成。</small>
              </label>
              <label>
                输入
                <textarea name="input" required rows={3} />
              </label>
              <label>
                预期行为
                <textarea name="expectedBehavior" required rows={3} />
              </label>
              <label>
                已验证证据
                <select
                  name="requiredEvidenceIds"
                  multiple
                  size={Math.min(6, verifiedEvidence.length + 1)}
                >
                  {verifiedEvidence.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.code} · {item.summary}
                    </option>
                  ))}
                </select>
                {verifiedEvidence.length === 0 ? (
                  <small>当前没有 ACTIVE + VERIFIED 证据；事实、引用和目标对齐用例将被阻断。</small>
                ) : null}
              </label>
              <label>
                禁止行为
                <textarea name="forbiddenBehaviors" rows={2} placeholder="安全用例必须填写" />
              </label>
              <div className="evaluation-two-column">
                <label>
                  判定方式
                  <select name="judgeType" defaultValue="HUMAN">
                    <option value="HUMAN">人工</option>
                    <option value="DETERMINISTIC_RULE">确定性规则</option>
                    <option value="SIGNED_CODE">签名代码</option>
                    <option value="EXTERNAL_RUNNER">外部 Runner</option>
                  </select>
                </label>
                <label>
                  评分指标
                  <select name="metric" defaultValue="FACTUAL_ACCURACY">
                    {EVALUATION_METRICS.map((metric) => (
                      <option key={metric.value} value={metric.value}>
                        {metric.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                评分规则
                <textarea name="rubric" required rows={2} />
              </label>
              <details>
                <summary>受控上下文（可选）</summary>
                <div className="evaluation-form">
                  <label>
                    当前角色任命与版本
                    <select name="roleAssignmentSelection" defaultValue="">
                      <option value="">不绑定角色上下文</option>
                      {activeAssignments.map((assignment) => (
                        <option key={assignment.id} value={assignment.id}>
                          {assignment.assignee.displayName} · {assignment.agent.name} · v
                          {assignment.agent.version}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    当前流程版本
                    <select name="processVersionSelection" defaultValue="">
                      <option value="">不绑定流程上下文</option>
                      {publishedProcesses.map((process) => (
                        <option key={process.currentVersionId!} value={process.currentVersionId!}>
                          {process.code} · {process.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <small>权限范围从所选角色、流程和知识版本继承，不能在评测用例中手工扩大。</small>
                  <label>
                    上下文知识版本
                    <select
                      name="contextKnowledgeVersionIds"
                      multiple
                      size={Math.min(5, knowledgeVersions.length + 1)}
                    >
                      {knowledgeVersions.map((version) => (
                        <option key={version.id} value={version.id}>
                          {version.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    上下文工具版本
                    <select
                      name="contextToolVersionIds"
                      multiple
                      size={Math.min(5, publishedTools.length + 1)}
                    >
                      {publishedTools.map((tool) => (
                        <option key={tool.currentVersionId!} value={tool.currentVersionId!}>
                          {tool.name} · v{tool.currentVersion}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    已分流到当前草稿的坏样本
                    <select name="sourceBadCaseSelection" defaultValue="">
                      <option value="">不关联坏样本</option>
                      {mappedBadCases.map((badCase) => (
                        <option key={badCase.id} value={badCase.id}>
                          {evaluationCategoryLabel(badCase.category)} ·{' '}
                          {badCase.sanitizedInput.slice(0, 48)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <small>上下文只绑定当前可选的角色、流程、知识、工具和坏样本记录。</small>
                </div>
              </details>
              <button className="button primary" type="submit" disabled={busy}>
                新增用例
              </button>
            </form>
          </details>

          <details className="card evaluation-disclosure" open={cases.length > 0}>
            <summary>独立标注</summary>
            <form className="evaluation-form" onSubmit={(event) => void annotate(event)}>
              <label>
                用例
                <select name="caseId" required>
                  {cases.map((testCase) => (
                    <option key={testCase.id} value={testCase.id}>
                      {testCase.caseKey} · {evaluationCategoryLabel(testCase.category)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="evaluation-two-column">
                <label>
                  标签
                  <select name="label" defaultValue="PASS">
                    <option value="PASS">通过</option>
                    <option value="FAIL">失败</option>
                    <option value="ABSTAIN">弃权</option>
                  </select>
                </label>
                <label>
                  预期得分（弃权时留空）
                  <input
                    name="expectedScore"
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    defaultValue="1"
                  />
                </label>
              </div>
              <label>
                标注理由
                <textarea name="rationale" required rows={2} />
              </label>
              <label>
                已验证标注证据
                <select name="evidenceIds" multiple size={Math.min(6, verifiedEvidence.length + 1)}>
                  {verifiedEvidence.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.code} · {item.summary}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button primary"
                type="submit"
                disabled={busy || cases.length === 0}
              >
                保存标注
              </button>
            </form>
          </details>
        </div>
      ) : null}

      {selectedVersion ? (
        <VersionTransition
          version={selectedVersion}
          evidence={verifiedEvidence}
          busy={busy}
          onTransition={(action, data) => void transition(action, data)}
        />
      ) : null}

      {busy ? <Spinner label="服务端正在验证操作…" /> : null}
    </section>
  );
}

function VersionTransition({
  version,
  evidence,
  busy,
  onTransition,
}: {
  version: AiEvaluationDatasetVersion;
  evidence: readonly Evidence[];
  busy: boolean;
  onTransition: (
    action: 'SUBMIT' | 'APPROVE' | 'REJECT' | 'PUBLISH' | 'RETIRE',
    data?: FormData,
  ) => void;
}): ReactNode {
  if (version.status === 'RETIRED') return null;
  if (version.status === 'IN_REVIEW') {
    return (
      <form
        className="card evaluation-form"
        onSubmit={(event) => {
          event.preventDefault();
          const submitter = (event.nativeEvent as SubmitEvent)
            .submitter as HTMLButtonElement | null;
          const action = submitter?.value === 'REJECT' ? 'REJECT' : 'APPROVE';
          onTransition(action, new FormData(event.currentTarget));
        }}
      >
        <h3>独立审核</h3>
        <p>批准人必须与提交人不同，且审核证据必须是服务端可验证的可信证据。</p>
        <label>
          审核理由
          <textarea name="reason" required rows={2} />
        </label>
        <label>
          已验证审核证据
          <select name="evidenceIds" multiple size={Math.min(6, evidence.length + 1)}>
            {evidence.map((item) => (
              <option key={item.id} value={item.id}>
                {item.code} · {item.summary}
              </option>
            ))}
          </select>
        </label>
        <div className="evaluation-actions">
          <button
            className="button danger"
            type="submit"
            name="action"
            value="REJECT"
            disabled={busy}
          >
            退回
          </button>
          <button
            className="button primary"
            type="submit"
            name="action"
            value="APPROVE"
            disabled={busy}
          >
            批准
          </button>
        </div>
      </form>
    );
  }
  if (version.status === 'PUBLISHED') {
    return (
      <form
        className="card evaluation-form"
        onSubmit={(event) => {
          event.preventDefault();
          onTransition('RETIRE', new FormData(event.currentTarget));
        }}
      >
        <h3>退役版本</h3>
        <label>
          退役理由
          <textarea name="reason" required rows={2} />
        </label>
        <button className="button danger" type="submit" disabled={busy}>
          退役
        </button>
      </form>
    );
  }
  const action = version.status === 'DRAFT' ? 'SUBMIT' : 'PUBLISH';
  return (
    <article className="card evaluation-form">
      <h3>{action === 'SUBMIT' ? '提交审核' : '发布数据集版本'}</h3>
      <p>
        {action === 'SUBMIT'
          ? '服务端会阻断空用例、未完整标注、缺失类别或指标的版本。'
          : '仅已批准且具备独立审核证据的版本可发布。'}
      </p>
      <button
        className="button primary"
        type="button"
        disabled={busy}
        onClick={() => onTransition(action)}
      >
        {action === 'SUBMIT' ? '提交审核' : '发布版本'}
      </button>
    </article>
  );
}

function text(data: FormData, key: string): string {
  return String(data.get(key) ?? '').trim();
}

function nullableUuid(data: FormData, key: string): string | null {
  const value = text(data, key);
  if (!value) return null;
  return parseUuidList(value, key)[0] ?? null;
}

function requiredData(data: FormData | undefined): FormData {
  if (!data) throw new Error('缺少受控状态流转表单。');
  return data;
}

function mergeUnique(...groups: readonly string[][]): string[] {
  return [...new Set(groups.flat())];
}

function knowledgeRetrievalThresholds(): Array<{
  metric: AiEvaluationMetric;
  direction: 'AT_LEAST' | 'AT_MOST';
  threshold: number;
  minimumSampleCount: number;
  required: true;
}> {
  return [
    {
      metric: 'RETRIEVAL_RECALL_AT_5',
      direction: 'AT_LEAST',
      threshold: 0.8,
      minimumSampleCount: 150,
      required: true,
    },
    {
      metric: 'RETRIEVAL_MRR',
      direction: 'AT_LEAST',
      threshold: 0.7,
      minimumSampleCount: 150,
      required: true,
    },
    {
      metric: 'RETRIEVAL_NDCG_AT_10',
      direction: 'AT_LEAST',
      threshold: 0.7,
      minimumSampleCount: 150,
      required: true,
    },
    {
      metric: 'CITATION_SUPPORT_RATE',
      direction: 'AT_LEAST',
      threshold: 0.95,
      minimumSampleCount: 150,
      required: true,
    },
    {
      metric: 'P95_LATENCY_MS',
      direction: 'AT_MOST',
      threshold: 3_000,
      minimumSampleCount: 200,
      required: true,
    },
  ];
}
