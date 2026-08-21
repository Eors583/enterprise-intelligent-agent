import type { KnowledgeSourceConnector } from '@enterprise/contracts';
import { useEffect, useState, type ReactNode } from 'react';

import {
  createKnowledgeSourceConnector,
  listKnowledgeSourceConnectors,
  syncKnowledgeSourceConnector,
  updateKnowledgeSourceConnector,
} from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { FieldError, Modal, Spinner, StatusPill } from '@/components/ui';

function formatTime(value: string | null): string {
  if (value === null) return '尚未同步';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function KnowledgeSourceConnectorsPanel({
  knowledgeBaseId,
  disabled,
  onChanged,
}: {
  knowledgeBaseId: string;
  disabled: boolean;
  onChanged: (message: string) => void;
}): ReactNode {
  const [items, setItems] = useState<KnowledgeSourceConnector[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [changingId, setChangingId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('企业文档源');
  const [manifestUrl, setManifestUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = async (signal?: AbortSignal): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await listKnowledgeSourceConnectors(knowledgeBaseId, signal);
      setItems(response.items);
    } catch (caught) {
      if (signal?.aborted) return;
      setError(messageFromError(caught));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [knowledgeBaseId]);

  const create = async (): Promise<void> => {
    setCreating(true);
    setError(null);
    try {
      await createKnowledgeSourceConnector(knowledgeBaseId, { name, manifestUrl });
      setCreateOpen(false);
      setManifestUrl('');
      await load();
      onChanged('文档源已连接。点击“立即同步”即可发现新增、更新和删除的文件。');
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setCreating(false);
    }
  };

  const sync = async (connector: KnowledgeSourceConnector): Promise<void> => {
    setSyncingId(connector.id);
    setError(null);
    try {
      const run = await syncKnowledgeSourceConnector(knowledgeBaseId, connector.id);
      await load();
      if (run.status === 'FAILED') {
        const first = run.failures[0];
        setError(
          first
            ? `同步未完全成功：${first.code}。游标未前移，可修复来源后安全重试。`
            : '同步未完全成功，游标未前移，可安全重试。',
        );
        return;
      }
      onChanged(
        `文档源同步完成：新增 ${run.createdCount}、更新 ${run.updatedCount}、删除 ${run.deletedCount}、未变化 ${run.skippedCount}。新版本已进入解析队列。`,
      );
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSyncingId(null);
    }
  };

  const toggleStatus = async (connector: KnowledgeSourceConnector): Promise<void> => {
    setChangingId(connector.id);
    setError(null);
    try {
      await updateKnowledgeSourceConnector(knowledgeBaseId, connector.id, {
        status: connector.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE',
      });
      await load();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setChangingId(null);
    }
  };

  return (
    <>
      <div className="knowledge-source-connectors-dialog">
        <header>
          <div>
            <strong>企业网盘与文档源</strong>
            <p>
              自动发现新增、更新和删除。原文件进入知识对象存储，数据库只保存映射、游标和同步记录。
            </p>
          </div>
          <button
            className="button secondary compact"
            type="button"
            disabled={disabled}
            onClick={() => setCreateOpen(true)}
          >
            连接文档源
          </button>
        </header>
        <FieldError message={error} />
        {loading ? (
          <Spinner label="正在读取文档源…" />
        ) : items.length === 0 ? (
          <p className="knowledge-source-empty">
            还没有连接文档源。手工上传不受影响；需要自动同步时再连接。
          </p>
        ) : (
          <div className="knowledge-source-connector-list">
            {items.map((connector) => (
              <article key={connector.id}>
                <div>
                  <strong>{connector.name}</strong>
                  <small title={connector.manifestUrl}>{connector.manifestUrl}</small>
                  <span>
                    {connector.itemCount} 份有效文件 · {formatTime(connector.lastSyncedAt)}
                  </span>
                </div>
                <StatusPill
                  value={connector.status === 'ACTIVE' ? 'READY' : 'DRAFT'}
                  label={connector.status === 'ACTIVE' ? '同步已开启' : '已暂停'}
                />
                {connector.lastRun ? (
                  <small className="knowledge-source-last-run">
                    上次{connector.lastRun.status === 'SUCCEEDED' ? '成功' : '失败'}：新增{' '}
                    {connector.lastRun.createdCount} / 更新 {connector.lastRun.updatedCount} / 删除{' '}
                    {connector.lastRun.deletedCount}
                  </small>
                ) : null}
                <div className="knowledge-source-connector-actions">
                  <button
                    className="button primary compact"
                    type="button"
                    disabled={disabled || connector.status !== 'ACTIVE' || syncingId !== null}
                    onClick={() => void sync(connector)}
                  >
                    {syncingId === connector.id ? <Spinner label="同步中…" /> : '立即同步'}
                  </button>
                  <button
                    className="button ghost compact"
                    type="button"
                    disabled={disabled || changingId !== null || syncingId !== null}
                    onClick={() => void toggleStatus(connector)}
                  >
                    {changingId === connector.id
                      ? '保存中…'
                      : connector.status === 'ACTIVE'
                        ? '暂停'
                        : '恢复'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {createOpen ? (
        <Modal
          title="连接企业网盘或文档源"
          description="填写由网盘适配器提供的 HTTPS 增量清单地址。账号密钥不在此表单中明文保存。"
          onClose={() => setCreateOpen(false)}
          dismissible={!creating}
        >
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <label>
              来源名称
              <input
                value={name}
                maxLength={120}
                required
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：公司制度网盘"
              />
            </label>
            <label>
              HTTPS 清单地址
              <input
                type="url"
                value={manifestUrl}
                maxLength={2_000}
                required
                pattern="https://.*"
                onChange={(event) => setManifestUrl(event.target.value)}
                placeholder="https://connector.example.com/knowledge/manifest"
              />
            </label>
            <p className="form-help">
              清单按游标返回文件变更；文件正文不会进入业务数据库，而是下载到知识对象存储后再解析和索引。
            </p>
            <div className="modal-actions">
              <button
                className="button secondary"
                type="button"
                disabled={creating}
                onClick={() => setCreateOpen(false)}
              >
                取消
              </button>
              <button className="button primary" type="submit" disabled={creating}>
                {creating ? <Spinner label="正在连接…" /> : '确认连接'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
