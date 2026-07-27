import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const nestCli = resolve(dirname(require.resolve('@nestjs/cli/package.json')), 'bin', 'nest.js');
const maxCapturedOutput = 64 * 1024;

const packageJson = await readJson(resolve(apiRoot, 'package.json'));
const baseConfig = await readJson(resolve(apiRoot, 'tsconfig.json'));
const productionConfig = await readJson(resolve(apiRoot, 'tsconfig.build.json'));
const devConfig = await readJson(resolve(apiRoot, 'tsconfig.dev.json'));
const productionOutDir = resolve(
  apiRoot,
  productionConfig.compilerOptions?.outDir ?? baseConfig.compilerOptions?.outDir ?? 'dist',
);
const devOutDir = resolve(apiRoot, devConfig.compilerOptions?.outDir ?? 'dist');

if (productionOutDir === devOutDir) {
  throw new Error('Development watch and production build must not share an output directory.');
}
if (!String(packageJson.scripts?.dev ?? '').includes('--path tsconfig.dev.json')) {
  throw new Error('The API dev script must select tsconfig.dev.json explicitly.');
}

const port = await reserveLoopbackPort();
if (port === 3000) throw new Error('The isolation check must never bind the normal API port.');

const environment = {
  ...process.env,
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: String(port),
  REPOSITORY_DRIVER: 'memory',
  AGENT_RUN_WORKER_ENABLED: 'false',
  IM_OUTBOX_ENABLED: 'false',
  KNOWLEDGE_SEMANTIC_SEARCH_ENABLED: 'false',
  KNOWLEDGE_RERANK_ENABLED: 'false',
  FEISHU_DIRECTORY_SYNC_ENABLED: 'false',
  AUTH_LOGIN_RATE_LIMIT_ENABLED: 'false',
};

let watcher;
let watcherOutput = '';
let healthChecks = 0;

try {
  watcher = spawn(
    process.execPath,
    [
      nestCli,
      'start',
      '--watch',
      '--path',
      'tsconfig.dev.json',
      '--preserveWatchOutput',
      '--no-shell',
    ],
    {
      cwd: apiRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  watcher.stdout.on('data', (chunk) => {
    watcherOutput = appendBounded(watcherOutput, chunk);
  });
  watcher.stderr.on('data', (chunk) => {
    watcherOutput = appendBounded(watcherOutput, chunk);
  });

  await waitForHealthy(port, watcher, () => watcherOutput, 60_000);

  const build = spawn(process.execPath, [nestCli, 'build'], {
    cwd: apiRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buildOutput = '';
  build.stdout.on('data', (chunk) => {
    buildOutput = appendBounded(buildOutput, chunk);
  });
  build.stderr.on('data', (chunk) => {
    buildOutput = appendBounded(buildOutput, chunk);
  });
  const buildResult = waitForExit(build);

  while (build.exitCode === null && build.signalCode === null) {
    await assertHealthy(port, 'during the production build');
    healthChecks += 1;
    await delay(100);
  }

  const { code, signal } = await buildResult;
  if (code !== 0) {
    throw new Error(
      `Production build failed (code=${String(code)}, signal=${String(signal)}).\n${buildOutput}`,
    );
  }
  if (!existsSync(resolve(productionOutDir, 'main.js'))) {
    throw new Error('Production build completed without dist/main.js.');
  }
  if (!existsSync(resolve(devOutDir, 'main.js'))) {
    throw new Error('Production build removed the isolated development entry point.');
  }

  for (let index = 0; index < 10; index += 1) {
    await assertHealthy(port, 'after the production build');
    healthChecks += 1;
    await delay(100);
  }

  process.stdout.write(
    `${JSON.stringify({
      status: 'dev-build-isolation-verified',
      shadowPort: port,
      repository: 'memory',
      productionOutDir,
      devOutDir,
      healthChecks,
    })}\n`,
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(`${detail}\nShadow API output:\n${watcherOutput}`);
} finally {
  if (watcher !== undefined) terminateOwnedProcessTree(watcher);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function appendBounded(current, chunk) {
  const next = current + String(chunk);
  return next.length <= maxCapturedOutput ? next : next.slice(-maxCapturedOutput);
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Unable to allocate a loopback port for the isolation check.');
  }
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
  return address.port;
}

async function waitForHealthy(port, child, output, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Shadow API exited before becoming healthy (code=${String(child.exitCode)}, signal=${String(child.signalCode)}).\n${output()}`,
      );
    }
    const compilationErrors = output().match(/Found ([1-9]\d*) errors?\./u);
    if (compilationErrors !== null) {
      throw new Error(`Shadow API compilation failed with ${compilationErrors[1]} error(s).`);
    }
    if (await isHealthy(port)) return;
    await delay(200);
  }
  throw new Error(`Shadow API did not become healthy within ${timeoutMs}ms.`);
}

async function assertHealthy(port, phase) {
  if (!(await isHealthy(port))) throw new Error(`Shadow API became unavailable ${phase}.`);
}

async function isHealthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health/live`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function waitForExit(child) {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

function terminateOwnedProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
