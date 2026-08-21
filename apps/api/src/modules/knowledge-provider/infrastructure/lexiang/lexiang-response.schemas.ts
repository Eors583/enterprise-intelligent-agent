export interface LexiangTokenResponse {
  readonly access_token: string;
  readonly expires_in: number;
}

export interface LexiangSearchItem {
  readonly title: string;
  readonly content: string;
  readonly url: string;
  readonly score?: number;
}

export interface LexiangSpace {
  readonly id: string;
  readonly teamId: string;
  readonly rootEntryId: string;
  readonly name: string;
  readonly description: string | null;
  readonly logo: string | null;
  readonly visibleType: number | null;
  readonly managerInheritType: string | null;
  readonly memberInheritType: string | null;
}

export interface LexiangSpaceListPage {
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly rootEntryId: string;
    readonly name: string;
  }>;
  readonly pageToken: string | null;
}

export interface LexiangEntry {
  readonly id: string;
  readonly parentEntryId: string | null;
  readonly name: string;
  readonly entryType: string;
  readonly hasChildren: boolean;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface LexiangEntryListPage {
  readonly items: ReadonlyArray<Omit<LexiangEntry, 'parentEntryId'>>;
  readonly pageToken: string | null;
}

export interface LexiangFileUploadParameters {
  readonly state: string;
  readonly uploadUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly securityToken: string;
}

export interface LexiangTeamListPage {
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly code: string;
    readonly name: string;
  }>;
  readonly pageToken: string | null;
}

export interface LexiangOperator {
  readonly staffId: string;
  readonly name: string;
}

export function parseLexiangTokenResponse(value: unknown): LexiangTokenResponse | null {
  if (!isRecord(value) || typeof value.access_token !== 'string' || value.access_token === '') {
    return null;
  }
  const expiresIn = value.expires_in ?? 7_200;
  if (!Number.isInteger(expiresIn) || (expiresIn as number) <= 0 || (expiresIn as number) > 7_200) {
    return null;
  }
  return { access_token: value.access_token, expires_in: expiresIn as number };
}

export function parseLexiangSearchResponse(value: unknown): readonly LexiangSearchItem[] | null {
  if (
    !isRecord(value) ||
    value.code !== 0 ||
    !isRecord(value.data) ||
    !Array.isArray(value.data.list)
  ) {
    return null;
  }
  const items: LexiangSearchItem[] = [];
  for (const item of value.data.list) {
    if (
      !isRecord(item) ||
      typeof item.title !== 'string' ||
      item.title.length > 1_000 ||
      typeof item.content !== 'string' ||
      item.content.length === 0 ||
      item.content.length > 200_000 ||
      typeof item.url !== 'string' ||
      item.url.length > 2_048 ||
      !isHttpsUrl(item.url) ||
      (item.score !== undefined && !Number.isFinite(item.score))
    ) {
      return null;
    }
    items.push({
      title: item.title,
      content: item.content,
      url: item.url,
      ...(item.score === undefined ? {} : { score: item.score as number }),
    });
  }
  return items;
}

export function parseLexiangSpaceResponse(value: unknown): LexiangSpace | null {
  if (!isRecord(value) || !isRecord(value.data)) return null;
  const data = value.data;
  const attributes = data.attributes;
  const relationships = data.relationships;
  if (
    data.type !== 'kb_space' ||
    !safeId(data.id) ||
    !isRecord(attributes) ||
    typeof attributes.name !== 'string' ||
    attributes.name.length === 0 ||
    attributes.name.length > 200 ||
    !isRecord(relationships) ||
    !safeRelationshipId(relationships.team, 'team') ||
    !safeRelationshipId(relationships.root_entry, 'kb_entry')
  ) {
    return null;
  }
  const description = optionalBoundedString(attributes.description, 4_000);
  const logo = optionalBoundedString(attributes.logo, 1_000);
  const visibleType = optionalInteger(attributes.visible_type, 0, 2);
  const managerInheritType = optionalBoundedString(attributes.manager_inherit_type, 24);
  const memberInheritType = optionalBoundedString(attributes.member_inherit_type, 24);
  if (
    description === undefined ||
    logo === undefined ||
    visibleType === undefined ||
    managerInheritType === undefined ||
    memberInheritType === undefined
  ) {
    return null;
  }
  return {
    id: data.id,
    teamId: relationships.team.data.id,
    rootEntryId: relationships.root_entry.data.id,
    name: attributes.name,
    description,
    logo,
    visibleType,
    managerInheritType,
    memberInheritType,
  };
}

export function isLexiangSpaceListResponse(value: unknown): boolean {
  return parseLexiangSpaceListResponse(value) !== null;
}

export function parseLexiangSpaceListResponse(value: unknown): LexiangSpaceListPage | null {
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  const items: LexiangSpaceListPage['items'][number][] = [];
  for (const item of value.data) {
    if (
      !isRecord(item) ||
      item.type !== 'kb_space' ||
      !safeId(item.id) ||
      !isRecord(item.attributes) ||
      typeof item.attributes.name !== 'string' ||
      item.attributes.name.length === 0 ||
      item.attributes.name.length > 100 ||
      !isRecord(item.relationships) ||
      !safeRelationshipId(item.relationships.root_entry, 'kb_entry')
    ) {
      return null;
    }
    items.push({
      id: item.id,
      rootEntryId: item.relationships.root_entry.data.id,
      name: item.attributes.name,
    });
  }
  const pageToken = isRecord(value.meta)
    ? optionalBoundedString(value.meta.page_token, 4_000)
    : null;
  if (pageToken === undefined) return null;
  return { items, pageToken };
}

export function parseLexiangEntryListResponse(value: unknown): LexiangEntryListPage | null {
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  const items: LexiangEntryListPage['items'][number][] = [];
  for (const item of value.data) {
    const parsed = parseEntryData(item);
    if (parsed === null) return null;
    items.push(parsed);
  }
  const pageToken = isRecord(value.meta)
    ? optionalBoundedString(value.meta.page_token, 4_000)
    : null;
  return pageToken === undefined ? null : { items, pageToken };
}

export function parseLexiangEntryResponse(value: unknown): LexiangEntry | null {
  if (!isRecord(value)) return null;
  const parsed = parseEntryData(value.data);
  return parsed === null ? null : { ...parsed, parentEntryId: null };
}

export function parseLexiangFileUploadParameters(
  value: unknown,
): LexiangFileUploadParameters | null {
  if (!isRecord(value) || !isRecord(value.object)) return null;
  const object = value.object;
  if (
    !boundedString(object.state, 4_000) ||
    !boundedString(object.upload_url, 16_000) ||
    !isTencentCosUploadUrl(object.upload_url) ||
    !isRecord(object.headers) ||
    !isRecord(object.auth) ||
    !boundedString(object.auth.XCosSecurityToken, 32_000)
  ) {
    return null;
  }
  const headerEntries = Object.entries(object.headers);
  if (headerEntries.length > 64) return null;
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of headerEntries) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ||
      name.length > 200 ||
      typeof headerValue !== 'string' ||
      headerValue.length > 8_000 ||
      ['authorization', 'cookie', 'host'].includes(name.toLowerCase())
    ) {
      return null;
    }
    headers[name] = headerValue;
  }
  return {
    state: object.state,
    uploadUrl: object.upload_url,
    headers,
    securityToken: object.auth.XCosSecurityToken,
  };
}

export function parseLexiangTeamListResponse(value: unknown): LexiangTeamListPage | null {
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  const items: LexiangTeamListPage['items'][number][] = [];
  for (const item of value.data) {
    if (
      !isRecord(item) ||
      item.type !== 'team' ||
      !safeId(item.id) ||
      !isRecord(item.attributes) ||
      !safeId(item.attributes.code) ||
      !boundedString(item.attributes.name, 200)
    ) {
      return null;
    }
    items.push({ id: item.id, code: item.attributes.code, name: item.attributes.name });
  }
  const pageToken = isRecord(value.meta)
    ? optionalBoundedString(value.meta.page_token, 4_000)
    : null;
  return pageToken === undefined ? null : { items, pageToken };
}

export function parseLexiangManagerListResponse(value: unknown): readonly LexiangOperator[] | null {
  if (!isRecord(value) || value.code !== 0 || !Array.isArray(value.data)) return null;
  const items: LexiangOperator[] = [];
  for (const item of value.data) {
    if (!isRecord(item) || !safeId(item.staff_id) || !boundedString(item.name, 200)) {
      return null;
    }
    items.push({ staffId: item.staff_id, name: item.name });
  }
  return items;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isTencentCosUploadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.myqcloud.com');
  } catch {
    return false;
  }
}

function parseEntryData(value: unknown): Omit<LexiangEntry, 'parentEntryId'> | null {
  if (
    !isRecord(value) ||
    value.type !== 'kb_entry' ||
    !safeId(value.id) ||
    !isRecord(value.attributes) ||
    !boundedString(value.attributes.name, 300) ||
    !boundedString(value.attributes.entry_type, 64) ||
    (value.attributes.has_children !== undefined &&
      typeof value.attributes.has_children !== 'boolean')
  ) {
    return null;
  }
  const createdAt = optionalBoundedString(value.attributes.created_at, 64);
  const updatedAt = optionalBoundedString(value.attributes.updated_at, 64);
  if (createdAt === undefined || updatedAt === undefined) return null;
  return {
    id: value.id,
    name: value.attributes.name,
    entryType: value.attributes.entry_type,
    hasChildren: value.attributes.has_children === true,
    createdAt,
    updatedAt,
  };
}

function safeRelationshipId(value: unknown, type: string): value is { data: { id: string } } {
  return (
    isRecord(value) && isRecord(value.data) && value.data.type === type && safeId(value.data.id)
  );
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200;
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum;
}

function optionalBoundedString(value: unknown, maximum: number): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && value.length <= maximum ? value : undefined;
}

function optionalInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null | undefined {
  if (value === undefined || value === null) return null;
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? (value as number)
    : undefined;
}
