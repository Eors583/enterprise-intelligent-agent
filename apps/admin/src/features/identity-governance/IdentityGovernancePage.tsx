import type {
  BreakGlassRequest,
  IdentityPolicy,
  IdentityProvider,
  OidcProviderInput,
} from '@enterprise/contracts';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { messageFromError } from '@/api/client';
import { TagInput } from '@/components/EntityPicker';
import { EmptyState, ErrorState, LoadingPanel, Notice, StatusPill } from '@/components/ui';
import {
  closeBreakGlassReview,
  decideBreakGlass,
  getIdentityPolicy,
  listAdminBreakGlass,
  listIdentityProviders,
  revokeAdminBreakGlass,
  saveIdentityPolicy,
  saveOidcProvider,
  transitionIdentityProvider,
  verifyOidcProvider,
} from './api';
import { ScimGovernancePanel } from './ScimGovernancePanel';

export function IdentityGovernancePage({ currentUserId }: { currentUserId: string }): ReactNode {
  const [providers, setProviders] = useState<IdentityProvider[] | null>(null);
  const [policy, setPolicy] = useState<IdentityPolicy | null>(null);
  const [requests, setRequests] = useState<BreakGlassRequest[] | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [providerDisplayName, setProviderDisplayName] = useState('');
  const [oidcScopes, setOidcScopes] = useState<string[]>(['openid', 'profile', 'email']);
  const [allowedEmailDomains, setAllowedEmailDomains] = useState<string[]>([]);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const [providerResult, policyResult, requestResult] = await Promise.all([
        listIdentityProviders(),
        getIdentityPolicy(),
        listAdminBreakGlass(),
      ]);
      setProviders(providerResult.items);
      setPolicy(policyResult);
      setRequests(requestResult.items);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveProvider = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const key = providerKey(providerDisplayName);
    const current = providers?.find((provider) => provider.key === key);
    const secret = String(form.get('clientSecret') ?? '');
    const input: OidcProviderInput = {
      key,
      displayName: providerDisplayName,
      issuer: String(form.get('issuer') ?? ''),
      discoveryUrl: String(form.get('discoveryUrl') ?? ''),
      clientId: String(form.get('clientId') ?? ''),
      ...(secret === '' ? {} : { clientSecret: secret }),
      scopes: oidcScopes,
      jitMode: String(form.get('jitMode') ?? 'EXISTING_USERS_ONLY') as OidcProviderInput['jitMode'],
      allowVerifiedEmailLinking: form.get('allowVerifiedEmailLinking') === 'on',
      allowedEmailDomains: allowedEmailDomains.map((domain) => domain.toLowerCase()),
      clockSkewSeconds: 60,
      expectedRevision: current?.revision ?? 0,
      idempotencyKey: crypto.randomUUID(),
    };
    await run(
      () => saveOidcProvider(input),
      'OIDC 配置已保存为草稿；发布前必须完成实时发现/JWKS 验证和异人审批。',
    );
    event.currentTarget.reset();
    setProviderDisplayName('');
    setOidcScopes(['openid', 'profile', 'email']);
    setAllowedEmailDomains([]);
  };

  const savePolicy = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(
      () =>
        saveIdentityPolicy({
          mfaRequirement: String(form.get('mfaRequirement')) as 'OPTIONAL' | 'ADMINS' | 'ALL_USERS',
          requireRecentMfaForAdmin: form.get('requireRecentMfaForAdmin') === 'on',
          recentMfaMaxAgeSeconds: Number(form.get('recentMfaMaxAgeSeconds')),
          totpAllowedDriftSteps: Number(form.get('totpAllowedDriftSteps')),
          totpMaxAttempts: Number(form.get('totpMaxAttempts')),
          totpAttemptWindowSeconds: Number(form.get('totpAttemptWindowSeconds')),
          allowLocalPasswordFallback: form.get('allowLocalPasswordFallback') === 'on',
          expectedRevision: policy?.revision ?? 0,
          idempotencyKey: crypto.randomUUID(),
        }),
      '身份策略草稿已保存。',
    );
  };

  const providerAction = async (
    provider: IdentityProvider,
    action: 'verify' | 'submit' | 'publish' | 'retire',
  ): Promise<void> => {
    await run(
      () =>
        action === 'verify'
          ? verifyOidcProvider(provider.id)
          : transitionIdentityProvider(provider.id, action, {
              expectedRevision: provider.revision,
              idempotencyKey: crypto.randomUUID(),
            }),
      {
        verify: 'OIDC 实时发现与 JWKS 验证已完成。',
        submit: 'OIDC 配置已提交独立复核。',
        publish: 'OIDC 配置已由独立复核人发布。',
        retire: '身份提供方已退役。',
      }[action],
    );
  };

  const decide = async (
    request: BreakGlassRequest,
    action: 'approve' | 'reject',
  ): Promise<void> => {
    const comment = window.prompt(
      action === 'approve'
        ? '填写独立审批依据（至少 10 个字符）：'
        : '填写拒绝原因（至少 10 个字符）：',
    );
    if (!comment) return;
    await run(
      () =>
        decideBreakGlass(request.id, action, {
          expectedRevision: request.revision,
          idempotencyKey: crypto.randomUUID(),
          comment,
        }),
      action === 'approve' ? '申请已批准；仍需申请人本人通过 MFA 激活。' : '申请已拒绝，不能激活。',
    );
  };

  const reviewClose = async (request: BreakGlassRequest): Promise<void> => {
    const summary = window.prompt('填写使用情况、异常与后续行动复盘（至少 20 个字符）：');
    if (!summary) return;
    await run(
      () =>
        closeBreakGlassReview(request.id, {
          expectedRevision: request.revision,
          idempotencyKey: crypto.randomUUID(),
          outcome: 'NO_ISSUE',
          summary,
        }),
      '临时授权复盘已关闭，完整事件与审计记录保留。',
    );
  };

  const run = async (operation: () => Promise<unknown>, success: string): Promise<void> => {
    setWorking(true);
    setError(null);
    try {
      await operation();
      setNotice(success);
      await load();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setWorking(false);
    }
  };

  if (providers === null || requests === null) {
    return error ? (
      <ErrorState message={error} onRetry={() => void load()} />
    ) : (
      <LoadingPanel label="正在读取企业身份治理配置…" />
    );
  }

  return (
    <section className="page identity-governance-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">ENTERPRISE IDENTITY GOVERNANCE</p>
          <h1>企业身份治理</h1>
          <p>管理 MFA 策略、OIDC 联邦登录和双人审批的短期紧急授权。</p>
        </div>
        <button className="button secondary" type="button" onClick={() => void load()}>
          刷新
        </button>
      </header>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      <Notice tone="info">
        敏感治理动作要求最近 MFA。请先在“我的身份安全”完成二次验证。SAML 尚无真实 XML
        签名验证器，因此后端与界面均保持 fail-closed，不提供启用入口。
      </Notice>

      <div className="content-grid two">
        <article className="card">
          <header className="card-header">
            <div>
              <h2>身份策略</h2>
              <p>选择强制 MFA 范围，并限制敏感操作的验证有效期。</p>
            </div>
            {policy ? <StatusPill value={policy.publicationStatus} /> : null}
          </header>
          <form className="form-stack" onSubmit={(event) => void savePolicy(event)}>
            <label>
              <span>MFA 要求</span>
              <select name="mfaRequirement" defaultValue={policy?.mfaRequirement ?? 'OPTIONAL'}>
                <option value="OPTIONAL">可选</option>
                <option value="ADMINS">所有者与管理员必须</option>
                <option value="ALL_USERS">所有用户必须</option>
              </select>
            </label>
            <label>
              <span>敏感操作 MFA 有效期（秒）</span>
              <input
                name="recentMfaMaxAgeSeconds"
                type="number"
                min={60}
                max={3600}
                defaultValue={policy?.recentMfaMaxAgeSeconds ?? 300}
              />
            </label>
            <div className="form-grid two">
              <label>
                <span>TOTP 漂移步数</span>
                <input
                  name="totpAllowedDriftSteps"
                  type="number"
                  min={0}
                  max={1}
                  defaultValue={policy?.totpAllowedDriftSteps ?? 1}
                />
              </label>
              <label>
                <span>最大尝试次数</span>
                <input
                  name="totpMaxAttempts"
                  type="number"
                  min={3}
                  max={20}
                  defaultValue={policy?.totpMaxAttempts ?? 5}
                />
              </label>
            </div>
            <input
              name="totpAttemptWindowSeconds"
              type="hidden"
              value={policy?.totpAttemptWindowSeconds ?? 300}
            />
            <label className="checkbox-row">
              <input
                name="requireRecentMfaForAdmin"
                type="checkbox"
                defaultChecked={policy?.requireRecentMfaForAdmin ?? true}
              />
              <span>治理操作要求最近 MFA</span>
            </label>
            <label className="checkbox-row">
              <input
                name="allowLocalPasswordFallback"
                type="checkbox"
                defaultChecked={policy?.allowLocalPasswordFallback ?? true}
              />
              <span>保留本地密码回退</span>
            </label>
            <button className="button primary" type="submit" disabled={working}>
              保存策略草稿
            </button>
          </form>
        </article>

        <article className="card">
          <header className="card-header">
            <div>
              <h2>OIDC 提供方</h2>
              <p>保存即在线拉取 discovery；发布前再次验证 discovery 与 JWKS 哈希。</p>
            </div>
          </header>
          <form className="form-stack" onSubmit={(event) => void saveProvider(event)}>
            <div className="form-grid two">
              <label>
                <span>显示名称</span>
                <input
                  name="displayName"
                  required
                  value={providerDisplayName}
                  onChange={(event) => setProviderDisplayName(event.target.value)}
                />
              </label>
            </div>
            <label>
              <span>Issuer</span>
              <input name="issuer" type="url" required />
            </label>
            <label>
              <span>Discovery URL</span>
              <input name="discoveryUrl" type="url" required />
            </label>
            <label>
              <span>Client ID</span>
              <input name="clientId" required />
            </label>
            <label>
              <span>Client secret（更新时留空表示保留）</span>
              <input name="clientSecret" type="password" autoComplete="new-password" />
            </label>
            <fieldset>
              <legend>登录授权范围</legend>
              {(
                [
                  ['openid', '基础身份（必选）'],
                  ['profile', '姓名和头像'],
                  ['email', '邮箱'],
                  ['groups', '用户组'],
                ] as const
              ).map(([value, label]) => (
                <label className="checkbox-row" key={value}>
                  <input
                    type="checkbox"
                    checked={oidcScopes.includes(value)}
                    disabled={value === 'openid'}
                    onChange={(event) =>
                      setOidcScopes((current) =>
                        event.target.checked
                          ? [...new Set([...current, value])]
                          : current.filter((scope) => scope !== value),
                      )
                    }
                  />
                  <span>{label}</span>
                </label>
              ))}
            </fieldset>
            <label>
              <span>JIT</span>
              <select name="jitMode" defaultValue="EXISTING_USERS_ONLY">
                <option value="DISABLED">禁用</option>
                <option value="EXISTING_USERS_ONLY">仅已有用户</option>
                <option value="CREATE_USERS">创建用户</option>
              </select>
            </label>
            <label>
              <span>允许登录的邮箱域</span>
              <TagInput
                value={allowedEmailDomains}
                onChange={setAllowedEmailDomains}
                ariaLabel="允许登录的邮箱域"
                placeholder="输入域名后按回车，例如 example.com"
              />
            </label>
            <label className="checkbox-row">
              <input name="allowVerifiedEmailLinking" type="checkbox" />
              <span>允许绑定 IdP 已验证邮箱</span>
            </label>
            <button className="button primary" type="submit" disabled={working}>
              保存 OIDC 草稿
            </button>
          </form>
        </article>
      </div>

      <article className="card">
        <header className="card-header">
          <div>
            <h2>提供方发布状态</h2>
            <p>配置者不能批准自己提交的版本。</p>
          </div>
        </header>
        {providers.length === 0 ? (
          <EmptyState title="尚未配置 OIDC" description="先保存一个真实 OIDC 提供方草稿。" />
        ) : (
          <div className="card-grid">
            {providers.map((provider) => (
              <section className="subcard" key={provider.id}>
                <div className="subcard-title">
                  <strong>{provider.displayName}</strong>
                  <StatusPill value={provider.publicationStatus} />
                  <StatusPill value={provider.verificationStatus} />
                </div>
                <p>{provider.oidc?.issuer ?? 'OIDC 元数据不完整'}</p>
                <div className="button-row">
                  <button
                    className="button secondary small"
                    type="button"
                    disabled={working}
                    onClick={() => void providerAction(provider, 'verify')}
                  >
                    实时验证
                  </button>
                  {provider.publicationStatus === 'DRAFT' ? (
                    <button
                      className="button secondary small"
                      type="button"
                      disabled={working}
                      onClick={() => void providerAction(provider, 'submit')}
                    >
                      提交复核
                    </button>
                  ) : null}
                  {provider.publicationStatus === 'IN_REVIEW' ? (
                    <button
                      className="button primary small"
                      type="button"
                      disabled={
                        working ||
                        provider.proposedByUserId === currentUserId ||
                        provider.verificationStatus !== 'VERIFIED'
                      }
                      onClick={() => void providerAction(provider, 'publish')}
                    >
                      独立审批并发布
                    </button>
                  ) : null}
                  {provider.publicationStatus === 'PUBLISHED' ? (
                    <button
                      className="button danger small"
                      type="button"
                      disabled={working}
                      onClick={() => void providerAction(provider, 'retire')}
                    >
                      退役
                    </button>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        )}
      </article>

      <ScimGovernancePanel currentUserId={currentUserId} />

      <article className="card">
        <header className="card-header">
          <div>
            <h2>临时授权审批与复盘</h2>
            <p>申请人不能审批或关闭自己的复盘；过期由授权点动态判定。</p>
          </div>
        </header>
        <div className="card-grid">
          {requests.map((request) => (
            <section className="subcard" key={request.id}>
              <div className="subcard-title">
                <StatusPill value={request.status} />
                <strong>{request.scopes.join(' · ')}</strong>
              </div>
              <p>{request.reason}</p>
              <p>
                申请人 {request.requesterUserId} ·{' '}
                {Math.round(request.requestedDurationSeconds / 60)} 分钟
              </p>
              {request.status === 'PENDING_APPROVAL' ? (
                <div className="button-row">
                  <button
                    className="button primary small"
                    type="button"
                    disabled={working || request.requesterUserId === currentUserId}
                    onClick={() => void decide(request, 'approve')}
                  >
                    异人审批
                  </button>
                  <button
                    className="button danger small"
                    type="button"
                    disabled={working || request.requesterUserId === currentUserId}
                    onClick={() => void decide(request, 'reject')}
                  >
                    拒绝
                  </button>
                </div>
              ) : null}
              {request.effective ? (
                <button
                  className="button danger small"
                  type="button"
                  disabled={working}
                  onClick={() =>
                    void run(
                      () =>
                        revokeAdminBreakGlass(request.id, {
                          expectedRevision: request.revision,
                          idempotencyKey: crypto.randomUUID(),
                          reason: '管理员提前终止临时授权。',
                        }),
                      '临时授权已撤销并进入复盘。',
                    )
                  }
                >
                  立即撤销
                </button>
              ) : null}
              {request.status === 'REVIEW_PENDING' ? (
                <button
                  className="button primary small"
                  type="button"
                  disabled={working || request.requesterUserId === currentUserId}
                  onClick={() => void reviewClose(request)}
                >
                  独立复盘并关闭
                </button>
              ) : null}
            </section>
          ))}
        </div>
      </article>
    </section>
  );
}

function providerKey(displayName: string): string {
  const slug = displayName
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 40);
  return slug || `identity-${crypto.randomUUID().slice(0, 8)}`;
}
