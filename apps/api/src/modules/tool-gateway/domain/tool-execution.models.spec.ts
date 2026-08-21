import { decideToolExecutionEvent, parseToolCommandEvent } from './tool-execution.models.js';

describe('Tool execution event recovery decision', () => {
  it('starts only the exact command revision that produced APPROVED', () => {
    expect(
      decideToolExecutionEvent({
        command: 'APPROVE',
        eventResultRevision: 4,
        currentStatus: 'APPROVED',
        currentRevision: 4,
        providerRequestId: null,
        providerDispatchAllowed: true,
        dryRun: false,
        dryRunMode: 'UNSUPPORTED',
      }),
    ).toEqual({ kind: 'ready' });
    expect(
      decideToolExecutionEvent({
        command: 'APPROVE',
        eventResultRevision: 3,
        currentStatus: 'APPROVED',
        currentRevision: 4,
        providerRequestId: null,
        providerDispatchAllowed: true,
        dryRun: false,
        dryRunMode: 'UNSUPPORTED',
      }),
    ).toEqual({ kind: 'skip', reasonCode: 'STALE_EXECUTION_EVENT' });
  });

  it('distinguishes the generated START ledger event from a crashed original dispatch', () => {
    expect(
      decideToolExecutionEvent({
        command: 'START',
        eventResultRevision: 5,
        currentStatus: 'EXECUTING',
        currentRevision: 5,
        providerRequestId: 'tool-provider:invocation',
        providerDispatchAllowed: true,
        dryRun: false,
        dryRunMode: 'UNSUPPORTED',
      }),
    ).toEqual({ kind: 'skip', reasonCode: 'EXECUTION_START_EVENT_RECORDED' });
    expect(
      decideToolExecutionEvent({
        command: 'APPROVE',
        eventResultRevision: 4,
        currentStatus: 'EXECUTING',
        currentRevision: 5,
        providerRequestId: 'tool-provider:invocation',
        providerDispatchAllowed: true,
        dryRun: false,
        dryRunMode: 'UNSUPPORTED',
      }),
    ).toEqual({ kind: 'ambiguous_dispatch' });
  });

  it('never dispatches validate-only dry runs or unrelated command ledger events', () => {
    expect(
      decideToolExecutionEvent({
        command: 'CONFIRM',
        eventResultRevision: 2,
        currentStatus: 'APPROVED',
        currentRevision: 2,
        providerRequestId: null,
        providerDispatchAllowed: false,
        dryRun: true,
        dryRunMode: 'VALIDATE_ONLY',
      }),
    ).toEqual({ kind: 'skip', reasonCode: 'STALE_EXECUTION_EVENT' });
    expect(
      decideToolExecutionEvent({
        command: 'SUCCEED',
        eventResultRevision: 6,
        currentStatus: 'SUCCEEDED',
        currentRevision: 6,
        providerRequestId: 'tool-provider:invocation',
        providerDispatchAllowed: true,
        dryRun: false,
        dryRunMode: 'UNSUPPORTED',
      }),
    ).toEqual({ kind: 'skip', reasonCode: 'COMMAND_DOES_NOT_START_EXECUTION' });
  });
});

describe('parseToolCommandEvent', () => {
  it('accepts only the versioned command payload with contiguous revisions', () => {
    expect(
      parseToolCommandEvent({
        schemaVersion: 1,
        commandId: '00000000-0000-7000-8000-000000000001',
        command: 'START',
        expectedRevision: 1,
        resultRevision: 2,
      }),
    ).toMatchObject({ command: 'START', resultRevision: 2 });
    expect(() =>
      parseToolCommandEvent({
        schemaVersion: 1,
        commandId: '00000000-0000-7000-8000-000000000001',
        command: 'START',
        expectedRevision: 1,
        resultRevision: 3,
      }),
    ).toThrow('TOOL_COMMAND_EVENT_MALFORMED');
  });
});
