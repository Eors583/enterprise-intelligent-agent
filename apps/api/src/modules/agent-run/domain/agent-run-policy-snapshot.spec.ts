import { describe, expect, it } from 'vitest';

import {
  buildAgentRunPolicySnapshot,
  readControlledModelConnectivityProbeCatalogId,
  readPolicySnapshotAssignmentId,
  resolveAgentRunExecutionSnapshot,
} from './agent-run-policy-snapshot.js';

const VERSION_ID = '00000000-0000-7000-8000-000000000001';
const TEMPLATE_ID = '00000000-0000-7000-8000-000000000002';
const ASSIGNMENT_ID = '00000000-0000-7000-8000-000000000003';

describe('Agent Run policy snapshots', () => {
  it('captures assignment, role blueprint, version, and prompt evidence immutably', () => {
    const version = agentVersion();
    const snapshot = buildAgentRunPolicySnapshot({
      agentVersion: version,
      roleAssignment: {
        id: ASSIGNMENT_ID,
        roleTemplateId: TEMPLATE_ID,
        roleVersionId: VERSION_ID,
      },
    });

    expect(snapshot).toMatchObject({
      snapshotSchemaVersion: 2,
      agentVersionId: VERSION_ID,
      agentVersion: 7,
      systemPrompt: 'Only answer from approved HR policy.',
      systemPromptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      prompt: {
        version: 7,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      roleAssignmentId: ASSIGNMENT_ID,
      role: {
        templateId: TEMPLATE_ID,
        versionId: VERSION_ID,
        version: 7,
        blueprintRevision: 12,
        definition: { mission: 'Help employees safely.' },
      },
    });
    expect(readPolicySnapshotAssignmentId(snapshot)).toBe(ASSIGNMENT_ID);
    expect(resolveAgentRunExecutionSnapshot(snapshot, version)).toEqual({
      agentVersionId: VERSION_ID,
      agentVersion: 7,
      systemPrompt: 'Only answer from approved HR policy.',
      modelPolicy: { provider: 'internal' },
      knowledgeScope: { knowledgeBaseIds: ['kb-hr'] },
    });
  });

  it('rejects a versioned snapshot whose prompt no longer matches its hash', () => {
    const version = agentVersion();
    const snapshot = {
      ...buildAgentRunPolicySnapshot({ agentVersion: version }),
      systemPrompt: 'Tampered prompt',
    };

    expect(resolveAgentRunExecutionSnapshot(snapshot, version)).toBeNull();
  });

  it('pins a validated per-Agent knowledge binding into the immutable Run snapshot', () => {
    const version = agentVersion();
    const snapshot = buildAgentRunPolicySnapshot({
      agentVersion: version,
      knowledgeScopeOverride: { knowledgeBaseIds: ['kb-department'] },
    });

    expect(resolveAgentRunExecutionSnapshot(snapshot, version)).toMatchObject({
      knowledgeScope: { knowledgeBaseIds: ['kb-department'] },
    });
  });

  it('recognizes only a server-shaped controlled model connectivity probe marker', () => {
    const catalogVersionId = '00000000-0000-4000-8000-000000000004';
    const snapshot = buildAgentRunPolicySnapshot({
      agentVersion: agentVersion(),
      extra: {
        controlledModelConnectivityProbe: true,
        connectivityProbeCatalogVersionId: catalogVersionId,
      },
    });

    expect(readControlledModelConnectivityProbeCatalogId(snapshot)).toBe(catalogVersionId);
    expect(
      readControlledModelConnectivityProbeCatalogId({
        controlledModelConnectivityProbe: true,
        connectivityProbeCatalogVersionId: 'not-a-uuid',
      }),
    ).toBeNull();
    expect(
      readControlledModelConnectivityProbeCatalogId({
        controlledModelConnectivityProbe: false,
        connectivityProbeCatalogVersionId: catalogVersionId,
      }),
    ).toBeNull();
  });
});

function agentVersion() {
  return {
    id: VERSION_ID,
    templateId: TEMPLATE_ID,
    version: 7,
    systemPrompt: 'Only answer from approved HR policy.',
    modelPolicy: { provider: 'internal' },
    toolPolicy: { allowedTools: [] },
    knowledgeScope: { knowledgeBaseIds: ['kb-hr'] },
    blueprintRevision: 12,
    roleDefinitionSnapshot: { mission: 'Help employees safely.' },
    template: {
      id: TEMPLATE_ID,
      key: 'hr-specialist',
      name: 'HR specialist',
    },
  };
}
