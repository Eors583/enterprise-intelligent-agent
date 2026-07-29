import type { AgentRunStreamPage } from '@enterprise/contracts';

export type AgentRunStreamPhase =
  'idle' | 'replaying' | 'live' | 'offline' | 'terminal' | 'terminal_only';

export interface AgentRunStreamAccumulator {
  readonly content: string;
  readonly cursor: number;
  readonly caughtUp: boolean;
}

export function applyAgentRunStreamPage(
  state: AgentRunStreamAccumulator,
  page: AgentRunStreamPage,
): {
  readonly state: AgentRunStreamAccumulator;
  readonly phase: AgentRunStreamPhase;
} {
  let cursor = state.cursor;
  let content = state.content;
  for (const event of page.items) {
    if (event.sequence !== cursor + 1) {
      throw new Error('Agent Run stream replay is not contiguous.');
    }
    cursor = event.sequence;
    if (event.type === 'delta') content += event.delta;
  }
  const terminalEvent = [...page.items].reverse().find((event) => event.type !== 'delta');
  const phase: AgentRunStreamPhase =
    terminalEvent?.type === 'terminal_only'
      ? 'terminal_only'
      : page.terminal
        ? 'terminal'
        : state.caughtUp
          ? 'live'
          : 'replaying';
  return {
    state: { content, cursor, caughtUp: true },
    phase,
  };
}
