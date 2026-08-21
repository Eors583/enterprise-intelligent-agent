interface RandomUuidSource {
  randomUUID(): string;
}

export function createSubscriptionId(
  source: RandomUuidSource | null | undefined = readRuntimeCrypto(),
): string {
  if (!source || typeof source.randomUUID !== 'function') {
    throw new Error('Secure UUID generation is unavailable in the Electron preload.');
  }
  return source.randomUUID();
}

function readRuntimeCrypto(): RandomUuidSource | undefined {
  const value = Reflect.get(globalThis, 'crypto');
  if (!value || typeof value !== 'object') return undefined;
  return value as RandomUuidSource;
}
