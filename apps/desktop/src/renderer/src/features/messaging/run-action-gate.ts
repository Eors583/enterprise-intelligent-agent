/**
 * A synchronous single-flight guard for user-triggered Run actions.
 *
 * React mutation state is updated on the next render, so it cannot by itself
 * prevent two clicks in the same event-loop turn from dispatching twice.
 */
export class RunActionGate {
  private activeToken: string | null = null;

  tryStart(token: string): boolean {
    if (this.activeToken !== null) return false;
    this.activeToken = token;
    return true;
  }

  finish(token: string): void {
    if (this.activeToken === token) this.activeToken = null;
  }

  reset(): void {
    this.activeToken = null;
  }

  get isBusy(): boolean {
    return this.activeToken !== null;
  }
}
