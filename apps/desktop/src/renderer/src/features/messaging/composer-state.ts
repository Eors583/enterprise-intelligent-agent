import type { CreateMessageRequest } from '@enterprise/contracts';

export interface ComposerState {
  draft: string;
  failedRequest: CreateMessageRequest | null;
}

export type ComposerAction =
  | { type: 'reset' }
  | { type: 'draftChanged'; value: string }
  | { type: 'sendStarted' }
  | { type: 'sendFailed'; request: CreateMessageRequest }
  | { type: 'sendSucceeded'; request: CreateMessageRequest };

export const initialComposerState: ComposerState = {
  draft: '',
  failedRequest: null,
};

export function createClientMessageId(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error('当前运行环境不支持安全的消息 ID 生成');
  }
  return globalThis.crypto.randomUUID();
}

export function composerReducer(state: ComposerState, action: ComposerAction): ComposerState {
  switch (action.type) {
    case 'reset':
      return initialComposerState;
    case 'draftChanged':
      return { draft: action.value, failedRequest: null };
    case 'sendStarted':
      return { ...state, failedRequest: null };
    case 'sendFailed':
      return { ...state, failedRequest: action.request };
    case 'sendSucceeded':
      return {
        draft: state.draft.trim() === action.request.content.text ? '' : state.draft,
        failedRequest: null,
      };
  }
}
