import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));

describe('API development output isolation', () => {
  it('keeps the watch compiler outside the production build directory', async () => {
    const packageJson = await readJson<{
      scripts?: Record<string, string>;
    }>('package.json');
    const baseConfig = await readJson<{
      compilerOptions?: { outDir?: string };
    }>('tsconfig.json');
    const productionConfig = await readJson<{
      compilerOptions?: { outDir?: string };
    }>('tsconfig.build.json');
    const devConfig = await readJson<{
      extends?: string;
      compilerOptions?: { outDir?: string; tsBuildInfoFile?: string };
    }>('tsconfig.dev.json');

    expect(packageJson.scripts?.dev).toBe('nest start --watch --path tsconfig.dev.json');
    expect(devConfig.extends).toBe('./tsconfig.build.json');

    const productionOutDir = resolve(
      apiRoot,
      productionConfig.compilerOptions?.outDir ?? baseConfig.compilerOptions?.outDir ?? 'dist',
    );
    const devOutDir = resolve(apiRoot, devConfig.compilerOptions?.outDir ?? 'dist');
    const devBuildInfo = resolve(
      apiRoot,
      devConfig.compilerOptions?.tsBuildInfoFile ?? 'tsconfig.tsbuildinfo',
    );

    expect(devOutDir).not.toBe(productionOutDir);
    const relativeBuildInfo = relative(devOutDir, devBuildInfo);
    expect(isAbsolute(relativeBuildInfo)).toBe(false);
    expect(relativeBuildInfo.startsWith('..')).toBe(false);
  });
});

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(resolve(apiRoot, relativePath), 'utf8')) as T;
}
