import { isIP } from 'node:net';

export type ToolOutboundUrlDecision =
  | {
      readonly allowed: true;
      readonly normalizedUrl: string;
      readonly hostname: string;
      readonly obligation: 'RESOLVE_AND_PIN_PUBLIC_IP';
    }
  | {
      readonly allowed: false;
      readonly reasonCode:
        | 'HOST_NOT_ALLOWED'
        | 'INVALID_ALLOWLIST'
        | 'INVALID_URL'
        | 'IP_LITERAL_FORBIDDEN'
        | 'PRIVATE_HOST_FORBIDDEN'
        | 'TLS_REQUIRED'
        | 'UNSAFE_PORT'
        | 'USERINFO_FORBIDDEN';
    };

export type ToolResolvedOutboundTargetDecision =
  | {
      readonly allowed: true;
      readonly normalizedUrl: string;
      readonly hostname: string;
      readonly pinnedAddresses: readonly string[];
      readonly obligations: readonly [
        'CONNECT_TO_PINNED_IP_WITH_TLS_SERVER_NAME',
        'REVALIDATE_EVERY_REDIRECT',
      ];
    }
  | {
      readonly allowed: false;
      readonly reasonCode:
        | 'DNS_PROOF_INVALID'
        | 'DNS_RESOLUTION_REQUIRED'
        | 'NON_PUBLIC_ADDRESS'
        | 'URL_DECISION_REQUIRED';
    };

export interface TrustedToolDnsResolution {
  readonly hostname: string;
  readonly addresses: readonly string[];
  readonly resolvedAt: Date | string;
  readonly expiresAt: Date | string;
}

export function decideToolOutboundUrl(
  rawUrl: string,
  allowedHostPatterns: readonly string[],
): ToolOutboundUrlDecision {
  const patterns = allowedHostPatterns.map(normalizePattern);
  if (
    patterns.length === 0 ||
    patterns.some((pattern) => pattern === null) ||
    new Set(patterns).size !== patterns.length
  ) {
    return { allowed: false, reasonCode: 'INVALID_ALLOWLIST' };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reasonCode: 'INVALID_URL' };
  }
  if (url.protocol !== 'https:') return { allowed: false, reasonCode: 'TLS_REQUIRED' };
  if (url.username.length > 0 || url.password.length > 0) {
    return { allowed: false, reasonCode: 'USERINFO_FORBIDDEN' };
  }
  if (url.port !== '' && url.port !== '443') {
    return { allowed: false, reasonCode: 'UNSAFE_PORT' };
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (isIP(hostname) !== 0) return { allowed: false, reasonCode: 'IP_LITERAL_FORBIDDEN' };
  if (
    hostname === 'localhost' ||
    !hostname.includes('.') ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    return { allowed: false, reasonCode: 'PRIVATE_HOST_FORBIDDEN' };
  }
  if (!patterns.some((pattern) => hostMatches(hostname, pattern!))) {
    return { allowed: false, reasonCode: 'HOST_NOT_ALLOWED' };
  }
  url.hostname = hostname;
  url.hash = '';
  return {
    allowed: true,
    normalizedUrl: url.toString(),
    hostname,
    obligation: 'RESOLVE_AND_PIN_PUBLIC_IP',
  };
}

/**
 * Second SSRF gate. The gateway must resolve through its trusted resolver,
 * validate every answer, then connect directly to one returned address while
 * retaining the original hostname for TLS SNI and certificate validation.
 */
export function decideResolvedToolOutboundTarget(
  urlDecision: ToolOutboundUrlDecision,
  resolution: TrustedToolDnsResolution | null,
  now: Date,
): ToolResolvedOutboundTargetDecision {
  if (!urlDecision.allowed) {
    return { allowed: false, reasonCode: 'URL_DECISION_REQUIRED' };
  }
  if (resolution === null || resolution.addresses.length === 0) {
    return { allowed: false, reasonCode: 'DNS_RESOLUTION_REQUIRED' };
  }
  const resolvedAt = timestamp(resolution.resolvedAt);
  const expiresAt = timestamp(resolution.expiresAt);
  if (
    !Number.isFinite(now.getTime()) ||
    resolution.hostname.toLowerCase().replace(/\.$/u, '') !== urlDecision.hostname ||
    resolvedAt === null ||
    expiresAt === null ||
    resolvedAt > now.getTime() ||
    expiresAt <= now.getTime() ||
    expiresAt <= resolvedAt ||
    resolution.addresses.some((address) => isIP(address) === 0)
  ) {
    return { allowed: false, reasonCode: 'DNS_PROOF_INVALID' };
  }
  if (resolution.addresses.some((address) => !isPublicAddress(address))) {
    return { allowed: false, reasonCode: 'NON_PUBLIC_ADDRESS' };
  }
  return {
    allowed: true,
    normalizedUrl: urlDecision.normalizedUrl,
    hostname: urlDecision.hostname,
    pinnedAddresses: [
      ...new Set(resolution.addresses.map((address) => address.toLowerCase())),
    ].sort(),
    obligations: ['CONNECT_TO_PINNED_IP_WITH_TLS_SERVER_NAME', 'REVALIDATE_EVERY_REDIRECT'],
  };
}

function normalizePattern(pattern: string): string | null {
  const normalized = pattern.trim().toLowerCase().replace(/\.$/u, '');
  const hostname = normalized.startsWith('*.') ? normalized.slice(2) : normalized;
  if (
    hostname.length === 0 ||
    !hostname.includes('.') ||
    isIP(hostname) !== 0 ||
    !/^[a-z0-9.-]+$/u.test(hostname) ||
    hostname.includes('..') ||
    hostname.startsWith('.') ||
    hostname.endsWith('.')
  ) {
    return null;
  }
  return normalized;
}

function hostMatches(hostname: string, pattern: string): boolean {
  return pattern.startsWith('*.')
    ? hostname.endsWith(`.${pattern.slice(2)}`) && hostname !== pattern.slice(2)
    : hostname === pattern;
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [first = -1, second = -1, third = -1] = octets;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function isPublicIpv6(address: string): boolean {
  let canonical: string;
  try {
    canonical = new URL(`https://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return false;
  }
  const firstText = canonical.split(':')[0];
  const first = firstText === undefined ? Number.NaN : Number.parseInt(firstText || '0', 16);
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return false;
  return !(
    canonical.startsWith('2001:db8:') ||
    canonical.startsWith('2001:2:') ||
    canonical.startsWith('2001:10:') ||
    canonical.startsWith('2001:20:') ||
    canonical.startsWith('3fff:')
  );
}

function timestamp(value: Date | string): number | null {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
