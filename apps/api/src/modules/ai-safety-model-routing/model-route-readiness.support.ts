import { createHash } from 'node:crypto';

export interface ModelRouteConfigurationIdentity {
  readonly id: string;
  readonly routeKey: string;
  readonly provider: string;
  readonly modelName: string;
  readonly credentialReference: string;
}

/**
 * This digest is the API/Runtime trust boundary. Keep it independent from a
 * database-generated configuration hash so a Runtime allowlist cannot be
 * satisfied by a stale or differently-addressed catalog row.
 */
export function modelRouteConfigurationSha256(catalog: ModelRouteConfigurationIdentity): string {
  return createHash('sha256')
    .update(
      [
        catalog.routeKey,
        catalog.id,
        catalog.provider,
        catalog.modelName,
        catalog.credentialReference,
      ].join('\0'),
      'utf8',
    )
    .digest('hex');
}
