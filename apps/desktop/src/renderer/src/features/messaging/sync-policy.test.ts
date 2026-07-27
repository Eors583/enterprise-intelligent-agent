import { describe, expect, it } from 'vitest';
import { messagingSyncOptions } from './sync-policy';

describe('messagingSyncOptions', () => {
  it('polls the active conversation every two seconds and the conversation list every ten seconds', () => {
    expect(messagingSyncOptions('messages', 'focused', true).refetchInterval).toBe(2_000);
    expect(messagingSyncOptions('conversations', 'focused', true).refetchInterval).toBe(10_000);
  });

  it('reduces polling when the window is visible but unfocused', () => {
    expect(messagingSyncOptions('messages', 'visible-unfocused', true).refetchInterval).toBe(
      10_000,
    );
    expect(messagingSyncOptions('conversations', 'visible-unfocused', true).refetchInterval).toBe(
      30_000,
    );
  });

  it('pauses polling for hidden windows and disabled messaging queries', () => {
    expect(messagingSyncOptions('messages', 'hidden', true).refetchInterval).toBe(false);
    expect(messagingSyncOptions('conversations', 'focused', false).refetchInterval).toBe(false);
  });

  it('always refreshes after focus and network recovery without background polling', () => {
    expect(messagingSyncOptions('messages', 'focused', true)).toMatchObject({
      refetchIntervalInBackground: false,
      refetchOnReconnect: 'always',
      refetchOnWindowFocus: 'always',
    });
  });
});
