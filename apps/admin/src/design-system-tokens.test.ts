import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(process.cwd(), 'src');
const tokenSource = readFileSync(resolve(sourceRoot, 'styles/design-tokens.css'), 'utf8');
const applicationStyles = readFileSync(resolve(sourceRoot, 'styles.css'), 'utf8');

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [path] : [];
  });
}

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = applicationStyles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'u'));
  if (match?.[1] === undefined) throw new Error(`Missing design-system selector: ${selector}`);
  return match[1];
}

function hexToken(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = tokenSource.match(new RegExp(`${escaped}:\\s*(#[\\da-f]{6});`, 'iu'));
  if (match?.[1] === undefined) throw new Error(`Missing hexadecimal token: ${name}`);
  return match[1];
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
    const [red = 0, green = 0, blue = 0] = channels.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

describe('admin design token contract', () => {
  it('publishes the required typography, color, spacing and component tokens', () => {
    expect(applicationStyles.trimStart()).toMatch(
      /^@import ['"]\.\/styles\/design-tokens\.css['"];/u,
    );
    for (const token of [
      '--font-family-sans',
      '--font-family-mono',
      '--font-size-md',
      '--font-weight-bold',
      '--color-text-primary',
      '--color-surface-primary',
      '--color-action-primary',
      '--color-border-default',
      '--space-4',
      '--radius-md',
      '--shadow-focus',
      '--control-font-family',
      '--control-font-size',
      '--control-font-weight',
      '--control-line-height',
      '--control-height-md',
      '--knowledge-layout-gap',
      '--knowledge-document-row-height',
    ]) {
      expect(tokenSource).toContain(`${token}:`);
    }
  });

  it('applies the same explicit typography tokens to controls and native select options', () => {
    expect(applicationStyles).toMatch(
      /button,\s*input,\s*textarea,\s*select,\s*optgroup,\s*option\s*\{[^}]*font-family:\s*var\(--control-font-family\);[^}]*font-size:\s*var\(--control-font-size\);[^}]*font-weight:\s*var\(--control-font-weight\);[^}]*line-height:\s*var\(--control-line-height\);/su,
    );
    expect(applicationStyles).toMatch(
      /select option,\s*select optgroup\s*\{[^}]*color:\s*var\(--color-text-primary\);[^}]*background:\s*var\(--color-surface-primary\);/su,
    );
  });

  it('keeps secondary and tertiary copy at WCAG AA contrast on supported surfaces', () => {
    const foregrounds = [hexToken('--color-ink-500'), hexToken('--color-ink-400')];
    const backgrounds = [
      hexToken('--color-white'),
      hexToken('--color-brand-100'),
      hexToken('--color-neutral-100'),
    ];

    for (const foreground of foregrounds) {
      for (const background of backgrounds) {
        expect(
          contrastRatio(foreground, background),
          `${foreground} does not meet 4.5:1 on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('forbids raw font sizes and font stacks outside the token source', () => {
    const fontSizes = [...applicationStyles.matchAll(/font-size:\s*([^;]+);/gu)].map((match) =>
      match[1]?.trim(),
    );
    const fontFamilies = [...applicationStyles.matchAll(/font-family:\s*([^;]+);/gu)].map((match) =>
      match[1]?.trim(),
    );
    expect(fontSizes.every((value) => value?.startsWith('var(--'))).toBe(true);
    expect(fontFamilies.every((value) => value?.startsWith('var(--'))).toBe(true);
    expect(applicationStyles).not.toMatch(/(?:^|\s)font:\s/gu);
  });

  it('keeps knowledge React components free from inline visual styles', () => {
    const knowledgeSource = [
      resolve(sourceRoot, 'features/knowledge'),
      resolve(sourceRoot, 'components/knowledge'),
    ]
      .flatMap(sourceFiles)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(knowledgeSource).not.toMatch(/style\s*=\s*\{\{/u);
    expect(knowledgeSource).not.toMatch(/#[\da-f]{3,8}|rgba?\(/iu);
  });

  it('uses tokens for the core knowledge workspace visual language', () => {
    for (const selector of [
      '.knowledge-access-selection-summary',
      '.knowledge-layout',
      '.knowledge-space-root > summary',
      '.knowledge-space-picker',
      '.knowledge-space-options > label',
      '.knowledge-tabs',
      '.knowledge-tabs button',
      '.knowledge-document-toolbar',
      '.knowledge-document-entry',
      '.knowledge-document-row',
      '.knowledge-drop-zone',
    ]) {
      const declarations = rule(selector);
      expect(declarations, `${selector} contains a raw color`).not.toMatch(
        /#[\da-f]{3,8}|rgba?\(/iu,
      );
      for (const declaration of declarations.matchAll(
        /(font-size|font-weight|gap|padding|margin|border-radius):\s*([^;]+);/gu,
      )) {
        const value = declaration[2]?.trim() ?? '';
        expect(
          /var\(--/u.test(value) || /^(?:0|auto)$/u.test(value),
          `${selector} has an unregistered ${declaration[1]} value: ${value}`,
        ).toBe(true);
      }
    }
  });
});
