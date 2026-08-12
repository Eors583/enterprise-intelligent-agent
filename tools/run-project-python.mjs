import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = process.cwd();
const configuredPython = process.env.ENTERPRISE_PYTHON?.trim();
const candidates = [
  configuredPython,
  resolve(projectRoot, '.venv', 'Scripts', 'python.exe'),
  resolve(projectRoot, '.venv', 'bin', 'python'),
  'python',
].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);

for (const candidate of candidates) {
  if (candidate !== 'python' && !existsSync(candidate)) continue;

  const result = spawnSync(candidate, process.argv.slice(2), {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });

  if (result.error?.code === 'ENOENT') continue;
  if (result.error) {
    console.error(`Unable to start the project Python runtime: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

console.error(
  'No Python runtime was found. Create .venv as described in README.md or set ENTERPRISE_PYTHON.',
);
process.exit(1);
