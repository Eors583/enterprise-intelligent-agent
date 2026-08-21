import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../config/environment.js';

export interface RuntimeRouteReadinessEvidence {
  readonly routeKey: string;
  readonly catalogVersionId: string;
  readonly provider: 'OPENAI_COMPATIBLE' | 'MANUS';
  readonly model: string;
  readonly configurationSha256: string;
}

export interface RuntimeModelRoutingReadiness {
  readonly status: 'READY' | 'NOT_READY' | 'UNAVAILABLE';
  readonly requireTrustedRoute: boolean | null;
  readonly providerReady: boolean | null;
  readonly checkedAt: Date | null;
  readonly routes: readonly RuntimeRouteReadinessEvidence[];
}

@Injectable()
export class ModelRoutingRuntimeReadinessClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly serviceToken: string | undefined;

  constructor(@Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>) {
    this.baseUrl = config.get('AI_RUNTIME_URL', { infer: true });
    this.timeoutMs = Math.min(config.get('AI_RUNTIME_HTTP_TIMEOUT_MS', { infer: true }), 3_000);
    this.serviceToken = config.get('AI_RUNTIME_SERVICE_TOKEN', { infer: true });
  }

  async inspect(): Promise<RuntimeModelRoutingReadiness> {
    try {
      const headers = new Headers({
        Accept: 'application/json',
        'Cache-Control': 'no-store',
      });
      if (this.serviceToken !== undefined) {
        headers.set('Authorization', `Bearer ${this.serviceToken}`);
      }
      const response = await fetch(new URL('/internal/v1/model-routing/readiness', this.baseUrl), {
        method: 'GET',
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return unavailable();
      return parseRuntimeReadiness(await response.json());
    } catch {
      return unavailable();
    }
  }
}

function parseRuntimeReadiness(value: unknown): RuntimeModelRoutingReadiness {
  if (!isRecord(value)) return unavailable();
  if (value.status !== 'ready' && value.status !== 'not_ready') return unavailable();
  if (typeof value.require_trusted_route !== 'boolean') return unavailable();
  if (typeof value.provider_ready !== 'boolean') return unavailable();
  if (value.evidence !== 'local_configuration_probe') return unavailable();
  if (value.external_connectivity_verified !== false) return unavailable();
  if (typeof value.checked_at !== 'string' || !Array.isArray(value.routes)) return unavailable();
  const checkedAt = new Date(value.checked_at);
  if (Number.isNaN(checkedAt.getTime()) || Math.abs(Date.now() - checkedAt.getTime()) > 60_000) {
    return unavailable();
  }
  const routes: RuntimeRouteReadinessEvidence[] = [];
  for (const route of value.routes) {
    if (!isRecord(route)) return unavailable();
    if (
      typeof route.route_key !== 'string' ||
      !/^[A-Z0-9][A-Z0-9._-]{0,119}$/u.test(route.route_key) ||
      typeof route.catalog_version_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        route.catalog_version_id,
      ) ||
      (route.provider !== 'OPENAI_COMPATIBLE' && route.provider !== 'MANUS') ||
      typeof route.model !== 'string' ||
      route.model.length < 1 ||
      route.model.length > 256 ||
      typeof route.configuration_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(route.configuration_sha256)
    ) {
      return unavailable();
    }
    routes.push({
      routeKey: route.route_key,
      catalogVersionId: route.catalog_version_id,
      provider: route.provider,
      model: route.model,
      configurationSha256: route.configuration_sha256,
    });
  }
  return {
    status: value.status === 'ready' ? 'READY' : 'NOT_READY',
    requireTrustedRoute: value.require_trusted_route,
    providerReady: value.provider_ready,
    checkedAt,
    routes,
  };
}

function unavailable(): RuntimeModelRoutingReadiness {
  return {
    status: 'UNAVAILABLE',
    requireTrustedRoute: null,
    providerReady: null,
    checkedAt: null,
    routes: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
