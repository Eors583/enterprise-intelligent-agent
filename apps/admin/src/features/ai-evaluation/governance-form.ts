import { ingestAiEvaluationBadCaseRequestSchema } from '@enterprise/contracts';
import { z } from 'zod';

const badCaseLineagePackageSchema = ingestAiEvaluationBadCaseRequestSchema
  .pick({
    sourceType: true,
    sourceId: true,
    sourceVersion: true,
    sourceSnapshotHash: true,
  })
  .strict();

export type BadCaseLineagePackage = z.infer<typeof badCaseLineagePackageSchema>;

export function stableEvaluationDatasetCode(name: string): string {
  const readable = name
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '.')
    .replace(/^\.+|\.+$/gu, '');
  const suffix = readable || stableEvaluationToken(name);
  return `DATASET.${suffix}`.slice(0, 100).replace(/[._-]+$/u, '');
}

export function stableEvaluationCaseKey(
  category: string,
  input: string,
  expectedBehavior: string,
): string {
  return `CASE.${category}.${stableEvaluationToken(`${input.trim()}\n${expectedBehavior.trim()}`)}`;
}

export function parseBadCaseLineagePackage(value: string): BadCaseLineagePackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('坏样本结果包不是有效 JSON。');
  }
  const result = badCaseLineagePackageSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error('坏样本结果包缺少可信来源 ID、版本或 SHA-256 快照。');
  }
  return result.data;
}

export function selectedFormValues(data: FormData, key: string): string[] {
  return [
    ...new Set(
      data
        .getAll(key)
        .map((value) => String(value).trim())
        .filter(Boolean),
    ),
  ];
}

function stableEvaluationToken(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value.normalize('NFKC'))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0').toUpperCase();
}
