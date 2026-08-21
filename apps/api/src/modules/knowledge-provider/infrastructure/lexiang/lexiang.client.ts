import { createHash } from 'node:crypto';

import {
  LexiangProviderError,
  LexiangTokenProvider,
  type LexiangCredential,
} from './lexiang-token.provider.js';
import { parseLexiangSearchResponse, type LexiangSearchItem } from './lexiang-response.schemas.js';

export interface LexiangSearchInput {
  readonly connectionId: string;
  readonly credential: LexiangCredential;
  readonly staffId: string;
  readonly query: string;
  readonly targets: readonly [{ readonly type: 'space'; readonly id: string }];
  readonly topN?: number;
}

export interface LexiangEvidence {
  readonly evidenceId: string;
  readonly title: string;
  readonly content: string;
  readonly url: string;
  readonly score: number | null;
  readonly externalSpaceId: string;
}

const LEXIANG_REQUEST_TIMEOUT_MS = 20_000;

export class LexiangClient {
  constructor(
    private readonly tokens: LexiangTokenProvider,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly delay: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async search(input: LexiangSearchInput): Promise<readonly LexiangEvidence[]> {
    if (input.staffId.trim() === '') throw new LexiangProviderError('LEXIANG_STAFF_ID_REQUIRED');
    const query = Array.from(input.query.trim()).slice(0, 1_024).join('');
    if (query.length === 0) throw new LexiangProviderError('LEXIANG_SEARCH_QUERY_REQUIRED');
    if (input.targets.length !== 1 || input.targets[0].type !== 'space') {
      throw new LexiangProviderError('LEXIANG_SINGLE_SPACE_TARGET_REQUIRED');
    }
    const target = input.targets[0];
    let refreshed = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const token = await this.tokens.get(input.connectionId, input.credential, refreshed);
        const response = await this.fetchImplementation(
          'https://lxapi.lexiangla.com/cgi-bin/v1/ai/search',
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json; charset=utf-8',
              'x-staff-id': input.staffId,
            },
            body: JSON.stringify({
              query,
              targets: [{ type: 'space', id: target.id }],
              top_n: Math.min(50, Math.max(1, input.topN ?? 10)),
              with_score: true,
            }),
            signal: AbortSignal.timeout(LEXIANG_REQUEST_TIMEOUT_MS),
          },
        );
        if (response.status === 401 && !refreshed) {
          this.tokens.invalidate(input.connectionId);
          refreshed = true;
          continue;
        }
        if (response.status === 403) throw new LexiangProviderError('LEXIANG_FORBIDDEN', 403);
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await this.delay(attempt === 0 ? 150 : 400);
          continue;
        }
        if (!response.ok)
          throw new LexiangProviderError('LEXIANG_SEARCH_UNAVAILABLE', response.status);
        const parsed = parseLexiangSearchResponse(await response.json());
        if (parsed === null) throw new LexiangProviderError('LEXIANG_SEARCH_INVALID_RESPONSE');
        return parsed.map((item) => toEvidence(item, target.id));
      } catch (error) {
        if (!isRetriableLexiangError(error) || attempt === 2) {
          throw error instanceof LexiangProviderError
            ? error
            : new LexiangProviderError('LEXIANG_SEARCH_UNAVAILABLE');
        }
        await this.delay(attempt === 0 ? 150 : 400);
      }
    }
    throw new LexiangProviderError('LEXIANG_SEARCH_UNAVAILABLE');
  }
}

function isRetriableLexiangError(error: unknown): boolean {
  return (
    !(error instanceof LexiangProviderError) ||
    error.code === 'LEXIANG_SEARCH_UNAVAILABLE' ||
    error.code === 'LEXIANG_TOKEN_UNAVAILABLE'
  );
}

function toEvidence(item: LexiangSearchItem, expectedSpaceId: string): LexiangEvidence {
  const contentHash = createHash('sha256').update(item.content.normalize('NFC')).digest('hex');
  return {
    evidenceId: createHash('sha256')
      .update(`lexiang\0${expectedSpaceId}\0${item.url}\0${contentHash}`)
      .digest('hex'),
    title: item.title,
    content: item.content,
    url: item.url,
    score: item.score ?? null,
    externalSpaceId: expectedSpaceId,
  };
}
