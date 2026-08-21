import { describe, expect, it } from 'vitest';

import { mergeEntityOptions, parseTags } from './EntityPicker';

describe('EntityPicker helpers', () => {
  it('preserves an already stored relationship when the current directory no longer returns it', () => {
    expect(
      mergeEntityOptions(
        [{ id: 'current', label: '当前成员' }],
        ['current', 'legacy-relationship-id'],
      ),
    ).toEqual([
      { id: 'current', label: '当前成员' },
      {
        id: 'legacy-relationship-id',
        label: '已保存的对象 · legacy-r…p-id',
        description: 'legacy-relationship-id',
      },
    ]);
  });

  it('normalizes controlled tags without duplicate comma or whitespace entries', () => {
    expect(parseTags('INTERNAL, finance；INTERNAL\ncustomer-data')).toEqual([
      'INTERNAL',
      'finance',
      'customer-data',
    ]);
  });
});
