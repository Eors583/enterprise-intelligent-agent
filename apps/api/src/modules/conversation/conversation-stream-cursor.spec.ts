import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { parseLastEventId } from './conversation.controller.js';

const RUN_ID = '00000000-0000-7000-8000-000000000802';

describe('Agent Run SSE Last-Event-ID', () => {
  it.each([
    [undefined, 0],
    [`${RUN_ID}:0`, 0],
    [`${RUN_ID}:1`, 1],
    [`${RUN_ID}:9999`, 9999],
    [`${RUN_ID}:10000`, 10_000],
    [`${RUN_ID}:10001`, 10_001],
  ] as const)('accepts only canonical in-range cursors: %s', (value, expected) => {
    expect(parseLastEventId(RUN_ID, value)).toBe(expected);
  });

  it.each([
    '',
    `${RUN_ID}:`,
    `${RUN_ID}:+1`,
    `${RUN_ID}:-1`,
    `${RUN_ID}:01`,
    `${RUN_ID}: 1`,
    `${RUN_ID}:1 `,
    `${RUN_ID}:1e2`,
    `${RUN_ID}:10002`,
    `${RUN_ID}:99999`,
    `00000000-0000-7000-8000-000000000999:1`,
  ])('rejects ambiguous or foreign replay id %s', (value) => {
    expect(() => parseLastEventId(RUN_ID, value)).toThrow(BadRequestException);
  });
});
