import {
  currentSessionResponseSchema,
  type BrowserAuthSessionResponse,
  type CurrentSessionResponse,
} from '@enterprise/contracts/auth-session';
import { z } from 'zod';

import { request } from './client';

export function currentBrowserSession(): Promise<BrowserAuthSessionResponse> {
  return request('/auth/me', {
    schema: currentSessionResponseSchema,
  }).then((account: CurrentSessionResponse) => ({ account }));
}

export function logout(): Promise<unknown> {
  return request('/auth/browser/logout', {
    method: 'POST',
    schema: z.unknown(),
  });
}
