import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ImRealtimeSession } from '@enterprise/contracts';
import { createHmac } from 'node:crypto';

import type { EnvironmentVariables } from '../../../config/environment.js';
import { AuthorizationService } from '../../authorization/authorization.service.js';
import { IdentityService } from '../../identity/application/identity.service.js';
import { mapWuKongAccountId } from '../infrastructure/wukong/index.js';

const MAX_PROVISION_RESPONSE_BYTES = 8 * 1_024;

@Injectable()
export class ImRealtimeSessionService {
  constructor(
    @Inject(ConfigService)
    private readonly config: ConfigService<EnvironmentVariables, true>,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  async create(): Promise<ImRealtimeSession> {
    const { tenant, user } = await this.identity.getCurrentIdentity();
    this.authorization.requireCurrent({
      action: 'conversation.realtime.connect',
      resourceTenantId: tenant.id,
      risk: 'MEDIUM',
    });

    const provider = this.config.get('IM_PROVIDER', { infer: true });
    if (provider === 'local') {
      return { available: false, provider, reason: 'REALTIME_NOT_CONFIGURED' };
    }
    if (provider === 'tencent') {
      return {
        available: false,
        provider,
        reason: 'PROVIDER_HAS_NO_SELF_HOSTED_REALTIME_BRIDGE',
      };
    }

    const uid = mapWuKongAccountId(tenant.id, { type: 'user', id: user.id });
    const signingSecret = this.config.get('WUKONG_IM_TOKEN_SIGNING_SECRET', { infer: true });
    if (signingSecret === undefined) {
      throw new ServiceUnavailableException('WuKongIM realtime credentials are not configured.');
    }
    const token = createHmac('sha256', signingSecret)
      .update('enterprise-im/wukong/session/v1\0', 'utf8')
      .update(tenant.id, 'utf8')
      .update('\0', 'utf8')
      .update(user.id, 'utf8')
      .digest('base64url');

    await this.provision(uid, token);
    return {
      available: true,
      provider: 'wukong',
      websocketUrl: this.config.get('WUKONG_IM_PUBLIC_WS_URL', { infer: true }),
      uid,
      token,
      deviceFlag: 2,
    };
  }

  private async provision(uid: string, token: string): Promise<void> {
    const endpoint = new URL(
      '/user/token',
      this.config.get('WUKONG_IM_API_BASE_URL', { infer: true }),
    );
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('WuKongIM provisioning timed out.')),
      this.config.get('WUKONG_IM_HTTP_TIMEOUT_MS', { infer: true }),
    );
    timeout.unref();
    try {
      const apiToken = this.config.get('WUKONG_IM_API_TOKEN', { infer: true });
      const response = await fetch(endpoint, {
        method: 'POST',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(apiToken === undefined ? {} : { token: apiToken }),
        },
        body: JSON.stringify({ uid, token, device_flag: 2, device_level: 1 }),
      });
      const body = await readBoundedJson(response, MAX_PROVISION_RESPONSE_BYTES);
      if (!response.ok || !isRecord(body) || (body.status !== 200 && body.status !== undefined)) {
        throw new Error(`WuKongIM provisioning returned HTTP ${response.status}.`);
      }
    } catch (error) {
      throw new ServiceUnavailableException({
        code: 'WUKONG_IM_SESSION_UNAVAILABLE',
        message: 'Realtime messaging is temporarily unavailable. Existing messages remain safe.',
        cause:
          error instanceof DOMException && error.name === 'AbortError' ? 'TIMEOUT' : 'UPSTREAM',
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error('WuKongIM provisioning response exceeded the safety limit.');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maximumBytes) {
    throw new Error('WuKongIM provisioning response exceeded the safety limit.');
  }
  return text.length === 0 ? {} : (JSON.parse(text) as unknown);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
