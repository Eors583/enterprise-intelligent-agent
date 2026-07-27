import { PasswordHasher } from './password-hasher.js';

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher();

  it('creates a versioned salted scrypt hash and verifies it', async () => {
    const first = await hasher.hash('Correct horse battery staple');
    const second = await hasher.hash('Correct horse battery staple');

    expect(first).toMatch(/^scrypt\$v1\$16384\$8\$1\$64\$/);
    expect(second).not.toBe(first);
    await expect(hasher.verify('Correct horse battery staple', first)).resolves.toBe(true);
    await expect(hasher.verify('wrong password', first)).resolves.toBe(false);
  });

  it.each(['', 'plain-text', 'scrypt$v2$16384$8$1$64$bad$bad', 'scrypt$v1$999999$8$1$64$bad$bad'])(
    'rejects malformed or unsupported encoded hashes',
    async (encoded) => {
      await expect(hasher.verify('anything', encoded)).resolves.toBe(false);
    },
  );
});
