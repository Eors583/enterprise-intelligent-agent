import type {
  BreakGlassScope,
  IdentitySecurityOverview,
  MfaEnrollmentStartResponse,
} from '@enterprise/contracts';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { messageFromError } from '@/api/client';
import { EmptyState, ErrorState, LoadingPanel, Notice, StatusPill } from '@/components/ui';
import {
  activateBreakGlass,
  createBreakGlass,
  identitySecurityOverview,
  listMyBreakGlass,
  requestRecentMfa,
  revokeIdentityDevice,
  revokeIdentitySession,
  revokeMyBreakGlass,
  startMfaEnrollment,
  verifyMfaEnrollment,
  verifyRecentMfa,
} from './api';

const BREAK_GLASS_SCOPES: ReadonlyArray<{
  value: BreakGlassScope;
  label: string;
}> = [
  { value: 'IDENTITY_PROVIDER_RECOVERY', label: '身份提供方恢复' },
  { value: 'AUTHENTICATION_POLICY_RECOVERY', label: '认证策略恢复' },
  { value: 'SESSION_REVOCATION', label: '会话紧急撤销' },
  { value: 'SCIM_RECOVERY', label: 'SCIM 同步恢复' },
];

export function IdentitySecurityPage(): ReactNode {
  const [overview, setOverview] = useState<IdentitySecurityOverview | null>(null);
  const [breakGlass, setBreakGlass] = useState<Awaited<ReturnType<typeof listMyBreakGlass>> | null>(
    null,
  );
  const [enrollment, setEnrollment] = useState<MfaEnrollmentStartResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const [security, requests] = await Promise.all([
        identitySecurityOverview(),
        listMyBreakGlass(),
      ]);
      setOverview(security);
      setBreakGlass(requests);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const beginEnrollment = async (): Promise<void> => {
    setWorking(true);
    setError(null);
    try {
      setEnrollment(await startMfaEnrollment({ label: '企业管理后台' }));
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setWorking(false);
    }
  };

  const confirmEnrollment = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!enrollment) return;
    const form = new FormData(event.currentTarget);
    setWorking(true);
    setError(null);
    try {
      const result = await verifyMfaEnrollment({
        factorId: enrollment.factorId,
        code: String(form.get('code') ?? ''),
      });
      setEnrollment(null);
      setNotice(
        `MFA 已启用。请立即离线保存 ${result.recoveryCodes.length} 个一次性恢复码：${result.recoveryCodes.join(
          ' · ',
        )}`,
      );
      await load();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setWorking(false);
    }
  };

  const stepUp = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setWorking(true);
    setError(null);
    try {
      const method = String(form.get('method')) as 'TOTP' | 'RECOVERY_CODE';
      const challenge = await requestRecentMfa({ purpose: 'identity-governance' });
      const verified = await verifyRecentMfa({
        challenge: challenge.challenge,
        code: String(form.get('code') ?? ''),
        method,
      });
      setNotice(`敏感操作验证已完成（${verified.method}，${formatTime(verified.verifiedAt)}）。`);
      event.currentTarget.reset();
      await load();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setWorking(false);
    }
  };

  const submitBreakGlass = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const scopes = BREAK_GLASS_SCOPES.filter(({ value }) => form.get(value) === 'on').map(
      ({ value }) => value,
    );
    setWorking(true);
    setError(null);
    try {
      await createBreakGlass({
        scopes,
        reason: String(form.get('reason') ?? ''),
        requestedDurationSeconds: Number(form.get('duration') ?? 300),
        idempotencyKey: crypto.randomUUID(),
      });
      event.currentTarget.reset();
      setNotice('临时授权申请已提交；必须由另一位所有者或管理员审批后才能激活。');
      await load();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setWorking(false);
    }
  };

  if (loading) return <LoadingPanel label="正在读取身份安全状态…" />;
  if (!overview || !breakGlass) {
    return <ErrorState message={error ?? '身份安全状态不可用。'} onRetry={() => void load()} />;
  }

  return (
    <section className="page identity-security-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">IDENTITY & ACCESS</p>
          <h1>我的身份安全</h1>
          <p>管理多因素认证、可信设备、登录会话和受双人审批约束的临时授权。</p>
        </div>
        <button className="button secondary" type="button" onClick={() => void load()}>
          刷新状态
        </button>
      </header>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}

      <div className="content-grid two">
        <article className="card">
          <header className="card-header">
            <div>
              <h2>多因素认证</h2>
              <p>TOTP 验证码具备时间步重放防护；恢复码只能使用一次。</p>
            </div>
            <StatusPill
              value={
                overview.mfa.factors.some((factor) => factor.status === 'ACTIVE')
                  ? 'ACTIVE'
                  : 'PENDING'
              }
              label={
                overview.mfa.factors.some((factor) => factor.status === 'ACTIVE')
                  ? '已启用'
                  : '未启用'
              }
            />
          </header>
          <p>剩余恢复码：{overview.mfa.recoveryCodesRemaining}</p>
          {!enrollment ? (
            <button
              className="button primary"
              type="button"
              disabled={working}
              onClick={() => void beginEnrollment()}
            >
              配置身份验证器
            </button>
          ) : (
            <form className="form-stack" onSubmit={(event) => void confirmEnrollment(event)}>
              <label>
                <span>手动输入密钥</span>
                <input readOnly value={enrollment.secret} />
              </label>
              <label>
                <span>otpauth URI</span>
                <textarea readOnly rows={3} value={enrollment.otpauthUri} />
              </label>
              <label>
                <span>验证器中的 6 位验证码</span>
                <input name="code" inputMode="numeric" autoComplete="one-time-code" required />
              </label>
              <button className="button primary" type="submit" disabled={working}>
                验证并启用
              </button>
            </form>
          )}
        </article>

        <article className="card">
          <header className="card-header">
            <div>
              <h2>敏感操作二次验证</h2>
              <p>临时授权激活、审批、撤销和复盘关闭都要求最近一次 MFA。</p>
            </div>
          </header>
          <form className="form-stack" onSubmit={(event) => void stepUp(event)}>
            <label>
              <span>验证方式</span>
              <select name="method" defaultValue="TOTP">
                <option value="TOTP">身份验证器</option>
                <option value="RECOVERY_CODE">一次性恢复码</option>
              </select>
            </label>
            <label>
              <span>验证码</span>
              <input name="code" autoComplete="one-time-code" required />
            </label>
            <button className="button secondary" type="submit" disabled={working}>
              完成二次验证
            </button>
          </form>
          <p className="muted">
            最近验证：{overview.mfa.recentMfaAt ? formatTime(overview.mfa.recentMfaAt) : '尚未验证'}
          </p>
        </article>
      </div>

      <article className="card">
        <header className="card-header">
          <div>
            <h2>登录会话</h2>
            <p>刷新令牌重放会撤销整个令牌族；撤销设备也会同步撤销关联会话。</p>
          </div>
        </header>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>会话</th>
                <th>最近使用</th>
                <th>MFA</th>
                <th>刷新代次</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {overview.sessions.map((session) => (
                <tr key={session.id}>
                  <td>
                    {session.label ?? session.id.slice(0, 8)}
                    {session.current ? '（当前）' : ''}
                  </td>
                  <td>{formatTime(session.lastUsedAt)}</td>
                  <td>{session.lastMfaAt ? formatTime(session.lastMfaAt) : '—'}</td>
                  <td>{session.refreshGeneration}</td>
                  <td>{session.revokedAt ? '已撤销' : '有效'}</td>
                  <td>
                    <button
                      className="button danger small"
                      type="button"
                      disabled={working || session.revokedAt !== null}
                      onClick={() =>
                        void runMutation(
                          () =>
                            revokeIdentitySession(session.id, {
                              reason: '用户从身份安全中心主动撤销。',
                              expectedRevision: session.version,
                            }),
                          setWorking,
                          setError,
                          setNotice,
                          load,
                          '会话及其刷新令牌族已撤销。',
                        )
                      }
                    >
                      撤销
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>

      <article className="card">
        <header className="card-header">
          <div>
            <h2>可信设备</h2>
            <p>设备指纹只保存服务器加盐摘要，不保存原始指纹。</p>
          </div>
        </header>
        {overview.devices.length === 0 ? (
          <EmptyState title="暂无设备记录" description="下次登录注册设备后会显示在这里。" />
        ) : (
          <div className="card-grid">
            {overview.devices.map((device) => (
              <section className="subcard" key={device.id}>
                <h3>{device.label ?? device.platform ?? '未命名设备'}</h3>
                <p>
                  {device.deviceClass ?? '设备'} · 最近使用 {formatTime(device.lastSeenAt)}
                </p>
                <StatusPill
                  value={device.status}
                  label={device.status === 'ACTIVE' ? '有效' : '已撤销'}
                />
                <button
                  className="button danger small"
                  type="button"
                  disabled={working || device.status === 'REVOKED'}
                  onClick={() =>
                    void runMutation(
                      () =>
                        revokeIdentityDevice(device.id, {
                          reason: '用户从身份安全中心主动撤销设备。',
                          expectedRevision: device.revision,
                        }),
                      setWorking,
                      setError,
                      setNotice,
                      load,
                      '设备及其关联会话已撤销。',
                    )
                  }
                >
                  撤销设备
                </button>
              </section>
            ))}
          </div>
        )}
      </article>

      <article className="card">
        <header className="card-header">
          <div>
            <h2>临时授权（Break-glass）</h2>
            <p>
              申请不会直接提权：异人审批后仍需本人 MFA 激活，最长 15 分钟，到期立即失效并进入复盘。
            </p>
          </div>
        </header>
        <form className="form-stack" onSubmit={(event) => void submitBreakGlass(event)}>
          <fieldset>
            <legend>申请范围</legend>
            {BREAK_GLASS_SCOPES.map((scope) => (
              <label className="checkbox-row" key={scope.value}>
                <input type="checkbox" name={scope.value} />
                <span>{scope.label}</span>
              </label>
            ))}
          </fieldset>
          <label>
            <span>业务原因（至少 20 个字符）</span>
            <textarea name="reason" rows={3} minLength={20} maxLength={1000} required />
          </label>
          <label>
            <span>激活时长</span>
            <select name="duration" defaultValue="300">
              <option value="300">5 分钟</option>
              <option value="600">10 分钟</option>
              <option value="900">15 分钟</option>
            </select>
          </label>
          <button className="button primary" type="submit" disabled={working}>
            提交临时授权申请
          </button>
        </form>
        <div className="card-grid">
          {breakGlass.items.map((item) => (
            <section className="subcard" key={item.id}>
              <div className="subcard-title">
                <StatusPill value={item.status} />
                <strong>{item.scopes.map(scopeLabel).join('、')}</strong>
              </div>
              <p>{item.reason}</p>
              <p>
                时长 {Math.round(item.requestedDurationSeconds / 60)} 分钟
                {item.activeUntil ? ` · 截止 ${formatTime(item.activeUntil)}` : ''}
              </p>
              {item.status === 'APPROVED' ? (
                <button
                  className="button primary small"
                  type="button"
                  disabled={working}
                  onClick={() =>
                    void runMutation(
                      () =>
                        activateBreakGlass(item.id, {
                          expectedRevision: item.revision,
                          idempotencyKey: crypto.randomUUID(),
                        }),
                      setWorking,
                      setError,
                      setNotice,
                      load,
                      '临时授权已激活；到期后即使状态尚未刷新也会被动态拒绝。',
                    )
                  }
                >
                  MFA 后激活
                </button>
              ) : null}
              {item.effective ? (
                <button
                  className="button danger small"
                  type="button"
                  disabled={working}
                  onClick={() =>
                    void runMutation(
                      () =>
                        revokeMyBreakGlass(item.id, {
                          expectedRevision: item.revision,
                          idempotencyKey: crypto.randomUUID(),
                          reason: '申请人提前结束临时授权。',
                        }),
                      setWorking,
                      setError,
                      setNotice,
                      load,
                      '临时授权已撤销并进入复盘。',
                    )
                  }
                >
                  提前撤销
                </button>
              ) : null}
            </section>
          ))}
        </div>
      </article>
    </section>
  );
}

async function runMutation(
  operation: () => Promise<unknown>,
  setWorking: (value: boolean) => void,
  setError: (value: string | null) => void,
  setNotice: (value: string | null) => void,
  reload: () => Promise<void>,
  success: string,
): Promise<void> {
  setWorking(true);
  setError(null);
  try {
    await operation();
    setNotice(success);
    await reload();
  } catch (caught) {
    setError(messageFromError(caught));
  } finally {
    setWorking(false);
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value));
}

function scopeLabel(value: BreakGlassScope): string {
  return BREAK_GLASS_SCOPES.find((scope) => scope.value === value)?.label ?? value;
}
