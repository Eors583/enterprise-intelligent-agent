export type WindowActivity = 'focused' | 'visible-unfocused' | 'hidden';

export type MessagingSyncResource = 'conversations' | 'messages';

const FOCUSED_INTERVALS: Record<MessagingSyncResource, number> = {
  conversations: 10_000,
  messages: 2_000,
};

const UNFOCUSED_INTERVALS: Record<MessagingSyncResource, number> = {
  conversations: 30_000,
  messages: 10_000,
};

export interface MessagingSyncOptions {
  refetchInterval: number | false;
  refetchIntervalInBackground: false;
  refetchOnReconnect: 'always';
  refetchOnWindowFocus: 'always';
}

/**
 * Poll aggressively only while the user is actively looking at messaging.
 * Hidden/minimized windows stop polling entirely; focus and reconnect events
 * still trigger an immediate refresh through React Query/the messaging hooks.
 */
export function messagingSyncOptions(
  resource: MessagingSyncResource,
  activity: WindowActivity,
  enabled: boolean,
): MessagingSyncOptions {
  const interval =
    !enabled || activity === 'hidden'
      ? false
      : activity === 'focused'
        ? FOCUSED_INTERVALS[resource]
        : UNFOCUSED_INTERVALS[resource];

  return {
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    refetchOnReconnect: 'always',
    refetchOnWindowFocus: 'always',
  };
}
