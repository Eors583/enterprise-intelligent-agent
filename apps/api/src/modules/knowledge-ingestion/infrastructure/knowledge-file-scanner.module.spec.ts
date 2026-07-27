import { ConfigService } from '@nestjs/config';

import { validateEnvironment, type EnvironmentVariables } from '../../../config/environment.js';
import { ClamAvKnowledgeFileScanner } from './clamav-knowledge-file.scanner.js';
import {
  DisabledKnowledgeFileScanner,
  type KnowledgeFileScanner,
} from './knowledge-file-scanner.js';
import { createKnowledgeFileScanner } from './knowledge-file-scanner.module.js';

describe('createKnowledgeFileScanner', () => {
  it('keeps the explicit not-scanned adapter as the non-production default', () => {
    expect(createKnowledgeFileScanner(config({ NODE_ENV: 'test' }))).toBeInstanceOf(
      DisabledKnowledgeFileScanner,
    );
  });

  it('constructs the real clamd INSTREAM adapter when configured', () => {
    expect(
      createKnowledgeFileScanner(
        config({
          NODE_ENV: 'test',
          KNOWLEDGE_FILE_SCANNER_DRIVER: 'clamav',
          KNOWLEDGE_FILE_SCANNER_CLAMAV_HOST: 'clamav.internal',
          KNOWLEDGE_FILE_SCANNER_CLAMAV_PORT: '13310',
        }),
      ),
    ).toBeInstanceOf(ClamAvKnowledgeFileScanner);
  });

  it('reuses the injected development scanner instance', () => {
    const disabled: KnowledgeFileScanner = new DisabledKnowledgeFileScanner();
    expect(createKnowledgeFileScanner(config({ NODE_ENV: 'test' }), disabled)).toBe(disabled);
  });
});

function config(source: Record<string, unknown>): ConfigService<EnvironmentVariables, true> {
  return new ConfigService<EnvironmentVariables, true>(validateEnvironment(source));
}
