import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
import { authAccountSchema, type AuthAccount } from '@enterprise/contracts';
import { z } from 'zod';

const persistedAuthAccountSchema = authAccountSchema.extend({
  // v1 snapshots created before forced password changes did not contain this
  // field. Keep the wire contract strict while upgrading local encrypted data.
  passwordChangeRequired: z.boolean().default(false),
});

const storedAccountSchema = z.object({
  account: persistedAuthAccountSchema,
  encryptedRefreshToken: z.string().min(1),
});

const accountFileSchema = z.object({
  version: z.literal(1),
  activeSessionId: z.string().nullable(),
  accounts: z.array(storedAccountSchema),
});

interface RuntimeAccount {
  account: AuthAccount;
  refreshToken: string;
}

export class AccountStore {
  private runtime = new Map<string, RuntimeAccount>();
  private activeSessionId: string | null = null;
  private loaded = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  get persistentStorageAvailable(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.persistentStorageAvailable) return;

    try {
      const parsed = accountFileSchema.safeParse(
        JSON.parse(await readFile(this.filePath, 'utf8')) as unknown,
      );
      if (!parsed.success) return;
      for (const item of parsed.data.accounts) {
        try {
          const refreshToken = safeStorage.decryptString(
            Buffer.from(item.encryptedRefreshToken, 'base64'),
          );
          this.runtime.set(item.account.sessionId, { account: item.account, refreshToken });
        } catch {
          // Ignore entries that cannot be decrypted for this OS user profile.
        }
      }
      this.activeSessionId = this.runtime.has(parsed.data.activeSessionId ?? '')
        ? parsed.data.activeSessionId
        : (this.runtime.keys().next().value ?? null);
    } catch {
      // A first launch or damaged account file simply starts signed out.
    }
  }

  list(): readonly AuthAccount[] {
    return [...this.runtime.values()].map(({ account }) => account);
  }

  get activeId(): string | null {
    return this.activeSessionId;
  }

  get(sessionId: string): RuntimeAccount | undefined {
    return this.runtime.get(sessionId);
  }

  get active(): RuntimeAccount | undefined {
    return this.activeSessionId ? this.runtime.get(this.activeSessionId) : undefined;
  }

  async put(account: AuthAccount, refreshToken: string): Promise<void> {
    await this.upsert(account, refreshToken, true, false);
  }

  async updateCredentials(account: AuthAccount, refreshToken: string): Promise<void> {
    await this.upsert(account, refreshToken, false, true);
  }

  async activate(sessionId: string): Promise<void> {
    await this.mutate(async () => {
      if (!this.runtime.has(sessionId)) {
        throw new Error('Account session is not stored on this device.');
      }
      await this.persist(this.runtime, sessionId);
      this.activeSessionId = sessionId;
    });
  }

  async remove(sessionId: string): Promise<void> {
    await this.mutate(async () => {
      const next = new Map(this.runtime);
      next.delete(sessionId);
      const nextActiveSessionId =
        this.activeSessionId === sessionId
          ? (next.keys().next().value ?? null)
          : this.activeSessionId;
      await this.persist(next, nextActiveSessionId);
      this.runtime = next;
      this.activeSessionId = nextActiveSessionId;
    });
  }

  private async upsert(
    account: AuthAccount,
    refreshToken: string,
    activate: boolean,
    requireExisting: boolean,
  ): Promise<void> {
    await this.mutate(async () => {
      if (requireExisting && !this.runtime.has(account.sessionId)) {
        throw new Error('Account session is not stored on this device.');
      }
      const next = new Map(this.runtime);
      next.set(account.sessionId, { account, refreshToken });
      const nextActiveSessionId = activate ? account.sessionId : this.activeSessionId;
      await this.persist(next, nextActiveSessionId);
      this.runtime = next;
      this.activeSessionId = nextActiveSessionId;
    });
  }

  private mutate(operation: () => Promise<void>): Promise<void> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.catch(() => undefined);
    return result;
  }

  private async persist(
    accounts: ReadonlyMap<string, RuntimeAccount>,
    activeSessionId: string | null,
  ): Promise<void> {
    if (!this.persistentStorageAvailable) {
      // Never fall back to plaintext. A local mutation while the OS vault is
      // unavailable must also remove the old encrypted snapshot; otherwise a
      // logged-out or rotated account could reappear when encryption returns.
      await rm(this.filePath, { force: true });
      return;
    }
    const payload = {
      version: 1 as const,
      activeSessionId,
      accounts: [...accounts.values()].map(({ account, refreshToken }) => ({
        account,
        encryptedRefreshToken: safeStorage.encryptString(refreshToken).toString('base64'),
      })),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}
