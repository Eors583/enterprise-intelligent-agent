import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { EnvironmentVariables } from '../../../../config/environment.js';
import { ToolDnsResolverPort, type TrustedDnsResolution } from '../../tool-execution.port.js';

interface AddressWithTtl {
  readonly address: string;
  readonly ttl: number;
}

@Injectable()
export class ConfiguredToolDnsResolver extends ToolDnsResolverPort {
  private readonly resolver: Resolver;
  private readonly resolverName: string;

  constructor(@Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>) {
    super();
    const servers = config.get('TOOL_DNS_SERVERS', { infer: true });
    this.resolver = new Resolver();
    this.resolver.setServers([...servers]);
    this.resolverName = `configured-recursive:${servers.length}`;
  }

  async resolve(hostname: string): Promise<TrustedDnsResolution> {
    const [ipv4, ipv6] = await Promise.all([
      this.resolver
        .resolve4(hostname, { ttl: true })
        .then((addresses) => addresses as AddressWithTtl[])
        .catch(() => []),
      this.resolver
        .resolve6(hostname, { ttl: true })
        .then((addresses) => addresses as AddressWithTtl[])
        .catch(() => []),
    ]);
    const answers = [...ipv4, ...ipv6].filter(
      (answer) => isIP(answer.address) !== 0 && Number.isInteger(answer.ttl) && answer.ttl > 0,
    );
    if (answers.length === 0) {
      throw new ToolDnsResolutionError(
        'TOOL_DNS_RESOLUTION_FAILED',
        'The configured recursive resolver returned no usable address.',
      );
    }
    const ttlSeconds = Math.max(1, Math.min(86_400, ...answers.map((answer) => answer.ttl)));
    const resolvedAt = new Date();
    return {
      hostname,
      addresses: [...new Set(answers.map((answer) => answer.address.toLowerCase()))].sort(),
      resolverName: this.resolverName,
      ttlSeconds,
      resolvedAt,
      expiresAt: new Date(resolvedAt.getTime() + ttlSeconds * 1_000),
    };
  }
}

export class ToolDnsResolutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolDnsResolutionError';
  }
}
