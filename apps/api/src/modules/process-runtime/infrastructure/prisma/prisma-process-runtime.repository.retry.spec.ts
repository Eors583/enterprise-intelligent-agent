import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const repositorySource = readFileSync(
  new URL('./prisma-process-runtime.repository.ts', import.meta.url),
  'utf8',
);

describe('Prisma Process Runtime retry persistence', () => {
  it('persists the domain-derived attempt on every step transition', () => {
    expect(repositorySource).toContain(
      'nextAttempt = nextProcessStepAttempt(current.attempt, input.command.command);',
    );
    expect(repositorySource).toContain('"attempt" = ${nextAttempt},');
  });
});
