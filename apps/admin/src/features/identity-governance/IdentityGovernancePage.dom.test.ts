import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';
import * as identityApi from './api';
import { IdentityGovernancePage } from './IdentityGovernancePage';
import { IdentitySecurityPage } from './IdentitySecurityPage';
import { ScimGovernancePanel } from './ScimGovernancePanel';

const CURRENT_USER_ID = '10000000-0000-7000-8000-000000000001';

vi.mock('./api', () => ({
  listIdentityProviders: vi.fn().mockResolvedValue({
    items: [
      {
        id: '20000000-0000-7000-8000-000000000001',
        key: 'work-sso',
        displayName: 'Work SSO',
        protocol: 'OIDC',
        verificationStatus: 'VERIFIED',
        publicationStatus: 'IN_REVIEW',
        verificationErrorCode: null,
        verifiedAt: '2031-01-01T00:00:00.000Z',
        jitMode: 'EXISTING_USERS_ONLY',
        allowVerifiedEmailLinking: false,
        allowedEmailDomains: [],
        revision: 2,
        proposedByUserId: '10000000-0000-7000-8000-000000000001',
        approvedByUserId: null,
        approvedAt: null,
        secretConfigured: true,
        oidc: {
          issuer: 'https://idp.example.test',
          discoveryUrl: 'https://idp.example.test/.well-known/openid-configuration',
          authorizationEndpoint: 'https://idp.example.test/authorize',
          tokenEndpoint: 'https://idp.example.test/token',
          jwksUri: 'https://idp.example.test/jwks',
          clientId: 'client',
          scopes: ['openid'],
          discoveredAt: '2031-01-01T00:00:00.000Z',
          clockSkewSeconds: 60,
        },
        samlFailClosed: true,
      },
    ],
  }),
  getIdentityPolicy: vi.fn().mockResolvedValue(null),
  listAdminBreakGlass: vi.fn().mockResolvedValue({
    items: [
      {
        id: '30000000-0000-7000-8000-000000000001',
        requesterUserId: '10000000-0000-7000-8000-000000000001',
        scopes: ['SESSION_REVOCATION'],
        reason: 'Production sessions require emergency revocation immediately.',
        requestedDurationSeconds: 300,
        status: 'PENDING_APPROVAL',
        approvedByUserId: null,
        approvalComment: null,
        approvedAt: null,
        rejectedByUserId: null,
        rejectionReason: null,
        rejectedAt: null,
        activatedAt: null,
        activeUntil: null,
        effective: false,
        terminationKind: null,
        terminatedAt: null,
        revokedByUserId: null,
        revocationReason: null,
        reviewedByUserId: null,
        reviewOutcome: null,
        reviewSummary: null,
        reviewedAt: null,
        closedAt: null,
        revision: 1,
        createdAt: '2031-01-01T00:00:00.000Z',
        updatedAt: '2031-01-01T00:00:00.000Z',
      },
    ],
  }),
  listScimConnectors: vi.fn().mockResolvedValue({
    items: [
      {
        id: '40000000-0000-7000-8000-000000000001',
        key: 'corporate-directory',
        displayName: 'Corporate directory',
        status: 'IN_REVIEW',
        basePath: '/api/v1/scim/v2/corporate-directory',
        allowUserCreate: true,
        allowGroupCreate: true,
        deactivateUserOnScimDisable: true,
        revision: 2,
        proposedByUserId: '10000000-0000-7000-8000-000000000001',
        approvedByUserId: null,
        approvedAt: null,
        createdAt: '2031-01-01T00:00:00.000Z',
        updatedAt: '2031-01-01T00:00:00.000Z',
      },
    ],
  }),
  listScimServiceTokens: vi.fn().mockResolvedValue({ items: [] }),
  createScimConnector: vi.fn(),
  updateScimConnector: vi.fn(),
  transitionScimConnector: vi.fn(),
  createScimServiceToken: vi.fn(),
  rotateScimServiceToken: vi.fn(),
  revokeScimServiceToken: vi.fn(),
  identitySecurityOverview: vi.fn().mockResolvedValue({
    mfa: { factors: [], recoveryCodesRemaining: 0, recentMfaAt: null },
    devices: [],
    sessions: [],
  }),
  listMyBreakGlass: vi.fn().mockResolvedValue({ items: [] }),
  saveIdentityPolicy: vi.fn(),
  saveOidcProvider: vi.fn(),
  transitionIdentityProvider: vi.fn(),
  verifyOidcProvider: vi.fn(),
  decideBreakGlass: vi.fn(),
  revokeAdminBreakGlass: vi.fn(),
  closeBreakGlassReview: vi.fn(),
  startMfaEnrollment: vi.fn(),
  verifyMfaEnrollment: vi.fn(),
  requestRecentMfa: vi.fn(),
  verifyRecentMfa: vi.fn(),
  revokeIdentityDevice: vi.fn(),
  revokeIdentitySession: vi.fn(),
  createBreakGlass: vi.fn(),
  activateBreakGlass: vi.fn(),
  revokeMyBreakGlass: vi.fn(),
}));

describe('identity governance surfaces', () => {
  it('makes SAML fail-closed and maker-checker boundaries explicit', async () => {
    const dom = await renderInTestDom(
      createElement(IdentityGovernancePage, { currentUserId: CURRENT_USER_ID }),
    );
    await dom.flush();
    await dom.flush();

    expect(dom.container.textContent).toContain('SAML 尚无真实 XML');
    expect(dom.container.textContent).toContain('fail-closed');
    expect(dom.container.textContent).toContain('SCIM 2.0 自动开户与离职回收');
    expect(dom.container.textContent).toContain('服务令牌仅保存哈希');
    expect(dom.container.textContent).toContain('只有 ACTIVE 连接器可以签发或轮换服务令牌');
    expect(dom.container.textContent).toContain('申请人不能审批或关闭自己的复盘');
    const publish = [...dom.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('独立审批并发布'),
    ) as HTMLButtonElement | undefined;
    const approve = [...dom.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('异人审批'),
    ) as HTMLButtonElement | undefined;
    const activateScim = [...dom.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('异人启用'),
    ) as HTMLButtonElement | undefined;
    expect(publish?.disabled).toBe(true);
    expect(approve?.disabled).toBe(true);
    expect(activateScim?.disabled).toBe(true);
    await dom.cleanup();
  });

  it('exposes employee MFA, session/device revocation, and break-glass request entry', async () => {
    const dom = await renderInTestDom(createElement(IdentitySecurityPage));
    await dom.flush();
    await dom.flush();

    expect(dom.container.textContent).toContain('我的身份安全');
    expect(dom.container.textContent).toContain('配置身份验证器');
    expect(dom.container.textContent).toContain('刷新令牌重放会撤销整个令牌族');
    expect(dom.container.textContent).toContain('临时授权（Break-glass）');
    expect(dom.container.textContent).toContain('最长 15 分钟');
    await dom.cleanup();
  });

  it('shows SCIM token plaintext exactly in the one-time issuance panel', async () => {
    vi.mocked(identityApi.listScimConnectors).mockResolvedValueOnce({
      items: [
        {
          id: '40000000-0000-7000-8000-000000000002',
          key: 'active-directory',
          displayName: 'Active directory',
          status: 'ACTIVE',
          basePath: '/api/v1/scim/v2/active-directory',
          allowUserCreate: true,
          allowGroupCreate: true,
          deactivateUserOnScimDisable: true,
          revision: 3,
          proposedByUserId: '10000000-0000-7000-8000-000000000002',
          approvedByUserId: CURRENT_USER_ID,
          approvedAt: '2031-01-01T00:00:00.000Z',
          createdAt: '2031-01-01T00:00:00.000Z',
          updatedAt: '2031-01-01T00:00:00.000Z',
        },
      ],
    });
    vi.mocked(identityApi.createScimServiceToken).mockResolvedValueOnce({
      id: '50000000-0000-7000-8000-000000000001',
      connectorId: '40000000-0000-7000-8000-000000000002',
      token: `ea_scim_${'x'.repeat(43)}`,
      tokenHint: 'xxxxxxxx',
      status: 'ACTIVE',
      scopes: ['scim.users.read', 'scim.users.write', 'scim.groups.read', 'scim.groups.write'],
      createdByUserId: CURRENT_USER_ID,
      expiresAt: '2031-04-01T00:00:00.000Z',
      lastUsedAt: null,
      revokedAt: null,
      revision: 1,
      createdAt: '2031-01-01T00:00:00.000Z',
    });
    const dom = await renderInTestDom(
      createElement(ScimGovernancePanel, { currentUserId: CURRENT_USER_ID }),
    );
    await dom.flush();
    await dom.flush();

    const issue = [...dom.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('签发一次性令牌'),
    ) as HTMLButtonElement | undefined;
    const issueForm = issue?.closest('form');
    expect(issueForm).toBeTruthy();
    await dom.submit(issueForm as HTMLFormElement);
    await dom.flush();
    await dom.flush();

    expect(dom.container.textContent).toContain('令牌明文只显示一次，请立即复制');
    const textarea = dom.container.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(`${textarea?.value ?? ''}${textarea?.textContent ?? ''}`).toContain(
      `ea_scim_${'x'.repeat(43)}`,
    );
    const close = [...dom.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('我已安全保存，关闭'),
    ) as HTMLButtonElement | undefined;
    expect(close).toBeTruthy();
    await dom.click(close as HTMLButtonElement);
    expect(dom.container.querySelector('textarea')).toBeNull();
    await dom.cleanup();
  });
});
