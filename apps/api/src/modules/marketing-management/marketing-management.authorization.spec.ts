import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { MarketingEvidenceService } from './marketing-evidence.service.js';
import { MarketingMasterDataService } from './marketing-master-data.service.js';
import { MarketingPlanningService } from './marketing-planning.service.js';
import type { AdminPrismaService } from '../../database/admin-prisma.service.js';
import type { AdminAccessService } from '../admin/admin-access.service.js';

describe('marketing management authorization boundary', () => {
  it('denies every submodule before a database capability is acquired', async () => {
    const prisma = { withTenant: vi.fn() } as unknown as AdminPrismaService;
    const access = {
      requireDirectoryWrite: vi.fn(() => {
        throw new ForbiddenException('denied');
      }),
    } as unknown as AdminAccessService;
    const evidence = new MarketingEvidenceService(prisma, access);
    const masters = new MarketingMasterDataService(prisma, access);
    const planning = new MarketingPlanningService(prisma, access);

    await expect(evidence.listObservations()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(masters.list('PRODUCT')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(planning.listTargets()).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.withTenant).not.toHaveBeenCalled();
  });
});
