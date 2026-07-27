import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.js';

export type AuthRecoveryDeliveryStatus = 'NOT_CONFIGURED' | 'SENT' | 'FAILED';

@Injectable()
export class AuthRecoveryNotificationService {
  private readonly provider: 'disabled' | 'resend';
  private readonly apiKey: string | undefined;
  private readonly from: string | undefined;
  private readonly timeoutMs: number;
  private readonly publicAppUrl: string;

  constructor(
    @Inject(ConfigService)
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.provider = config.get('AUTH_RECOVERY_EMAIL_PROVIDER', { infer: true }) ?? 'disabled';
    this.apiKey = config.get('AUTH_RECOVERY_EMAIL_API_KEY', { infer: true });
    this.from = config.get('AUTH_RECOVERY_EMAIL_FROM', { infer: true });
    this.timeoutMs = config.get('AUTH_RECOVERY_EMAIL_HTTP_TIMEOUT_MS', { infer: true }) ?? 10_000;
    this.publicAppUrl =
      config.get('AUTH_PUBLIC_APP_URL', { infer: true }) ?? 'http://localhost:4173';
  }

  actionUrl(kind: 'reset-password' | 'accept-invitation', token: string): string {
    const url = new URL('/', this.publicAppUrl);
    const parameters = new URLSearchParams({ token });
    // The capability lives in the fragment, which browsers do not send in the
    // HTTP request, access log, or Referer header to the static application.
    url.hash = `/${kind}?${parameters.toString()}`;
    return url.toString();
  }

  sendPasswordReset(input: {
    readonly email: string;
    readonly displayName: string;
    readonly tenantName: string;
    readonly token: string;
  }): Promise<AuthRecoveryDeliveryStatus> {
    const actionUrl = this.actionUrl('reset-password', input.token);
    return this.send({
      to: input.email,
      subject: `${input.tenantName} 密码重置`,
      text: `${input.displayName}，请使用以下一次性链接重置密码。链接过期或使用后即失效：\n${actionUrl}`,
      html: `<p>${escapeHtml(input.displayName)}，请使用以下一次性链接重置密码。</p><p><a href="${escapeHtml(actionUrl)}">重置密码</a></p><p>链接过期或使用后即失效。</p>`,
    });
  }

  sendMemberInvitation(input: {
    readonly email: string;
    readonly displayName: string;
    readonly tenantName: string;
    readonly token: string;
  }): Promise<AuthRecoveryDeliveryStatus> {
    const actionUrl = this.actionUrl('accept-invitation', input.token);
    return this.send({
      to: input.email,
      subject: `加入 ${input.tenantName}`,
      text: `${input.displayName}，请使用以下一次性链接设置密码并加入企业。链接过期或使用后即失效：\n${actionUrl}`,
      html: `<p>${escapeHtml(input.displayName)}，请设置密码并加入 ${escapeHtml(input.tenantName)}。</p><p><a href="${escapeHtml(actionUrl)}">接受邀请</a></p><p>链接过期或使用后即失效。</p>`,
    });
  }

  private async send(input: {
    readonly to: string;
    readonly subject: string;
    readonly text: string;
    readonly html: string;
  }): Promise<AuthRecoveryDeliveryStatus> {
    if (this.provider === 'disabled' || this.apiKey === undefined || this.from === undefined) {
      return 'NOT_CONFIGURED';
    }

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [input.to],
          subject: input.subject,
          text: input.text,
          html: input.html,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return response.ok ? 'SENT' : 'FAILED';
    } catch {
      // Provider details and credential-bearing request data must not escape to
      // API responses, logs, audit metadata, or token rows.
      return 'FAILED';
    }
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
