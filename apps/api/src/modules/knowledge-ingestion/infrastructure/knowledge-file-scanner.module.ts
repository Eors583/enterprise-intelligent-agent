import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.js';
import { ClamAvKnowledgeFileScanner } from './clamav-knowledge-file.scanner.js';
import {
  KNOWLEDGE_FILE_SCANNER,
  DisabledKnowledgeFileScanner,
  KnowledgeFileScanner,
} from './knowledge-file-scanner.js';

@Module({
  providers: [
    DisabledKnowledgeFileScanner,
    {
      provide: KNOWLEDGE_FILE_SCANNER,
      inject: [ConfigService, DisabledKnowledgeFileScanner],
      useFactory: (
        config: ConfigService<EnvironmentVariables, true>,
        disabled: DisabledKnowledgeFileScanner,
      ): KnowledgeFileScanner => createKnowledgeFileScanner(config, disabled),
    },
    { provide: KnowledgeFileScanner, useExisting: KNOWLEDGE_FILE_SCANNER },
  ],
  exports: [KNOWLEDGE_FILE_SCANNER, KnowledgeFileScanner],
})
export class KnowledgeFileScannerModule {}

export function createKnowledgeFileScanner(
  config: ConfigService<EnvironmentVariables, true>,
  disabled = new DisabledKnowledgeFileScanner(),
): KnowledgeFileScanner {
  if (config.get('KNOWLEDGE_FILE_SCANNER_DRIVER', { infer: true }) === 'disabled') {
    return disabled;
  }
  return new ClamAvKnowledgeFileScanner({
    host: config.get('KNOWLEDGE_FILE_SCANNER_CLAMAV_HOST', { infer: true }),
    port: config.get('KNOWLEDGE_FILE_SCANNER_CLAMAV_PORT', { infer: true }),
    timeoutMs: config.get('KNOWLEDGE_FILE_SCANNER_TIMEOUT_MS', { infer: true }),
  });
}
