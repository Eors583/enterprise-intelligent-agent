export interface ResolvedToolEndpoint {
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /**
   * Server-side credentials loaded from an opaque Secret/ConfigMap binding.
   * These values must never be persisted in Tool Versions, API responses,
   * receipts, logs, or audit metadata.
   */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Optional per-binding HMAC key used to sign the employee + Role Assignment
   * execution context for a downstream verifier.
   */
  readonly signingSecret: string | null;
}

export interface TrustedDnsResolution {
  readonly hostname: string;
  readonly addresses: readonly string[];
  readonly resolverName: string;
  readonly ttlSeconds: number;
  readonly resolvedAt: Date;
  readonly expiresAt: Date;
}

export interface PinnedHttpTarget {
  readonly normalizedUrl: string;
  readonly hostname: string;
  readonly tlsServerName: string;
  readonly pinnedIpAddress: string;
  readonly resolution: TrustedDnsResolution;
}

export interface ToolProviderRequest {
  readonly invocationId: string;
  readonly tenantId: string;
  readonly requesterUserId: string;
  readonly roleAssignmentId: string;
  readonly taskId: string;
  readonly correlationId: string;
  readonly providerRequestId: string;
  readonly endpoint: ResolvedToolEndpoint;
  readonly target: PinnedHttpTarget | null;
  readonly input: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
  readonly providerDryRun: boolean;
}

export interface ToolProviderResult {
  readonly providerRequestId: string;
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
  readonly startedAt: Date;
  readonly completedAt: Date;
  /**
   * Missing provider metering is not zero. A pinned HTTPS response may attest
   * an exact amount; otherwise FinOps must independently price the call from
   * an approved immutable catalog snapshot.
   */
  readonly cost:
    | { readonly kind: 'UNATTESTED' }
    | { readonly kind: 'PROVIDER_ATTESTED'; readonly costMicros: bigint };
}

/** Resolves an opaque endpoint reference through a trusted secret/config store. */
export abstract class ToolEndpointResolverPort {
  abstract resolve(endpointRef: string): Promise<ResolvedToolEndpoint>;
}

/** Uses only the platform-controlled recursive resolver; never OS/user supplied DNS. */
export abstract class ToolDnsResolverPort {
  abstract resolve(hostname: string): Promise<TrustedDnsResolution>;
}

/**
 * Dispatches to a provider while connecting to the pinned IP and preserving
 * the original hostname for TLS SNI and certificate verification.
 */
export abstract class ToolProviderDispatcherPort {
  abstract dispatch(request: ToolProviderRequest): Promise<ToolProviderResult>;
}

export interface PreparedHttpTarget {
  readonly endpoint: ResolvedToolEndpoint;
  readonly target: PinnedHttpTarget;
}
