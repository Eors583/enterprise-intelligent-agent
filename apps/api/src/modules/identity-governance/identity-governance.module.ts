import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { BreakGlassAdminController, BreakGlassController } from './break-glass.controller.js';
import { BreakGlassService } from './break-glass.service.js';
import { IdentityAccessController } from './identity-access.controller.js';
import { IdentityAccessService } from './identity-access.service.js';
import { IdentityGovernanceAdminController } from './identity-governance-admin.controller.js';
import { IdentityGovernanceAdminService } from './identity-governance-admin.service.js';
import { OidcAuthController } from './oidc-auth.controller.js';
import { OidcAuthService } from './oidc-auth.service.js';
import { OidcDiscoveryClient } from './oidc-discovery.client.js';
import { ScimController } from './scim.controller.js';
import { ScimService } from './scim.service.js';

@Module({
  imports: [AuthModule],
  controllers: [
    BreakGlassController,
    BreakGlassAdminController,
    IdentityAccessController,
    IdentityGovernanceAdminController,
    OidcAuthController,
    ScimController,
  ],
  providers: [
    BreakGlassService,
    IdentityAccessService,
    IdentityGovernanceAdminService,
    OidcAuthService,
    OidcDiscoveryClient,
    ScimService,
  ],
  exports: [BreakGlassService],
})
export class IdentityGovernanceModule {}
