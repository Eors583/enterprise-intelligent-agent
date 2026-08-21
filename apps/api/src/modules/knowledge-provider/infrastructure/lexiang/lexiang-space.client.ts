import {
  isLexiangSpaceListResponse,
  parseLexiangEntryResponse,
  parseLexiangEntryListResponse,
  parseLexiangFileUploadParameters,
  parseLexiangManagerListResponse,
  parseLexiangSpaceListResponse,
  parseLexiangSpaceResponse,
  parseLexiangTeamListResponse,
  type LexiangOperator,
  type LexiangEntry,
  type LexiangSpace,
  type LexiangSpaceListPage,
  type LexiangTeamListPage,
} from './lexiang-response.schemas.js';
import {
  LexiangProviderError,
  LexiangTokenProvider,
  type LexiangCredential,
} from './lexiang-token.provider.js';

interface LexiangSpaceContext {
  readonly connectionId: string;
  readonly credential: LexiangCredential;
}

export interface CreateLexiangSpaceInput extends LexiangSpaceContext {
  readonly teamId: string;
  readonly operatorStaffId: string;
  readonly name: string;
}

interface LexiangEntryWriteInput extends LexiangSpaceContext {
  readonly operatorStaffId: string;
  readonly spaceId: string;
  readonly parentEntryId: string | null;
  readonly name: string;
}

export interface UploadLexiangFileInput extends LexiangEntryWriteInput {
  readonly bytes: Buffer;
}

export class LexiangSpaceClient {
  constructor(
    private readonly tokens: LexiangTokenProvider,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async verifyTeam(input: LexiangSpaceContext & { readonly teamId: string }): Promise<void> {
    const url = new URL('https://lxapi.lexiangla.com/cgi-bin/v1/kb/spaces');
    url.searchParams.set('team_id', input.teamId);
    url.searchParams.set('limit', '1');
    const response = await this.request(input, url, { method: 'GET' });
    if (!isLexiangSpaceListResponse(await response.json())) {
      throw new LexiangProviderError('LEXIANG_SPACE_LIST_INVALID_RESPONSE');
    }
  }

  async listTeams(input: LexiangSpaceContext): Promise<LexiangTeamListPage['items']> {
    const items: LexiangTeamListPage['items'][number][] = [];
    let pageToken: string | null = null;
    const seenTokens = new Set<string>();
    do {
      const url = new URL('https://lxapi.lexiangla.com/cgi-bin/v1/kb/teams');
      url.searchParams.set('limit', '500');
      if (pageToken !== null) url.searchParams.set('page_token', pageToken);
      const response = await this.request(input, url, { method: 'GET' });
      const page = parseLexiangTeamListResponse(await response.json());
      if (page === null) throw new LexiangProviderError('LEXIANG_TEAM_LIST_INVALID_RESPONSE');
      items.push(...page.items);
      if (items.length > 1_000) throw new LexiangProviderError('LEXIANG_TEAM_LIST_LIMIT_EXCEEDED');
      if (page.items.length === 0) break;
      pageToken = page.pageToken;
      if (pageToken !== null && seenTokens.has(pageToken)) {
        throw new LexiangProviderError('LEXIANG_TEAM_LIST_INVALID_RESPONSE');
      }
      if (pageToken !== null) seenTokens.add(pageToken);
    } while (pageToken !== null);
    return items;
  }

  async listTenantManagers(input: LexiangSpaceContext): Promise<readonly LexiangOperator[]> {
    const response = await this.request(
      input,
      new URL('https://lxapi.lexiangla.com/cgi-bin/v1/contact/user/managers'),
      { method: 'GET' },
    );
    const managers = parseLexiangManagerListResponse(await response.json());
    if (managers === null) {
      throw new LexiangProviderError('LEXIANG_MANAGER_LIST_INVALID_RESPONSE');
    }
    return managers;
  }

  async createSpace(input: CreateLexiangSpaceInput): Promise<LexiangSpace> {
    const response = await this.request(
      input,
      new URL('https://lxapi.lexiangla.com/cgi-bin/v1/kb/spaces'),
      {
        method: 'POST',
        headers: this.writeHeaders(input.operatorStaffId),
        body: JSON.stringify({
          data: {
            type: 'kb_space',
            attributes: {
              name: input.name,
              visible_type: 0,
              manager_inherit_type: 'none',
              member_inherit_type: 'none',
            },
            relationships: {
              team: { data: { type: 'team', id: input.teamId } },
              subject: {
                data: [
                  {
                    type: 'staff',
                    id: input.operatorStaffId,
                    attributes: { role: 'manager' },
                  },
                ],
              },
            },
          },
        }),
      },
    );
    return this.parseSpace(await response.json());
  }

  async findSpaceByManagedMarker(
    input: LexiangSpaceContext & { readonly teamId: string; readonly marker: string },
  ): Promise<LexiangSpace | null> {
    const items = await this.listSpaces(input);
    const matches = items.filter((item) => item.name.endsWith(input.marker));
    if (matches.length > 1) {
      throw new LexiangProviderError('LEXIANG_MANAGED_SPACE_DUPLICATE');
    }
    return matches[0] === undefined ? null : this.getSpace({ ...input, spaceId: matches[0].id });
  }

  async listSpaces(
    input: LexiangSpaceContext & { readonly teamId: string },
  ): Promise<LexiangSpaceListPage['items']> {
    const items: LexiangSpaceListPage['items'][number][] = [];
    let pageToken: string | null = null;
    const seenTokens = new Set<string>();
    do {
      const url = new URL('https://lxapi.lexiangla.com/cgi-bin/v1/kb/spaces');
      url.searchParams.set('team_id', input.teamId);
      url.searchParams.set('limit', '100');
      if (pageToken !== null) url.searchParams.set('page_token', pageToken);
      const response = await this.request(input, url, { method: 'GET' });
      const page = parseLexiangSpaceListResponse(await response.json());
      if (page === null) {
        throw new LexiangProviderError('LEXIANG_SPACE_LIST_INVALID_RESPONSE');
      }
      items.push(...page.items);
      if (page.items.length === 0) break;
      pageToken = page.pageToken;
      if (pageToken !== null && seenTokens.has(pageToken)) {
        throw new LexiangProviderError('LEXIANG_SPACE_LIST_INVALID_RESPONSE');
      }
      if (pageToken !== null) seenTokens.add(pageToken);
      if (seenTokens.size > 100) {
        throw new LexiangProviderError('LEXIANG_SPACE_LIST_LIMIT_EXCEEDED');
      }
    } while (pageToken !== null);
    return items;
  }

  async listEntries(
    input: LexiangSpaceContext & { readonly spaceId: string },
  ): Promise<readonly LexiangEntry[]> {
    const entries: LexiangEntry[] = [];
    let parents: Array<string | null> = [null];
    const visitedParents = new Set<string>();
    while (parents.length > 0) {
      const pages = await mapConcurrent(parents, 10, (parentEntryId) =>
        this.listEntryChildren(input, parentEntryId),
      );
      const nextParents: string[] = [];
      for (const children of pages) {
        entries.push(...children);
        for (const child of children) {
          if (child.hasChildren || child.entryType === 'folder') nextParents.push(child.id);
        }
      }
      if (entries.length > 50_000) {
        throw new LexiangProviderError('LEXIANG_ENTRY_LIST_LIMIT_EXCEEDED');
      }
      parents = [...new Set(nextParents)].filter((id) => {
        if (visitedParents.has(id)) return false;
        visitedParents.add(id);
        return true;
      });
    }
    return entries;
  }

  async getSpace(input: LexiangSpaceContext & { readonly spaceId: string }): Promise<LexiangSpace> {
    const response = await this.request(input, this.spaceUrl(input.spaceId), { method: 'GET' });
    return this.parseSpace(await response.json());
  }

  async updateSpace(
    input: LexiangSpaceContext & {
      readonly spaceId: string;
      readonly operatorStaffId: string;
      readonly name: string;
    },
  ): Promise<LexiangSpace> {
    await this.request(input, this.spaceUrl(input.spaceId), {
      method: 'PUT',
      headers: this.writeHeaders(input.operatorStaffId),
      body: JSON.stringify({ data: { attributes: { name: input.name } } }),
    });
    return this.getSpace(input);
  }

  async deleteSpace(
    input: LexiangSpaceContext & {
      readonly spaceId: string;
      readonly operatorStaffId: string;
    },
  ): Promise<void> {
    await this.request(input, this.spaceUrl(input.spaceId), {
      method: 'DELETE',
      headers: this.writeHeaders(input.operatorStaffId),
    });
  }

  async createFolder(input: LexiangEntryWriteInput): Promise<LexiangEntry> {
    const url = this.entriesUrl(input.spaceId);
    const response = await this.request(input, url, {
      method: 'POST',
      headers: this.writeHeaders(input.operatorStaffId),
      body: JSON.stringify(this.entryBody(input.name, 'folder', input.parentEntryId)),
    });
    return this.parseEntry(await response.json(), input.parentEntryId);
  }

  async uploadFile(input: UploadLexiangFileInput): Promise<LexiangEntry> {
    const state = await this.uploadFileBytes(input);
    const url = this.entriesUrl(input.spaceId);
    url.searchParams.set('state', state);
    const response = await this.request(input, url, {
      method: 'POST',
      headers: this.writeHeaders(input.operatorStaffId),
      body: JSON.stringify(this.entryBody(input.name, 'file', input.parentEntryId)),
    });
    return this.parseEntry(await response.json(), input.parentEntryId);
  }

  async reuploadFile(
    input: Omit<UploadLexiangFileInput, 'spaceId' | 'parentEntryId'> & {
      readonly entryId: string;
    },
  ): Promise<LexiangEntry> {
    const state = await this.uploadFileBytes(input);
    const url = new URL(
      `https://lxapi.lexiangla.com/cgi-bin/v1/kb/entries/${encodeURIComponent(input.entryId)}/upload`,
    );
    url.searchParams.set('state', state);
    const response = await this.request(input, url, {
      method: 'PUT',
      headers: { 'x-staff-id': input.operatorStaffId },
    });
    const entry = this.parseEntry(await response.json(), null);
    if (entry.id !== input.entryId) {
      throw new LexiangProviderError('LEXIANG_ENTRY_INVALID_RESPONSE');
    }
    return entry;
  }

  async deleteEntry(
    input: LexiangSpaceContext & { readonly operatorStaffId: string; readonly entryId: string },
  ): Promise<void> {
    await this.request(
      input,
      new URL(
        `https://lxapi.lexiangla.com/cgi-bin/v1/kb/entries/${encodeURIComponent(input.entryId)}`,
      ),
      { method: 'DELETE', headers: { 'x-staff-id': input.operatorStaffId } },
    );
  }

  private async request(
    input: LexiangSpaceContext,
    url: URL,
    init: RequestInit,
  ): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.tokens.get(input.connectionId, input.credential, attempt > 0);
      const response = await this.fetchImplementation(url, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...init.headers },
        signal: AbortSignal.timeout(8_000),
      });
      if (response.status === 401 && attempt === 0) {
        this.tokens.invalidate(input.connectionId);
        continue;
      }
      if (response.status === 403) throw new LexiangProviderError('LEXIANG_FORBIDDEN', 403);
      if (!response.ok)
        throw new LexiangProviderError('LEXIANG_SPACE_UNAVAILABLE', response.status);
      return response;
    }
    throw new LexiangProviderError('LEXIANG_SPACE_UNAVAILABLE');
  }

  private async listEntryChildren(
    input: LexiangSpaceContext & { readonly spaceId: string },
    parentEntryId: string | null,
  ): Promise<readonly LexiangEntry[]> {
    const entries: LexiangEntry[] = [];
    let pageToken: string | null = null;
    const seenTokens = new Set<string>();
    do {
      const url = new URL('https://lxapi.lexiangla.com/cgi-bin/v1/kb/entries');
      url.searchParams.set('space_id', input.spaceId);
      url.searchParams.set('limit', '100');
      if (parentEntryId !== null) url.searchParams.set('parent_id', parentEntryId);
      if (pageToken !== null) url.searchParams.set('page_token', pageToken);
      const response = await this.request(input, url, { method: 'GET' });
      const page = parseLexiangEntryListResponse(await response.json());
      if (page === null) throw new LexiangProviderError('LEXIANG_ENTRY_LIST_INVALID_RESPONSE');
      entries.push(...page.items.map((item) => ({ ...item, parentEntryId })));
      if (page.items.length === 0) break;
      pageToken = page.pageToken;
      if (pageToken !== null && seenTokens.has(pageToken)) {
        throw new LexiangProviderError('LEXIANG_ENTRY_LIST_INVALID_RESPONSE');
      }
      if (pageToken !== null) seenTokens.add(pageToken);
      if (seenTokens.size > 100) {
        throw new LexiangProviderError('LEXIANG_ENTRY_LIST_LIMIT_EXCEEDED');
      }
    } while (pageToken !== null);
    return entries;
  }

  private async uploadFileBytes(
    input: LexiangSpaceContext & {
      readonly operatorStaffId: string;
      readonly name: string;
      readonly bytes: Buffer;
    },
  ): Promise<string> {
    const response = await this.request(
      input,
      new URL('https://lxapi.lexiangla.com/cgi-bin/v1/kb/files/upload-params'),
      {
        method: 'POST',
        headers: this.writeHeaders(input.operatorStaffId),
        body: JSON.stringify({ name: input.name, media_type: 'file' }),
      },
    );
    const parameters = parseLexiangFileUploadParameters(await response.json());
    if (parameters === null) {
      throw new LexiangProviderError('LEXIANG_FILE_UPLOAD_PARAMETERS_INVALID_RESPONSE');
    }
    const headers = new Headers(parameters.headers);
    headers.set('x-cos-security-token', parameters.securityToken);
    const upload = await this.fetchImplementation(parameters.uploadUrl, {
      method: 'PUT',
      headers,
      body: new Uint8Array(input.bytes),
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    });
    if (!upload.ok || upload.headers.get('etag') === null) {
      throw new LexiangProviderError('LEXIANG_FILE_BINARY_UPLOAD_FAILED', upload.status);
    }
    return parameters.state;
  }

  private parseSpace(value: unknown): LexiangSpace {
    const parsed = parseLexiangSpaceResponse(value);
    if (parsed === null) throw new LexiangProviderError('LEXIANG_SPACE_INVALID_RESPONSE');
    return parsed;
  }

  private parseEntry(value: unknown, parentEntryId: string | null): LexiangEntry {
    const parsed = parseLexiangEntryResponse(value);
    if (parsed === null) throw new LexiangProviderError('LEXIANG_ENTRY_INVALID_RESPONSE');
    return { ...parsed, parentEntryId };
  }

  private entryBody(name: string, entryType: 'folder' | 'file', parentEntryId: string | null) {
    return {
      data: {
        attributes: { name, entry_type: entryType },
        ...(parentEntryId === null
          ? {}
          : {
              relationships: {
                parent_entry: { data: { type: 'kb_entry', id: parentEntryId } },
              },
            }),
      },
    };
  }

  private writeHeaders(operatorStaffId: string): HeadersInit {
    return {
      'content-type': 'application/json; charset=utf-8',
      'x-staff-id': operatorStaffId,
    };
  }

  private spaceUrl(spaceId: string): URL {
    return new URL(
      `https://lxapi.lexiangla.com/cgi-bin/v1/kb/spaces/${encodeURIComponent(spaceId)}`,
    );
  }

  private entriesUrl(spaceId: string): URL {
    const url = new URL('https://lxapi.lexiangla.com/cgi-bin/v1/kb/entries');
    url.searchParams.set('space_id', spaceId);
    return url;
  }
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await operation(items[index]!);
      }
    }),
  );
  return results;
}
