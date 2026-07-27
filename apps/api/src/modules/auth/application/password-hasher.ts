import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEMORY = 64 * 1024 * 1024;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

@Injectable()
export class PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const derived = await derive(password, salt);
    return [
      'scrypt',
      VERSION,
      String(COST),
      String(BLOCK_SIZE),
      String(PARALLELIZATION),
      String(KEY_LENGTH),
      salt.toString('base64url'),
      derived.toString('base64url'),
    ].join('$');
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    const parsed = parseEncodedHash(encoded);
    if (parsed === null) return false;

    const actual = await derive(password, parsed.salt);
    return actual.length === parsed.expected.length && timingSafeEqual(actual, parsed.expected);
  }
}

function parseEncodedHash(
  encoded: string,
): { readonly salt: Buffer; readonly expected: Buffer } | null {
  const parts = encoded.split('$');
  if (
    parts.length !== 8 ||
    parts[0] !== 'scrypt' ||
    parts[1] !== VERSION ||
    parts[2] !== String(COST) ||
    parts[3] !== String(BLOCK_SIZE) ||
    parts[4] !== String(PARALLELIZATION) ||
    parts[5] !== String(KEY_LENGTH)
  ) {
    return null;
  }

  const saltText = parts[6]!;
  const expectedText = parts[7]!;
  if (!BASE64URL_PATTERN.test(saltText) || !BASE64URL_PATTERN.test(expectedText)) return null;

  const salt = Buffer.from(saltText, 'base64url');
  const expected = Buffer.from(expectedText, 'base64url');
  if (
    salt.length !== SALT_LENGTH ||
    expected.length !== KEY_LENGTH ||
    salt.toString('base64url') !== saltText ||
    expected.toString('base64url') !== expectedText
  ) {
    return null;
  }
  return { salt, expected };
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: COST, r: BLOCK_SIZE, p: PARALLELIZATION, maxmem: MAX_MEMORY },
      (error, derivedKey) => {
        if (error === null) resolve(derivedKey);
        else reject(error);
      },
    );
  });
}
