import type {
  KnowledgeProviderConnection,
  LexiangConnectionDiscoveryResponse,
} from '@enterprise/contracts';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import {
  checkLexiangKnowledgeHealth,
  connectLexiangKnowledge,
  discoverLexiangKnowledgeConnection,
  disableLexiangKnowledge,
  getLexiangKnowledgeConnection,
  syncLexiangKnowledgeBases,
} from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { Icon } from '@/components/Icons';
import { ErrorState, Notice, Spinner, StatusPill } from '@/components/ui';

type Feedback = { readonly tone: 'success' | 'error' | 'info'; readonly message: string };

export function KnowledgeIntegrationsPage(): ReactNode {
  const [connection, setConnection] = useState<KnowledgeProviderConnection | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [credentialAttested, setCredentialAttested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [discovery, setDiscovery] = useState<LexiangConnectionDiscoveryResponse | null>(null);
  const [teamId, setTeamId] = useState('');
  const [operatorStaffId, setOperatorStaffId] = useState('');

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await getLexiangKnowledgeConnection();
      setConnection(result.connection);
      setTeamId(result.connection?.teamId ?? '');
      setOperatorStaffId(result.connection?.operatorStaffId ?? '');
      setShowForm(result.connection === null || !result.connection.credentialsConfigured);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setLoaded(true);
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const connect = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const appKey = form.querySelector<HTMLInputElement>('input[name="appKey"]')?.value ?? '';
    const appSecret = form.querySelector<HTMLInputElement>('input[name="appSecret"]')?.value ?? '';
    setSubmitting(true);
    setFeedback(null);
    try {
      const result = await connectLexiangKnowledge({
        appKey,
        appSecret,
        teamId,
        operatorStaffId,
      });
      setConnection(result.connection);
      if (typeof form.reset === 'function') form.reset();
      setDiscovery(null);
      setCredentialAttested(false);
      setShowForm(false);
      try {
        const sync = await syncLexiangKnowledgeBases();
        setFeedback({
          tone: 'success',
          message: `腾讯乐享连接已安全保存；已发现 ${sync.discovered} 个知识库，新导入 ${sync.imported} 个，更新 ${sync.updated} 个，同步 ${sync.foldersSynchronized} 个文件夹和 ${sync.documentsDiscovered} 篇文档${sync.requiresPrivacyReview === 0 ? '' : `，其中 ${sync.requiresPrivacyReview} 个需要收口乐享侧权限`}。新导入知识库以草稿保存，请到知识库页面确认访问范围后启用。`,
        });
      } catch (caught) {
        setFeedback({
          tone: 'info',
          message: `腾讯乐享连接已安全保存，但已有知识库暂未导入：${messageFromError(caught)}。可到知识库页面重试同步。`,
        });
      }
    } catch (caught) {
      setFeedback({ tone: 'error', message: messageFromError(caught) });
    } finally {
      setSubmitting(false);
    }
  };

  const discover = async (form: HTMLFormElement | null): Promise<void> => {
    const appKey = form?.querySelector<HTMLInputElement>('input[name="appKey"]')?.value ?? '';
    const appSecret = form?.querySelector<HTMLInputElement>('input[name="appSecret"]')?.value ?? '';
    if (appKey.trim() === '' || appSecret === '') {
      setFeedback({ tone: 'error', message: '请先填写 AppKey 和 AppSecret。' });
      return;
    }
    setDiscovering(true);
    setFeedback(null);
    try {
      const result = await discoverLexiangKnowledgeConnection({ appKey, appSecret });
      setDiscovery(result);
      setTeamId(
        selectCandidate(
          teamId,
          result.teams.map((team) => team.id),
        ),
      );
      setOperatorStaffId(
        selectCandidate(
          operatorStaffId,
          result.operators.map((operator) => operator.staffId),
        ),
      );
      setFeedback(discoveryFeedback(result));
    } catch (caught) {
      setDiscovery(null);
      setFeedback({ tone: 'error', message: messageFromError(caught) });
    } finally {
      setDiscovering(false);
    }
  };

  const checkHealth = async (): Promise<void> => {
    setChecking(true);
    setFeedback(null);
    try {
      const result = await checkLexiangKnowledgeHealth();
      setConnection(result.connection);
      setFeedback({ tone: result.reachable ? 'success' : 'error', message: result.message });
    } catch (caught) {
      setFeedback({ tone: 'error', message: messageFromError(caught) });
    } finally {
      setChecking(false);
    }
  };

  const disable = async (): Promise<void> => {
    if (!window.confirm('确认停用腾讯乐享连接吗？已保存的 AppSecret 将被删除。')) return;
    setDisabling(true);
    setFeedback(null);
    try {
      const result = await disableLexiangKnowledge();
      setConnection(result.connection);
      setShowForm(true);
      setFeedback({ tone: 'info', message: '腾讯乐享连接已停用，服务端已删除保存的 AppSecret。' });
    } catch (caught) {
      setFeedback({ tone: 'error', message: messageFromError(caught) });
    } finally {
      setDisabling(false);
    }
  };

  if (!loaded && loading) return <Spinner label="正在读取知识来源…" />;
  if (error !== null && connection === null)
    return <ErrorState message={error} onRetry={() => void load()} />;

  const configured = connection?.credentialsConfigured === true;
  return (
    <section className="page-section">
      <header className="page-header">
        <div>
          <span className="eyebrow">KNOWLEDGE SOURCES</span>
          <h1>知识来源</h1>
          <p>连接外部企业知识服务，由本系统统一执行权限、引用和审计。</p>
        </div>
      </header>

      {feedback ? (
        <Notice tone={feedback.tone} onClose={() => setFeedback(null)}>
          {feedback.message}
        </Notice>
      ) : null}

      <section className="card integration-card" aria-labelledby="lexiang-integration-title">
        <header className="integration-header">
          <div className="integration-title">
            <span className="integration-mark" aria-hidden="true">
              乐
            </span>
            <div>
              <h2 id="lexiang-integration-title">腾讯乐享知识库</h2>
              <p>验证应用凭据，为后续知识库绑定和受控检索建立连接。</p>
            </div>
          </div>
          <StatusPill
            value={connection?.status ?? 'NOT_CONFIGURED'}
            label={connectionStatusLabel(connection?.status)}
          />
        </header>

        <div className="integration-body" aria-live="polite">
          <div className="integration-overview">
            <div>
              <span>应用身份</span>
              <strong>{connection?.appKeyHint ?? '尚未配置'}</strong>
            </div>
            <div>
              <span>凭据保存</span>
              <strong>{configured ? '已加密保存' : '未保存'}</strong>
            </div>
            <div>
              <span>默认团队</span>
              <strong>{connection?.teamId ?? '尚未配置'}</strong>
            </div>
            <div>
              <span>知识库访问身份</span>
              <strong>{connection?.operatorStaffId ?? '尚未配置'}</strong>
            </div>
            <div>
              <span>最近检测</span>
              <strong>{formatTime(connection?.lastHealthAt ?? null)}</strong>
            </div>
            <div>
              <span>连接结果</span>
              <strong>{healthLabel(connection)}</strong>
            </div>
          </div>

          {!configured ? (
            <Notice tone="info">
              当前尚未连接。AppSecret 只会经加密后保存在服务端，状态接口和页面都不会回传。
            </Notice>
          ) : (
            <Notice tone="info">
              当前检测会真实请求乐享 access_token 并读取指定团队的知识库列表；创建、删除和 AI
              搜索权限会在对应实际操作中继续校验。
            </Notice>
          )}

          {showForm ? (
            <>
              <Notice tone="error">
                请只输入未在聊天、工单、截图、日志或源码中暴露过的
                AppSecret；已暴露的密钥应先在乐享后台轮换。
              </Notice>
              <form className="integration-binding-form" onSubmit={(event) => void connect(event)}>
                <div className="binding-form-heading">
                  <div>
                    <strong>{configured ? '更新乐享凭据' : '连接腾讯乐享'}</strong>
                    <small>请在乐享开发者后台创建应用，并为其授予所需的知识接口权限。</small>
                  </div>
                  {configured ? (
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => setShowForm(false)}
                    >
                      收起
                    </button>
                  ) : null}
                </div>
                <div className="binding-fields">
                  <label>
                    <span>AppKey</span>
                    <input
                      name="appKey"
                      onChange={() => setDiscovery(null)}
                      placeholder="请输入乐享 AppKey"
                      autoComplete="off"
                      maxLength={200}
                      required
                    />
                  </label>
                  <label>
                    <span>AppSecret</span>
                    <input
                      name="appSecret"
                      type="password"
                      onChange={() => setDiscovery(null)}
                      placeholder="请输入应用密钥"
                      autoComplete="new-password"
                      minLength={8}
                      maxLength={500}
                      required
                    />
                  </label>
                </div>
                <div className="binding-form-actions">
                  <small>
                    系统会使用凭据读取乐享团队和访问身份候选，不保存 AppSecret，也不创建任何知识库。
                  </small>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={(event) =>
                      void discover(event.currentTarget.closest<HTMLFormElement>('form'))
                    }
                    disabled={discovering}
                  >
                    {discovering ? <Spinner label="正在自动获取…" /> : '自动获取团队与访问身份'}
                  </button>
                </div>
                <div className="binding-fields">
                  <label>
                    <span>乐享团队</span>
                    {discovery?.teamStatus === 'AVAILABLE' && discovery.teams.length > 0 ? (
                      <select
                        name="teamId"
                        value={teamId}
                        onChange={(event) => setTeamId(event.target.value)}
                        required
                      >
                        {discovery.teams.length > 1 ? (
                          <option value="">请选择乐享团队</option>
                        ) : null}
                        {discovery.teams.map((team) => (
                          <option key={team.id} value={team.id}>
                            {team.name}（{team.code}）
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        name="teamId"
                        value={teamId}
                        onChange={(event) => setTeamId(event.target.value)}
                        placeholder={
                          discovery === null
                            ? '请先自动获取'
                            : '乐享未授权读取团队列表，请填写绑定团队 ID'
                        }
                        autoComplete="off"
                        maxLength={200}
                        disabled={discovery === null}
                        required
                      />
                    )}
                  </label>
                  <label>
                    <span>知识库访问身份</span>
                    {discovery?.operatorStatus === 'AVAILABLE' && discovery.operators.length > 0 ? (
                      <select
                        name="operatorStaffId"
                        value={operatorStaffId}
                        onChange={(event) => setOperatorStaffId(event.target.value)}
                        required
                      >
                        {discovery.operators.length > 1 ? (
                          <option value="">请选择知识库访问身份</option>
                        ) : null}
                        {discovery.operators.map((operator) => (
                          <option key={operator.staffId} value={operator.staffId}>
                            {operator.name}（{operator.staffId}）
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        name="operatorStaffId"
                        value={operatorStaffId}
                        onChange={(event) => setOperatorStaffId(event.target.value)}
                        placeholder={
                          discovery === null
                            ? '请先自动获取'
                            : '乐享未返回管理员，请填写具有操作权限的 staff_id'
                        }
                        autoComplete="off"
                        maxLength={200}
                        disabled={discovery === null}
                        required
                      />
                    )}
                  </label>
                </div>
                <Notice tone="info">
                  该身份只用于应用调用乐享接口，不对应本系统员工；员工能否使用知识库仍由本系统的知识库访问范围决定。
                </Notice>
                <div className="binding-form-actions">
                  <div className="scope-mode-options">
                    <label>
                      <input
                        type="checkbox"
                        checked={credentialAttested}
                        onChange={(event) => setCredentialAttested(event.target.checked)}
                        required
                      />
                      <span>我确认当前密钥已在乐享后台安全生成，且未经暴露。</span>
                    </label>
                  </div>
                  <small>提交时会在服务端真实换取令牌，验证失败不会保存新凭据。</small>
                  <button
                    className="button primary"
                    type="submit"
                    disabled={
                      submitting ||
                      !credentialAttested ||
                      discovery === null ||
                      teamId === '' ||
                      operatorStaffId === ''
                    }
                  >
                    {submitting ? <Spinner label="正在连接并同步…" /> : '验证并连接'}
                  </button>
                </div>
              </form>
            </>
          ) : null}
        </div>

        <footer className="integration-actions">
          {!showForm ? (
            <button className="button secondary" type="button" onClick={() => setShowForm(true)}>
              更新凭据
            </button>
          ) : null}
          <button
            className="button secondary"
            type="button"
            onClick={() => void load()}
            disabled={loading}
          >
            <Icon name="refresh" size={17} /> {loading ? '正在刷新…' : '刷新状态'}
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={() => void checkHealth()}
            disabled={!configured || checking}
          >
            {checking ? <Spinner label="正在检测…" /> : '检测连接'}
          </button>
          <button
            className="button danger-ghost"
            type="button"
            onClick={() => void disable()}
            disabled={!configured || disabling}
          >
            {disabling ? '正在停用…' : '停用连接'}
          </button>
        </footer>
      </section>
    </section>
  );
}

function connectionStatusLabel(status: KnowledgeProviderConnection['status'] | undefined): string {
  if (status === undefined) return '未配置';
  return {
    PENDING: '待验证',
    ACTIVE: '已连接',
    UNAVAILABLE: '连接异常',
    DISABLED: '已停用',
  }[status];
}

function healthLabel(connection: KnowledgeProviderConnection | null): string {
  if (connection === null) return '待连接';
  if (connection.status === 'ACTIVE') return '凭据有效';
  if (connection.status === 'DISABLED') return '已停用';
  if (connection.status === 'UNAVAILABLE') return '需要处理';
  return '待验证';
}

function formatTime(value: string | null): string {
  if (value === null) return '尚未检测';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function selectCandidate(current: string, candidates: readonly string[]): string {
  if (candidates.length === 0 || candidates.includes(current)) return current;
  return candidates.length === 1 ? candidates[0]! : '';
}

function discoveryFeedback(result: LexiangConnectionDiscoveryResponse): Feedback {
  if (result.teamStatus === 'FORBIDDEN') {
    return {
      tone: 'info',
      message:
        '凭据有效，但乐享拒绝读取团队列表。请给该 AppKey 开启“团队管理/获取团队列表”权限；在此之前只能填写已绑定的团队 ID。',
    };
  }
  if (result.operatorStatus === 'FORBIDDEN') {
    return {
      tone: 'info',
      message:
        '团队已获取，但乐享拒绝读取管理员列表。请给该 AppKey 开启“通讯录管理”权限，或填写具有知识库访问权限的 staff_id。',
    };
  }
  if (result.teams.length === 0 || result.operators.length === 0) {
    return {
      tone: 'info',
      message: '凭据有效，但乐享没有返回可选团队或管理员，请检查应用授权范围。',
    };
  }
  return {
    tone: 'success',
    message:
      result.teams.length === 1 && result.operators.length === 1
        ? '已自动回填乐享团队和访问身份。'
        : '已获取乐享团队和访问身份，请确认选择后连接。',
  };
}
