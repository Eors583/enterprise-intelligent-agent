import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const environmentFile = ['.env', '.env.example']
  .map((name) => resolve(repositoryRoot, name))
  .find(existsSync);

if (environmentFile !== undefined) {
  process.loadEnvFile(environmentFile);
}

const require = createRequire(import.meta.url);
const cli = require.resolve('prisma/build/index.js');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: resolve(repositoryRoot, 'apps/api'),
  env: process.env,
  stdio: 'inherit',
});

if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
