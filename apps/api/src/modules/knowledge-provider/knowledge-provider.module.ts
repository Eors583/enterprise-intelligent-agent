import { createHash } from 'node:crypto';

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../config/environment.js';
import { AdminAccessModule } from '../admin/admin-access.module.js';
import { KnowledgeProviderConnectionService } from './application/knowledge-provider-connection.service.js';
import { KnowledgeProviderRetrievalService } from './application/knowledge-provider-retrieval.service.js';
import { KnowledgeProviderIdentityService } from './application/knowledge-provider-identity.service.js';
import { KnowledgeProviderSpaceService } from './application/knowledge-provider-space.service.js';
import { LexiangClient } from './infrastructure/lexiang/lexiang.client.js';
import { LexiangCredentialVault } from './infrastructure/lexiang/lexiang-credential-vault.js';
import { LexiangSpaceClient } from './infrastructure/lexiang/lexiang-space.client.js';
import { LexiangTokenProvider } from './infrastructure/lexiang/lexiang-token.provider.js';
import { KnowledgeProviderController } from './knowledge-provider.controller.js';

@Module({
  imports: [AdminAccessModule],
  controllers: [KnowledgeProviderController],
  providers: [
    KnowledgeProviderConnectionService,
    KnowledgeProviderIdentityService,
    KnowledgeProviderRetrievalService,
    KnowledgeProviderSpaceService,
    { provide: LexiangTokenProvider, useFactory: () => new LexiangTokenProvider() },
    {
      provide: LexiangClient,
      inject: [LexiangTokenProvider],
      useFactory: (tokens: LexiangTokenProvider) => new LexiangClient(tokens),
    },
    {
      provide: LexiangSpaceClient,
      inject: [LexiangTokenProvider],
      useFactory: (tokens: LexiangTokenProvider) => new LexiangSpaceClient(tokens),
    },
    {
      provide: LexiangCredentialVault,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => {
        const keys = new Map(
          Object.entries(config.get('CONNECTOR_CREDENTIAL_KEYRING', { infer: true })).map(
            ([keyId, encodedKey]) => [keyId, Buffer.from(encodedKey, 'base64url')],
          ),
        );
        let activeKeyId = config.get('CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID', { infer: true });
        if (activeKeyId === undefined) {
          activeKeyId = 'development-v1';
          keys.set(
            activeKeyId,
            createHash('sha256')
              .update('enterprise-agent:connector-credential:development:v1\0')
              .update(config.get('AUTH_TOKEN_PEPPER', { infer: true }))
              .digest(),
          );
        }
        return new LexiangCredentialVault(activeKeyId, keys);
      },
    },
  ],
  exports: [
    KnowledgeProviderConnectionService,
    KnowledgeProviderRetrievalService,
    KnowledgeProviderSpaceService,
  ],
})
export class KnowledgeProviderModule {}
