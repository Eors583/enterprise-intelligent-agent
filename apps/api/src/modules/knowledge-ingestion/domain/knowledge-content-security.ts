export type KnowledgeContentRiskType = 'PRIVATE_KEY' | 'ACCESS_TOKEN' | 'CONNECTION_CREDENTIAL' | 'PLAIN_PASSWORD' | 'CHINESE_ID_CARD' | 'BANK_CARD';

export interface KnowledgeContentRiskFinding { readonly type: KnowledgeContentRiskType; readonly line: number; readonly redactedPreview: string }

const patterns: ReadonlyArray<readonly [KnowledgeContentRiskType, RegExp]> = [
  ['PRIVATE_KEY', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu],
  ['ACCESS_TOKEN', /\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{24,}|AKIA[0-9A-Z]{16})\b/u],
  ['ACCESS_TOKEN', /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+\/-]{24,}/iu],
  ['CONNECTION_CREDENTIAL', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:/]+:[^\s@]{6,}@/iu],
  ['PLAIN_PASSWORD', /\b(?:password|passwd|pwd)\s*[:=]\s*["']?(?!change_me|example|placeholder|测试|示例)[^\s"']{8,}/iu],
];

export function scanKnowledgeContent(text: string): readonly KnowledgeContentRiskFinding[] {
  const findings: KnowledgeContentRiskFinding[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    for (const [type, pattern] of patterns) if (pattern.test(line)) add(findings, type, index + 1, line);
    for (const value of line.match(/\b\d{17}[0-9Xx]\b/gu) ?? []) if (validChineseId(value)) add(findings, 'CHINESE_ID_CARD', index + 1, line);
    for (const value of line.match(/\b\d{13,19}\b/gu) ?? []) if (validLuhn(value)) add(findings, 'BANK_CARD', index + 1, line);
    if (findings.length >= 20) break;
  }
  return findings;
}

function add(items: KnowledgeContentRiskFinding[], type: KnowledgeContentRiskType, line: number, source: string): void {
  if (items.length >= 20 || items.some((item) => item.type === type && item.line === line)) return;
  const value = source.trim().replace(/\s+/gu, ' ').slice(0, 160);
  items.push({ type, line, redactedPreview: value.length <= 8 ? '***' : `${value.slice(0, 4)}***${value.slice(-4)}` });
}

function validLuhn(value: string): boolean {
  let sum = 0; let double = false;
  for (let index = value.length - 1; index >= 0; index -= 1) { let digit = Number(value[index]); if (double && (digit *= 2) > 9) digit -= 9; sum += digit; double = !double; }
  return sum % 10 === 0;
}

function validChineseId(value: string): boolean {
  const factors = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  return checks[factors.reduce((sum, factor, index) => sum + Number(value[index]) * factor, 0) % 11] === value[17]?.toUpperCase();
}
