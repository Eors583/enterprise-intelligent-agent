import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes } from 'node:crypto';

import type { EnvironmentVariables } from '../../../config/environment.js';

export interface OpaqueToken {
  readonly value: string;
  readonly hash: string;
}

export interface SessionTokenPair {
  readonly access: OpaqueToken;
  readonly refresh: OpaqueToken;
}

const OPAQUE_TOKEN_PATTERN = /^ea_(?:access|refresh)_[A-Za-z0-9_-]{43}$/;
const ACTION_TOKEN_PATTERNS = {
  reset: /^ea_reset_[A-Za-z0-9_-]{43}$/,
  invite: /^ea_invite_[A-Za-z0-9_-]{43}$/,
} as const;

@Injectable()
export class TokenService {
  private readonly pepper: string;

  constructor(@Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>) {
    this.pepper = config.get('AUTH_TOKEN_PEPPER', { infer: true });
  }

  issuePair(): SessionTokenPair {
    return {
      access: this.issue('access'),
      refresh: this.issue('refresh'),
    };
  }

  issueAction(kind: 'reset' | 'invite'): OpaqueToken {
    return this.issue(kind);
  }

  hash(value: string): string {
    return createHmac('sha256', this.pepper).update(value, 'utf8').digest('hex');
  }

  isWellFormed(value: string): boolean {
    return OPAQUE_TOKEN_PATTERN.test(value);
  }

  isActionWellFormed(value: string, kind: 'reset' | 'invite'): boolean {
    return ACTION_TOKEN_PATTERNS[kind].test(value);
  }

  private issue(kind: 'access' | 'refresh' | 'reset' | 'invite'): OpaqueToken {
    const value = `ea_${kind}_${randomBytes(32).toString('base64url')}`;
    return { value, hash: this.hash(value) };
  }
}
