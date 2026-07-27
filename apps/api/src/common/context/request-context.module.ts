import { Global, Module } from '@nestjs/common';

import { TenantContext } from './tenant-context.js';

@Global()
@Module({
  providers: [TenantContext],
  exports: [TenantContext],
})
export class RequestContextModule {}
