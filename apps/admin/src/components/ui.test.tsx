import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { StatusPill } from './ui';

describe('StatusPill', () => {
  it('does not attach synchronization semantics to generic lifecycle states', () => {
    expect(renderToStaticMarkup(createElement(StatusPill, { value: 'RUNNING' }))).toContain(
      '进行中',
    );
    expect(renderToStaticMarkup(createElement(StatusPill, { value: 'SUCCEEDED' }))).toContain(
      '成功',
    );
    expect(renderToStaticMarkup(createElement(StatusPill, { value: 'FAILED' }))).toContain('失败');
    expect(renderToStaticMarkup(createElement(StatusPill, { value: 'SUCCEEDED' }))).not.toContain(
      '同步成功',
    );
  });
});
