import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [path] : [];
  });
}

function joinedUiSource(): string {
  const roots = [
    resolve(process.cwd(), 'src'),
    resolve(process.cwd(), '../desktop/src/renderer/src'),
  ];
  return roots
    .flatMap(sourceFiles)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}

describe('non-technical user form guard', () => {
  it('does not expose raw JSON, hashes, UUIDs or delimited arrays as editable fields', () => {
    const source = joinedUiSource();
    expect(source).not.toMatch(/结构化请求 JSON|原始 JSON|JSON 兼容模式|变更内容（JSON）/u);
    expect(source).not.toContain('JSON.parse(');
    expect(source).not.toMatch(/模拟用户 ID|项目 ID（每行一个）|观察 ID（逗号分隔）/u);
    expect(source).not.toMatch(
      /name=["'](?:reviewEvidenceId|reviewEvidenceVersion|codeOverride)["']/u,
    );
    expect(source).not.toMatch(/手填 UUID|Evidence ID|Evidence 版本/u);
    expect(source).not.toMatch(/请替换占位|replace-with-source-record-id/u);
    expect(source).not.toContain('00000000-0000-7000-8000-000000000000');
    expect(source).not.toMatch(
      /<(?:input|textarea)[^>]*name=["'][^"']*(?:Hash|Json|Schema|Payload|Revision)[^"']*["'][^>]*>/iu,
    );
  });

  it('keeps knowledge ingestion file-first with enterprise document formats', () => {
    const upload = readFileSync(
      resolve(process.cwd(), 'src/components/knowledge/KnowledgeImportModal.tsx'),
      'utf8',
    );
    const documents = readFileSync(
      resolve(process.cwd(), 'src/components/knowledge/KnowledgeDocumentsPanel.tsx'),
      'utf8',
    );
    expect(upload).toContain('type="file"');
    expect(upload).toContain('.pdf,.docx,.xlsx,.txt,.md');
    expect(documents).toContain('上传文件');
    expect(documents).toContain('knowledge-source-more');
    expect(documents).toContain('粘贴文本');
  });
});
