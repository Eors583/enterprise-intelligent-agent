import { UnprocessableEntityException } from '@nestjs/common';

import {
  decideResolvedToolOutboundTarget,
  decideToolOutboundUrl,
} from './domain/tool-outbound-url.policy.js';
import type {
  PreparedHttpTarget,
  ToolDnsResolverPort,
  ToolEndpointResolverPort,
} from './tool-execution.port.js';

/**
 * Performs the two independent SSRF gates. Redirects must call this method
 * again with the redirect URL; a previously pinned target is never reused.
 */
export async function preparePinnedHttpTarget(
  endpointRef: string,
  allowedHostPatterns: readonly string[],
  endpointResolver: ToolEndpointResolverPort,
  dnsResolver: ToolDnsResolverPort,
  now?: Date,
): Promise<PreparedHttpTarget> {
  const endpoint = await endpointResolver.resolve(endpointRef);
  const urlDecision = decideToolOutboundUrl(endpoint.url, allowedHostPatterns);
  if (!urlDecision.allowed) {
    throw new UnprocessableEntityException({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'Tool endpoint failed the outbound URL policy.',
      reasonCode: urlDecision.reasonCode,
    });
  }
  const resolution = await dnsResolver.resolve(urlDecision.hostname);
  // The resolver records resolvedAt after the asynchronous DNS call starts.
  // Capture validation time afterwards unless a deterministic test clock was
  // supplied, otherwise every live proof can appear to come from the future.
  const targetDecision = decideResolvedToolOutboundTarget(
    urlDecision,
    resolution,
    now ?? new Date(),
  );
  if (!targetDecision.allowed) {
    throw new UnprocessableEntityException({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'Tool endpoint failed trusted DNS/IP validation.',
      reasonCode: targetDecision.reasonCode,
    });
  }
  const pinnedIpAddress = targetDecision.pinnedAddresses[0];
  if (pinnedIpAddress === undefined) {
    throw new UnprocessableEntityException('Trusted DNS returned no public address.');
  }
  return {
    endpoint,
    target: {
      normalizedUrl: targetDecision.normalizedUrl,
      hostname: targetDecision.hostname,
      tlsServerName: targetDecision.hostname,
      pinnedIpAddress,
      resolution,
    },
  };
}
