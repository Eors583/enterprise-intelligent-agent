import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables, ToolEndpointBinding } from '../../../../config/environment.js';
import { ToolEndpointResolverPort, type ResolvedToolEndpoint } from '../../tool-execution.port.js';

@Injectable()
export class ConfigToolEndpointResolver extends ToolEndpointResolverPort {
  private readonly bindings: Readonly<Record<string, ToolEndpointBinding>>;

  constructor(@Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>) {
    super();
    this.bindings = config.get('TOOL_ENDPOINT_BINDINGS', { infer: true });
  }

  resolve(endpointRef: string): Promise<ResolvedToolEndpoint> {
    const binding = this.bindings[endpointRef];
    if (binding === undefined) {
      throw new ToolEndpointResolutionError(
        'TOOL_ENDPOINT_BINDING_NOT_FOUND',
        'No server-side endpoint binding exists for the immutable Tool Version.',
      );
    }
    return Promise.resolve({
      url: binding.url,
      method: binding.method,
      headers: binding.headers,
      signingSecret: binding.signingSecret,
    });
  }
}

export class ToolEndpointResolutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolEndpointResolutionError';
  }
}
