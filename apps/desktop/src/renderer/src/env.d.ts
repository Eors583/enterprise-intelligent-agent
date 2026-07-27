/// <reference types="vite/client" />

import type { DesktopBridge } from '../../shared/desktop-api';

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    enterpriseDesktop: DesktopBridge;
  }
}

export {};
