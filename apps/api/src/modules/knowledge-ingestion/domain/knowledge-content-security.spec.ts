import { describe, expect, it } from 'vitest';
import { scanKnowledgeContent } from './knowledge-content-security.js';

describe('scanKnowledgeContent', () => {
  it('detects a credential but never returns it in full', () => {
    const secret = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
    const result = scanKnowledgeContent(`说明\nAPI_KEY=${secret}`);
    expect(result).toEqual([expect.objectContaining({ type: 'ACCESS_TOKEN', line: 2 })]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('uses checksums for identity and bank card candidates', () => {
    expect(
      scanKnowledgeContent('11010519491231002X\n4111111111111111').map((item) => item.type),
    ).toEqual(['CHINESE_ID_CARD', 'BANK_CARD']);
    expect(scanKnowledgeContent('110105194912310021\n4111111111111112')).toEqual([]);
  });
  it('ignores documented placeholders', () =>
    expect(scanKnowledgeContent('password=change_me')).toEqual([]));
});
