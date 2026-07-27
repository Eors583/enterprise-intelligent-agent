import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthAccount } from '@enterprise/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  getSelectedStorageBackend: vi.fn(() => 'dpapi'),
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`, 'utf8')),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')),
}));

vi.mock('electron', () => ({ safeStorage: storage }));

import { AccountStore } from './account-store';

describe('AccountStore', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    storage.isEncryptionAvailable.mockReturnValue(true);
    directory = await mkdtemp(join(tmpdir(), 'enterprise-account-store-'));
    filePath = join(directory, 'accounts.v1.json');
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
    vi.clearAllMocks();
  });

  it('updates a refreshed account without changing the active selection', async () => {
    const store = new AccountStore(filePath);
    await store.load();
    await store.put(account(1), 'ea_refresh_first');
    await store.put(account(2), 'ea_refresh_second');
    await store.activate(account(1).sessionId);

    const refreshed = {
      ...account(2),
      accessExpiresAt: '2031-01-01T00:15:00.000Z',
    };
    await store.updateCredentials(refreshed, 'ea_refresh_second_rotated');

    expect(store.activeId).toBe(account(1).sessionId);
    expect(store.get(account(2).sessionId)).toEqual({
      account: refreshed,
      refreshToken: 'ea_refresh_second_rotated',
    });
  });

  it('loads every account from a legacy v1 snapshot without the password-change flag', async () => {
    const first = account(1);
    const second = account(2);
    const { passwordChangeRequired: _firstFlag, ...legacyFirst } = first;
    const { passwordChangeRequired: _secondFlag, ...legacySecond } = second;
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        activeSessionId: second.sessionId,
        accounts: [legacyFirst, legacySecond].map((legacyAccount, index) => ({
          account: legacyAccount,
          encryptedRefreshToken: Buffer.from(
            `encrypted:ea_refresh_legacy_${index + 1}`,
            'utf8',
          ).toString('base64'),
        })),
      }),
      'utf8',
    );

    const store = new AccountStore(filePath);
    await store.load();

    expect(store.list()).toEqual([
      { ...first, passwordChangeRequired: false },
      { ...second, passwordChangeRequired: false },
    ]);
    expect(store.activeId).toBe(second.sessionId);
    expect(store.get(first.sessionId)?.refreshToken).toBe('ea_refresh_legacy_1');
    expect(store.get(second.sessionId)?.refreshToken).toBe('ea_refresh_legacy_2');
  });

  it('serializes concurrent mutations and persists a complete decryptable snapshot', async () => {
    const store = new AccountStore(filePath);
    await store.load();

    await Promise.all([
      store.put(account(1), 'ea_refresh_first'),
      store.put(account(2), 'ea_refresh_second'),
      store.put(account(3), 'ea_refresh_third'),
    ]);
    await store.activate(account(2).sessionId);

    const serialized = await readFile(filePath, 'utf8');
    expect(serialized).not.toContain('ea_refresh_first');
    expect(serialized).not.toContain('ea_refresh_second');
    expect(serialized).not.toContain('ea_refresh_third');

    const reloaded = new AccountStore(filePath);
    await reloaded.load();
    expect(reloaded.list().map(({ sessionId }) => sessionId)).toEqual([
      account(1).sessionId,
      account(2).sessionId,
      account(3).sessionId,
    ]);
    expect(reloaded.activeId).toBe(account(2).sessionId);
    expect(reloaded.get(account(1).sessionId)?.refreshToken).toBe('ea_refresh_first');
    expect(reloaded.get(account(2).sessionId)?.refreshToken).toBe('ea_refresh_second');
    expect(reloaded.get(account(3).sessionId)?.refreshToken).toBe('ea_refresh_third');
  });

  it('removes a stale encrypted snapshot when a mutation occurs without safe storage', async () => {
    const store = new AccountStore(filePath);
    await store.load();
    await store.put(account(1), 'ea_refresh_first');
    expect(await readFile(filePath, 'utf8')).not.toHaveLength(0);

    storage.isEncryptionAvailable.mockReturnValue(false);
    await store.remove(account(1).sessionId);
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    storage.isEncryptionAvailable.mockReturnValue(true);
    const reloaded = new AccountStore(filePath);
    await reloaded.load();
    expect(reloaded.list()).toEqual([]);
    expect(reloaded.activeId).toBeNull();
  });
});

function account(index: number): AuthAccount {
  const suffix = String(index).padStart(12, '0');
  return {
    sessionId: `00000000-0000-7000-8000-${suffix}`,
    tenantId: `10000000-0000-7000-8000-${suffix}`,
    tenantSlug: `workspace-${index}`,
    tenantName: `Workspace ${index}`,
    userId: `20000000-0000-7000-8000-${suffix}`,
    email: `user-${index}@example.test`,
    displayName: `User ${index}`,
    role: index === 1 ? 'OWNER' : 'MEMBER',
    passwordChangeRequired: false,
    accessExpiresAt: '2030-01-01T00:15:00.000Z',
    refreshExpiresAt: '2030-01-31T00:00:00.000Z',
  };
}
