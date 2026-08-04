import { describe, expect, it } from 'vitest';

import { canAccessAdminConsole, canAccessAdvancedSettings, type TenantRole } from '../src/index.js';

describe('management navigation permissions', () => {
  it.each<[TenantRole, boolean]>([
    ['OWNER', true],
    ['ADMIN', true],
    ['KNOWLEDGE_ADMIN', true],
    ['MEMBER', false],
  ])('maps %s to admin-console access without relying on hidden navigation', (role, allowed) => {
    expect(canAccessAdminConsole(role)).toBe(allowed);
  });

  it.each<[TenantRole, boolean]>([
    ['OWNER', true],
    ['ADMIN', true],
    ['KNOWLEDGE_ADMIN', false],
    ['MEMBER', false],
  ])('maps %s to advanced-settings visibility', (role, allowed) => {
    expect(canAccessAdvancedSettings(role)).toBe(allowed);
  });
});
