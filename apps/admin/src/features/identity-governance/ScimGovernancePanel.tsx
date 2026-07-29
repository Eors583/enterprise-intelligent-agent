import type {
  ScimConnector,
  ScimScope,
  ScimServiceTokenCreated,
  ScimServiceTokenMetadata,
} from '@enterprise/contracts';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { messageFromError } from '@/api/client';
import { EmptyState, Notice, StatusPill } from '@/components/ui';
import {
  createScimConnector,
  createScimServiceToken,
  listScimConnectors,
  listScimServiceTokens,
  revokeScimServiceToken,
  rotateScimServiceToken,
  transitionScimConnector,
  updateScimConnector,
} from './api';

const SCOPES: ReadonlyArray<{ value: ScimScope; label: string }> = [
  { value: 'scim.users.read', label: '读取用户' },
  { value: 'scim.users.write', label: '写入用户' },
  { value: 'scim.groups.read', label: '读取群组' },
  { value: 'scim.groups.write', label: '写入群组' },
];

export function ScimGovernancePanel({ currentUserId }: { currentUserId: string }): ReactNode {
  const [connectors, setConnectors] = useState<ScimConnector[] | null>(null);
  const [selectedConnectorId, setSelectedConnectorId] = useState<string | null>(null);
  const [tokens, setTokens] = useState<ScimServiceTokenMetadata[] | null>(null);
  const [editing, setEditing] = useState<ScimConnector | null>(null);
  const [revealedToken, setRevealedToken] = useState<ScimServiceTokenCreated | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedConnector =
    connectors?.find((connector) => connector.id === selectedConnectorId) ?? null;

  const loadConnectors = useCallback(async (): Promise<void> => {
    try {
      const result = await listScimConnectors();
      setConnectors(result.items);
      setSelectedConnectorId((current) =>
        current !== null && result.items.some((item) => item.id === current)
          ? current
          : (result.items[0]?.id ?? null),
      );
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }, []);

  const loadTokens = useCallback(async (connectorId: string): Promise<void> => {
    setTokens(null);
    try {
      const result = await listScimServiceTokens(connectorId);
      setTokens(result.items);
    } catch (caught) {
      setError(messageFromError(caught));
      setTokens([]);
    }
  }, []);

  useEffect(() => {
    void loadConnectors();
  }, [loadConnectors]);

  useEffect(() => {
    if (selectedConnectorId === null) {
      setTokens([]);
      return;
    }
    void loadTokens(selectedConnectorId);
  }, [loadTokens, selectedConnectorId]);

  const run = async (
    operation: () => Promise<unknown>,
    success: string,
    reloadTokens = true,
  ): Promise<void> => {
    setWorking(true);
    setError(null);
    try {
      await operation();
      setNotice(success);
      await loadConnectors();
      if (reloadTokens && selectedConnectorId !== null) {
        await loadTokens(selectedConnectorId);
      }
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setWorking(false);
    }
  };

  const saveConnector = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const common = {
      displayName: String(form.get('displayName') ?? ''),
      allowUserCreate: form.get('allowUserCreate') === 'on',
      allowGroupCreate: form.get('allowGroupCreate') === 'on',
      deactivateUserOnScimDisable: form.get('deactivateUserOnScimDisable') === 'on',
      idempotencyKey: crypto.randomUUID(),
    };
    if (editing === null) {
      await run(
        () =>
          createScimConnector({
            ...common,
            key: String(form.get('key') ?? '')
              .trim()
              .toLowerCase(),
            expectedRevision: 0,
          }),
        'SCIM 连接器草稿已创建。完成最近 MFA 后提交复核。',
        false,
      );
      event.currentTarget.reset();
      return;
    }
    await run(
      () =>
        updateScimConnector(editing.id, {
          ...common,
          expectedRevision: editing.revision,
        }),
      'SCIM 连接器已更新并回到草稿状态。',
    );
    setEditing(null);
  };

  const transition = async (
    connector: ScimConnector,
    action: 'submit' | 'activate' | 'suspend' | 'retire',
  ): Promise<void> => {
    await run(
      () =>
        transitionScimConnector(connector.id, action, {
          expectedRevision: connector.revision,
          idempotencyKey: crypto.randomUUID(),
        }),
      {
        submit: 'SCIM 连接器已提交异人复核。',
        activate: 'SCIM 连接器已由独立复核人启用。',
        suspend: 'SCIM 连接器已暂停，现有令牌立即失效。',
        retire: 'SCIM 连接器已退役，不能恢复。',
      }[action],
    );
  };

  const issueToken = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (selectedConnector === null) return;
    const form = new FormData(event.currentTarget);
    const scopes = [
      ...event.currentTarget.querySelectorAll<HTMLInputElement>('input[name="scopes"]:checked'),
    ].map((input) => input.value as ScimScope);
    const expiresAtInput = String(form.get('expiresAt') ?? '');
    setWorking(true);
    setError(null);
    try {
      const created = await createScimServiceToken(selectedConnector.id, {
        scopes,
        expiresAt: expiresAtInput === '' ? null : new Date(expiresAtInput).toISOString(),
        idempotencyKey: crypto.randomUUID(),
      });
      setRevealedToken(created);
      setNotice('SCIM 服务令牌已签发。关闭一次性展示后无法再次查看明文。');
      await loadTokens(selectedConnector.id);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setWorking(false);
    }
  };

  const rotateToken = async (token: ScimServiceTokenMetadata): Promise<void> => {
    if (selectedConnector === null) return;
    setWorking(true);
    setError(null);
    try {
      const created = await rotateScimServiceToken(selectedConnector.id, token.id, {
        scopes: token.scopes,
        expiresAt: addDaysIso(90),
        expectedRevision: token.revision,
        idempotencyKey: crypto.randomUUID(),
      });
      setRevealedToken(created);
      setNotice('旧令牌已原子撤销，新令牌只在本次页面中显示一次。');
      await loadTokens(selectedConnector.id);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setWorking(false);
    }
  };

  if (connectors === null) {
    return (
      <article className="card">
        <p>正在读取 SCIM 连接器…</p>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </article>
    );
  }

  return (
    <article className="card" aria-label="SCIM 2.0 身份供应">
      <header className="card-header">
        <div>
          <h2>SCIM 2.0 自动开户与离职回收</h2>
          <p>连接器采用草稿、复核、异人启用、暂停和退役生命周期；服务令牌仅保存哈希。</p>
        </div>
      </header>

      <Notice tone="info">
        创建、修改、启用、暂停、退役和令牌操作均需要管理员权限与最近 MFA。SAML 仍保持
        fail-closed，本区域不会启用 SAML。
      </Notice>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}

      {revealedToken ? (
        <section className="subcard" role="alert" aria-label="一次性 SCIM 服务令牌">
          <h3>令牌明文只显示一次，请立即复制</h3>
          <p>关闭后系统只保留不可逆哈希；刷新页面、重复请求或审计日志均不能找回明文。</p>
          <label>
            <span>SCIM Bearer Token</span>
            <textarea readOnly rows={3} value={revealedToken.token} />
          </label>
          <div className="button-row">
            <button
              className="button primary small"
              type="button"
              onClick={() => void navigator.clipboard?.writeText(revealedToken.token)}
            >
              复制令牌
            </button>
            <button
              className="button secondary small"
              type="button"
              onClick={() => setRevealedToken(null)}
            >
              我已安全保存，关闭
            </button>
          </div>
        </section>
      ) : null}

      <div className="content-grid two">
        <section className="subcard">
          <h3>{editing === null ? '新建连接器草稿' : `编辑 ${editing.displayName}`}</h3>
          <form
            className="form-stack"
            key={editing?.id ?? 'new-scim-connector'}
            onSubmit={(event) => void saveConnector(event)}
          >
            <label>
              <span>连接器标识（创建后不可修改）</span>
              <input
                name="key"
                required
                disabled={editing !== null}
                defaultValue={editing?.key ?? ''}
                placeholder="corporate-directory"
              />
            </label>
            <label>
              <span>显示名称</span>
              <input name="displayName" required defaultValue={editing?.displayName ?? ''} />
            </label>
            <label className="checkbox-row">
              <input
                name="allowUserCreate"
                type="checkbox"
                defaultChecked={editing?.allowUserCreate ?? true}
              />
              <span>允许 SCIM 创建用户</span>
            </label>
            <label className="checkbox-row">
              <input
                name="allowGroupCreate"
                type="checkbox"
                defaultChecked={editing?.allowGroupCreate ?? true}
              />
              <span>允许 SCIM 创建群组</span>
            </label>
            <label className="checkbox-row">
              <input
                name="deactivateUserOnScimDisable"
                type="checkbox"
                defaultChecked={editing?.deactivateUserOnScimDisable ?? true}
              />
              <span>SCIM 停用用户时同步撤销会话与授权</span>
            </label>
            <div className="button-row">
              <button className="button primary small" type="submit" disabled={working}>
                {editing === null ? '创建草稿' : '保存并回到草稿'}
              </button>
              {editing ? (
                <button
                  className="button secondary small"
                  type="button"
                  onClick={() => setEditing(null)}
                >
                  取消编辑
                </button>
              ) : null}
            </div>
          </form>
        </section>

        <section className="subcard">
          <h3>连接器生命周期</h3>
          {connectors.length === 0 ? (
            <EmptyState
              title="尚未配置 SCIM"
              description="创建连接器后提交复核，再由另一位管理员启用。"
            />
          ) : (
            <div className="form-stack">
              {connectors.map((connector) => (
                <section className="subcard" key={connector.id}>
                  <div className="subcard-title">
                    <strong>{connector.displayName}</strong>
                    <StatusPill value={connector.status} />
                  </div>
                  <p>
                    <code>{connector.basePath}</code> · revision {connector.revision}
                  </p>
                  <div className="button-row">
                    {connector.status !== 'RETIRED' ? (
                      <button
                        className="button secondary small"
                        type="button"
                        disabled={working}
                        onClick={() => setEditing(connector)}
                      >
                        编辑
                      </button>
                    ) : null}
                    {connector.status === 'DRAFT' ? (
                      <button
                        className="button secondary small"
                        type="button"
                        disabled={working}
                        onClick={() => void transition(connector, 'submit')}
                      >
                        提交复核
                      </button>
                    ) : null}
                    {connector.status === 'IN_REVIEW' || connector.status === 'SUSPENDED' ? (
                      <button
                        className="button primary small"
                        type="button"
                        disabled={working || connector.proposedByUserId === currentUserId}
                        onClick={() => void transition(connector, 'activate')}
                      >
                        异人启用
                      </button>
                    ) : null}
                    {connector.status === 'ACTIVE' ? (
                      <button
                        className="button danger small"
                        type="button"
                        disabled={working}
                        onClick={() => void transition(connector, 'suspend')}
                      >
                        暂停
                      </button>
                    ) : null}
                    {connector.status === 'ACTIVE' || connector.status === 'SUSPENDED' ? (
                      <button
                        className="button danger small"
                        type="button"
                        disabled={working}
                        onClick={() => void transition(connector, 'retire')}
                      >
                        退役
                      </button>
                    ) : null}
                    <button
                      className="button secondary small"
                      type="button"
                      disabled={working}
                      onClick={() => setSelectedConnectorId(connector.id)}
                    >
                      管理令牌
                    </button>
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>
      </div>

      {selectedConnector ? (
        <section className="subcard">
          <header className="card-header">
            <div>
              <h3>{selectedConnector.displayName} · 服务令牌</h3>
              <p>列表只展示末尾提示，不返回令牌明文或哈希。</p>
            </div>
          </header>
          {selectedConnector.status === 'ACTIVE' ? (
            <form className="form-stack" onSubmit={(event) => void issueToken(event)}>
              <div className="form-grid two">
                {SCOPES.map((scope) => (
                  <label className="checkbox-row" key={scope.value}>
                    <input name="scopes" type="checkbox" value={scope.value} defaultChecked />
                    <span>
                      {scope.label}（{scope.value}）
                    </span>
                  </label>
                ))}
              </div>
              <label>
                <span>到期时间（建议 90 天；留空表示不自动到期）</span>
                <input name="expiresAt" type="datetime-local" defaultValue={addDaysLocal(90)} />
              </label>
              <button className="button primary small" type="submit" disabled={working}>
                签发一次性令牌
              </button>
            </form>
          ) : (
            <Notice tone="info">只有 ACTIVE 连接器可以签发或轮换服务令牌。</Notice>
          )}

          {tokens === null ? (
            <p>正在读取令牌摘要…</p>
          ) : tokens.length === 0 ? (
            <EmptyState title="尚无服务令牌" description="启用连接器后签发最小权限令牌。" />
          ) : (
            <div className="card-grid">
              {tokens.map((token) => (
                <section className="subcard" key={token.id}>
                  <div className="subcard-title">
                    <strong>•••• {token.tokenHint}</strong>
                    <StatusPill value={token.status} />
                  </div>
                  <p>{token.scopes.join(' · ')}</p>
                  <p>
                    到期：{token.expiresAt ?? '不自动到期'} · 最近使用：
                    {token.lastUsedAt ?? '从未使用'}
                  </p>
                  {token.status === 'ACTIVE' ? (
                    <div className="button-row">
                      <button
                        className="button secondary small"
                        type="button"
                        disabled={working || selectedConnector.status !== 'ACTIVE'}
                        onClick={() => void rotateToken(token)}
                      >
                        原子轮换（90 天）
                      </button>
                      <button
                        className="button danger small"
                        type="button"
                        disabled={working}
                        onClick={() =>
                          void run(
                            () =>
                              revokeScimServiceToken(selectedConnector.id, token.id, {
                                expectedRevision: token.revision,
                                idempotencyKey: crypto.randomUUID(),
                              }),
                            'SCIM 服务令牌已撤销，不能恢复。',
                          )
                        }
                      >
                        撤销
                      </button>
                    </div>
                  ) : null}
                </section>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </article>
  );
}

function addDaysIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function addDaysLocal(days: number): string {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}
