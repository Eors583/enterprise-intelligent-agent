import { useSyncExternalStore } from 'react';
import type { WindowActivity } from './sync-policy';

function getWindowActivity(): WindowActivity {
  if (document.visibilityState === 'hidden') return 'hidden';
  return document.hasFocus() ? 'focused' : 'visible-unfocused';
}

function subscribeWindowActivity(onStoreChange: () => void): () => void {
  document.addEventListener('visibilitychange', onStoreChange);
  window.addEventListener('focus', onStoreChange);
  window.addEventListener('blur', onStoreChange);

  return () => {
    document.removeEventListener('visibilitychange', onStoreChange);
    window.removeEventListener('focus', onStoreChange);
    window.removeEventListener('blur', onStoreChange);
  };
}

export function useWindowActivity(): WindowActivity {
  return useSyncExternalStore(subscribeWindowActivity, getWindowActivity, () => 'hidden');
}
