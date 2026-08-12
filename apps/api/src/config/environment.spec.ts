import { validateApiEnvironment, validateEnvironment } from './environment.js';

const CONNECTOR_CREDENTIAL_KEY = 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM';
const PRODUCTION_KMS_KEY_ARN =
  'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012';
const PRODUCTION_CONNECTOR_ENVIRONMENT = {
  CONNECTOR_CREDENTIAL_KEYRING_JSON: JSON.stringify({ primary: CONNECTOR_CREDENTIAL_KEY }),
  CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID: 'primary',
  IDENTITY_SECRET_KEYRING_JSON: JSON.stringify({ identity: CONNECTOR_CREDENTIAL_KEY }),
  IDENTITY_SECRET_ACTIVE_KEY_ID: 'identity',
  SCIM_DATABASE_URL: 'postgresql://scim@localhost/example',
} as const;

describe('validateEnvironment', () => {
  it('strips Manus provider credentials at the API process boundary', () => {
    const previous = process.env.MANUS_API_KEY;
    const previousOpenAi = process.env.AI_RUNTIME_OPENAI_API_KEY;
    process.env.MANUS_API_KEY = 'test-only-provider-secret';
    process.env.AI_RUNTIME_OPENAI_API_KEY = 'test-only-openai-secret';
    try {
      const configured = validateApiEnvironment({
        NODE_ENV: 'test',
        MANUS_API_KEY: 'dotenv-provider-secret',
        MANUS_API_BASE_URL: 'https://api.manus.example',
        AI_RUNTIME_OPENAI_API_KEY: 'dotenv-openai-secret',
      });
      expect(process.env.MANUS_API_KEY).toBeUndefined();
      expect(process.env.AI_RUNTIME_OPENAI_API_KEY).toBeUndefined();
      expect(Object.keys(configured)).not.toContain('MANUS_API_KEY');
      expect(Object.keys(configured)).not.toContain('MANUS_API_BASE_URL');
      expect(Object.keys(configured)).not.toContain('AI_RUNTIME_OPENAI_API_KEY');
    } finally {
      if (previous === undefined) delete process.env.MANUS_API_KEY;
      else process.env.MANUS_API_KEY = previous;
      if (previousOpenAi === undefined) delete process.env.AI_RUNTIME_OPENAI_API_KEY;
      else process.env.AI_RUNTIME_OPENAI_API_KEY = previousOpenAi;
    }
  });

  it('returns safe development defaults', () => {
    expect(validateEnvironment({ NODE_ENV: 'test' })).toMatchObject({
      NODE_ENV: 'test',
      PORT: 3000,
      REPOSITORY_DRIVER: 'memory',
      AUTH_LOGIN_RATE_LIMIT_ENABLED: false,
      AUTH_LOGIN_RATE_LIMIT_NETWORK_ENABLED: false,
      AUTH_LOGIN_RATE_LIMIT_ACCOUNT_FAILURES: 5,
      AUTH_LOGIN_RATE_LIMIT_NETWORK_FAILURES: 30,
      AUTH_RATE_LIMIT_BUCKET_CAPACITY_PER_SCOPE: 100_000,
      TRUST_PROXY_IDENTITY_HEADERS: false,
      IM_OUTBOX_ENABLED: false,
      IM_PROVIDER: 'local',
      IM_OUTBOX_MAX_ATTEMPTS: 8,
      AGENT_RUN_WORKER_CONCURRENCY: 4,
      TENCENT_IM_API_BASE_URL: 'https://console.tim.qq.com',
      TENCENT_IM_HTTP_TIMEOUT_MS: 5_000,
      KNOWLEDGE_OBJECT_STORE_DRIVER: 'local',
      KNOWLEDGE_OBJECT_STORE_MAX_BYTES: 52_428_800,
      KNOWLEDGE_OBJECT_STORE_S3_REGION: 'us-east-1',
      KNOWLEDGE_OBJECT_STORE_S3_CREDENTIAL_MODE: 'default_chain',
      KNOWLEDGE_OBJECT_STORE_S3_FORCE_PATH_STYLE: true,
      KNOWLEDGE_OBJECT_STORE_S3_PREFIX: 'knowledge/v1',
      KNOWLEDGE_FILE_SCANNER_DRIVER: 'disabled',
      FEISHU_DIRECTORY_SYNC_ENABLED: false,
      FEISHU_DIRECTORY_RECONCILE_REMOVALS: false,
      FEISHU_API_BASE_URL: 'https://open.feishu.cn',
      FEISHU_HTTP_TIMEOUT_MS: 10_000,
      FEISHU_SYNC_LEASE_MS: 1_800_000,
      FEISHU_SYNC_PREVIEW_TTL_MS: 900_000,
      FEISHU_SYNC_WORKER_ENABLED: false,
      FEISHU_SYNC_WORKER_POLL_INTERVAL_MS: 2_000,
      FEISHU_SYNC_WORKER_BATCH_SIZE: 2,
      FEISHU_SYNC_MAX_ATTEMPTS: 4,
      FEISHU_SYNC_RETRY_BASE_MS: 10_000,
      FEISHU_SYNC_RETRY_MAX_MS: 300_000,
    });
  });

  it('ignores the deprecated Feishu shared-password setting', () => {
    const configured = validateEnvironment({
      NODE_ENV: 'test',
      FEISHU_DIRECTORY_INITIAL_PASSWORD: 'legacy-shared-password',
    });
    expect(configured).not.toHaveProperty('FEISHU_DIRECTORY_INITIAL_PASSWORD');
  });

  it('validates a versioned connector credential keyring', () => {
    expect(
      validateEnvironment({
        NODE_ENV: 'test',
        ...PRODUCTION_CONNECTOR_ENVIRONMENT,
      }),
    ).toMatchObject({
      CONNECTOR_CREDENTIAL_KEYRING: { primary: CONNECTOR_CREDENTIAL_KEY },
      CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID: 'primary',
    });

    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        CONNECTOR_CREDENTIAL_KEYRING_JSON: '{"primary":"not-a-32-byte-key"}',
        CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID: 'primary',
      }),
    ).toThrow('base64url-encoded 32-byte key');
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        CONNECTOR_CREDENTIAL_KEYRING_JSON: JSON.stringify({
          primary: CONNECTOR_CREDENTIAL_KEY,
        }),
        CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID: 'missing',
      }),
    ).toThrow('must reference a key');
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        CONNECTOR_CREDENTIAL_KEYRING_JSON: JSON.stringify({
          primary: CONNECTOR_CREDENTIAL_KEY,
        }),
      }),
    ).toThrow('ACTIVE_KEY_ID is required');
  });

  it('requires the connector credential keyring in production', () => {
    const {
      CONNECTOR_CREDENTIAL_KEYRING_JSON: _keyring,
      CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID: _activeKey,
      ...withoutConnectorKeys
    } = productionKnowledgeEnvironment();
    expect(() => validateEnvironment(withoutConnectorKeys)).toThrow(
      'CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID is required in production',
    );
  });

  it('validates an independently rotatable identity-secret keyring', () => {
    expect(
      validateEnvironment({
        NODE_ENV: 'test',
        IDENTITY_SECRET_KEYRING_JSON: JSON.stringify({ current: CONNECTOR_CREDENTIAL_KEY }),
        IDENTITY_SECRET_ACTIVE_KEY_ID: 'current',
      }),
    ).toMatchObject({
      IDENTITY_SECRET_KEYRING: { current: CONNECTOR_CREDENTIAL_KEY },
      IDENTITY_SECRET_ACTIVE_KEY_ID: 'current',
    });
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        IDENTITY_SECRET_KEYRING_JSON: JSON.stringify({ current: CONNECTOR_CREDENTIAL_KEY }),
        IDENTITY_SECRET_ACTIVE_KEY_ID: 'missing',
      }),
    ).toThrow('must reference a key');
  });

  it('rejects wildcard CORS in production', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'production', CORS_ORIGINS: '*' })).toThrow(
      'CORS_ORIGINS cannot contain * in production.',
    );
  });

  it('requires a database URL for the Prisma adapter', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'test', REPOSITORY_DRIVER: 'prisma' })).toThrow(
      'DATABASE_URL is required',
    );
    expect(
      validateEnvironment({
        NODE_ENV: 'test',
        REPOSITORY_DRIVER: 'prisma',
        DATABASE_URL: 'postgresql://api@localhost/example',
      }).REPOSITORY_DRIVER,
    ).toBe('prisma');
  });

  it('requires an independent lifecycle database login in production', () => {
    const production = {
      NODE_ENV: 'production',
      ...PRODUCTION_CONNECTOR_ENVIRONMENT,
      REPOSITORY_DRIVER: 'prisma',
      DATABASE_URL: 'postgresql://api@localhost/example',
      AUTH_DATABASE_URL: 'postgresql://auth@localhost/example',
      ADMIN_DATABASE_URL: 'postgresql://admin@localhost/example',
      AUTH_TOKEN_PEPPER: 'production-test-token-pepper-at-least-32-characters',
      AUTH_PUBLIC_APP_URL: 'https://accounts.example.test',
    } as const;

    expect(() => validateEnvironment(production)).toThrow(
      'AUTH_DATABASE_URL, ADMIN_DATABASE_URL, LIFECYCLE_DATABASE_URL, and SCIM_DATABASE_URL are required',
    );
    expect(() =>
      validateEnvironment({
        ...production,
        LIFECYCLE_DATABASE_URL: 'postgresql://admin@localhost/example',
      }),
    ).toThrow(
      'DATABASE_URL, AUTH_DATABASE_URL, ADMIN_DATABASE_URL, LIFECYCLE_DATABASE_URL, and SCIM_DATABASE_URL must use different production usernames.',
    );
  });

  it('forbids the in-memory adapter in production', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        REPOSITORY_DRIVER: 'memory',
        AUTH_PUBLIC_APP_URL: 'https://accounts.example.test',
      }),
    ).toThrow('REPOSITORY_DRIVER=memory is forbidden in production.');
  });

  it('enforces distributed login throttling in production and validates its bounds', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        REPOSITORY_DRIVER: 'prisma',
        DATABASE_URL: 'postgresql://api@localhost/example',
        AUTH_DATABASE_URL: 'postgresql://auth@localhost/example',
        ADMIN_DATABASE_URL: 'postgresql://admin@localhost/example',
        AUTH_TOKEN_PEPPER: 'production-test-token-pepper-at-least-32-characters',
        AUTH_PUBLIC_APP_URL: 'https://accounts.example.test',
        AUTH_LOGIN_RATE_LIMIT_ENABLED: 'false',
      }),
    ).toThrow('AUTH_LOGIN_RATE_LIMIT_ENABLED cannot be disabled in production.');

    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        REPOSITORY_DRIVER: 'prisma',
        DATABASE_URL: 'postgresql://api@localhost/example',
        AUTH_DATABASE_URL: 'postgresql://auth@localhost/example',
        ADMIN_DATABASE_URL: 'postgresql://admin@localhost/example',
        AUTH_TOKEN_PEPPER: 'production-test-token-pepper-at-least-32-characters',
        AUTH_PUBLIC_APP_URL: 'https://accounts.example.test',
        AUTH_LOGIN_RATE_LIMIT_NETWORK_ENABLED: 'false',
      }),
    ).toThrow('AUTH_LOGIN_RATE_LIMIT_NETWORK_ENABLED cannot be disabled in production.');

    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        AUTH_LOGIN_RATE_LIMIT_ACCOUNT_FAILURES: '10',
        AUTH_LOGIN_RATE_LIMIT_NETWORK_FAILURES: '5',
      }),
    ).toThrow(
      'AUTH_LOGIN_RATE_LIMIT_NETWORK_FAILURES must be greater than or equal to AUTH_LOGIN_RATE_LIMIT_ACCOUNT_FAILURES.',
    );
  });

  it('enables network throttling by default for production Prisma and bounds scope capacity', () => {
    const production = {
      NODE_ENV: 'production',
      ...PRODUCTION_CONNECTOR_ENVIRONMENT,
      REPOSITORY_DRIVER: 'prisma',
      DATABASE_URL: 'postgresql://api@localhost/example',
      AUTH_DATABASE_URL: 'postgresql://auth@localhost/example',
      ADMIN_DATABASE_URL: 'postgresql://admin@localhost/example',
      LIFECYCLE_DATABASE_URL: 'postgresql://lifecycle@localhost/example',
      AUTH_TOKEN_PEPPER: 'production-test-token-pepper-at-least-32-characters',
      AUTH_PUBLIC_APP_URL: 'https://accounts.example.test',
      AUTH_RECOVERY_EMAIL_PROVIDER: 'resend',
      AUTH_RECOVERY_EMAIL_API_KEY: 'server-only-resend-key',
      AUTH_RECOVERY_EMAIL_FROM: 'WorkMind <no-reply@example.test>',
      KNOWLEDGE_OBJECT_STORE_DRIVER: 's3',
      KNOWLEDGE_OBJECT_STORE_S3_BUCKET: 'enterprise-knowledge',
      KNOWLEDGE_OBJECT_STORE_S3_CREDENTIAL_MODE: 'default_chain',
      KNOWLEDGE_OBJECT_STORE_S3_KMS_KEY_ID: PRODUCTION_KMS_KEY_ARN,
      KNOWLEDGE_FILE_SCANNER_DRIVER: 'clamav',
      KNOWLEDGE_DOCUMENT_PARSER_DRIVER: 'docling',
      KNOWLEDGE_DOCLING_BASE_URL: 'https://docling.example.test',
      KNOWLEDGE_DOCLING_API_KEY: 'server-only-docling-key',
      KNOWLEDGE_WEB_IMPORT_ALLOWED_HOSTS: 'docs.example.test',
    } as const;

    expect(validateEnvironment(production)).toMatchObject({
      AUTH_LOGIN_RATE_LIMIT_ENABLED: true,
      AUTH_LOGIN_RATE_LIMIT_NETWORK_ENABLED: true,
      AUTH_RATE_LIMIT_BUCKET_CAPACITY_PER_SCOPE: 100_000,
    });
    expect(() =>
      validateEnvironment({ ...production, AUTH_RATE_LIMIT_BUCKET_CAPACITY_PER_SCOPE: '99' }),
    ).toThrow(
      'AUTH_RATE_LIMIT_BUCKET_CAPACITY_PER_SCOPE must be an integer between 100 and 1000000.',
    );
  });

  it('requires a fully configured Resend provider for production account recovery', () => {
    const production = {
      NODE_ENV: 'production',
      ...PRODUCTION_CONNECTOR_ENVIRONMENT,
      REPOSITORY_DRIVER: 'prisma',
      DATABASE_URL: 'postgresql://api@localhost/example',
      AUTH_DATABASE_URL: 'postgresql://auth@localhost/example',
      ADMIN_DATABASE_URL: 'postgresql://admin@localhost/example',
      LIFECYCLE_DATABASE_URL: 'postgresql://lifecycle@localhost/example',
      AUTH_TOKEN_PEPPER: 'production-test-token-pepper-at-least-32-characters',
      AUTH_PUBLIC_APP_URL: 'https://accounts.example.test',
      KNOWLEDGE_OBJECT_STORE_DRIVER: 's3',
      KNOWLEDGE_OBJECT_STORE_S3_BUCKET: 'enterprise-knowledge',
      KNOWLEDGE_OBJECT_STORE_S3_CREDENTIAL_MODE: 'default_chain',
      KNOWLEDGE_OBJECT_STORE_S3_KMS_KEY_ID: PRODUCTION_KMS_KEY_ARN,
      KNOWLEDGE_FILE_SCANNER_DRIVER: 'clamav',
      KNOWLEDGE_DOCUMENT_PARSER_DRIVER: 'docling',
      KNOWLEDGE_DOCLING_BASE_URL: 'https://docling.example.test',
      KNOWLEDGE_DOCLING_API_KEY: 'server-only-docling-key',
      KNOWLEDGE_WEB_IMPORT_ALLOWED_HOSTS: 'docs.example.test',
    } as const;

    expect(() => validateEnvironment(production)).toThrow(
      'AUTH_RECOVERY_EMAIL_PROVIDER must be resend in production.',
    );
    expect(() =>
      validateEnvironment({ ...production, AUTH_RECOVERY_EMAIL_PROVIDER: 'disabled' }),
    ).toThrow('AUTH_RECOVERY_EMAIL_PROVIDER must be resend in production.');
    expect(() =>
      validateEnvironment({
        ...production,
        AUTH_RECOVERY_EMAIL_PROVIDER: 'resend',
        AUTH_RECOVERY_EMAIL_API_KEY: 'server-only-resend-key',
      }),
    ).toThrow(
      'AUTH_RECOVERY_EMAIL_API_KEY and AUTH_RECOVERY_EMAIL_FROM are required when AUTH_RECOVERY_EMAIL_PROVIDER=resend.',
    );

    expect(
      validateEnvironment({
        ...production,
        AUTH_RECOVERY_EMAIL_PROVIDER: 'resend',
        AUTH_RECOVERY_EMAIL_API_KEY: 'server-only-resend-key',
        AUTH_RECOVERY_EMAIL_FROM: 'WorkMind <no-reply@example.test>',
      }),
    ).toMatchObject({
      AUTH_RECOVERY_EMAIL_PROVIDER: 'resend',
      AUTH_RECOVERY_EMAIL_API_KEY: 'server-only-resend-key',
      AUTH_RECOVERY_EMAIL_FROM: 'WorkMind <no-reply@example.test>',
    });
  });

  it('allows local HTTP recovery only outside production', () => {
    expect(
      validateEnvironment({
        NODE_ENV: 'development',
        AUTH_PUBLIC_APP_URL: 'http://127.0.0.1:4173',
      }).AUTH_PUBLIC_APP_URL,
    ).toBe('http://127.0.0.1:4173');
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        AUTH_PUBLIC_APP_URL: 'http://127.0.0.1:4173',
      }),
    ).toThrow('AUTH_PUBLIC_APP_URL must be an HTTPS origin');
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'development',
        AUTH_PUBLIC_APP_URL: 'http://accounts.example.test',
      }),
    ).toThrow('AUTH_PUBLIC_APP_URL must be an HTTPS origin');
  });

  it('accepts the repository-level environment aliases', () => {
    expect(
      validateEnvironment({
        NODE_ENV: 'test',
        API_PORT: '3200',
        API_HOST: '0.0.0.0',
        API_CORS_ORIGINS: 'http://localhost:4173',
        DEFAULT_TENANT_ID: '00000000-0000-7000-8000-000000000009',
      }),
    ).toMatchObject({
      PORT: 3200,
      HOST: '0.0.0.0',
      CORS_ORIGINS: ['http://localhost:4173'],
      DEV_TENANT_ID: '00000000-0000-7000-8000-000000000009',
    });
  });

  it('enables the local worker by default only for development Prisma', () => {
    expect(
      validateEnvironment({
        NODE_ENV: 'development',
        REPOSITORY_DRIVER: 'prisma',
        DATABASE_URL: 'postgresql://localhost/example',
      }).IM_OUTBOX_ENABLED,
    ).toBe(true);
    expect(
      validateEnvironment({
        NODE_ENV: 'test',
        REPOSITORY_DRIVER: 'prisma',
        DATABASE_URL: 'postgresql://localhost/example',
      }).IM_OUTBOX_ENABLED,
    ).toBe(false);
  });

  it('requires Prisma and safe timing bounds for an enabled worker', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'test', IM_OUTBOX_ENABLED: 'true' })).toThrow(
      'IM_OUTBOX_ENABLED=true requires REPOSITORY_DRIVER=prisma.',
    );
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        REPOSITORY_DRIVER: 'prisma',
        DATABASE_URL: 'postgresql://localhost/example',
        IM_OUTBOX_ENABLED: 'true',
        IM_PROVIDER_TIMEOUT_MS: '30000',
        IM_OUTBOX_CLAIM_TTL_MS: '30000',
      }),
    ).toThrow('IM_OUTBOX_CLAIM_TTL_MS must be greater than IM_PROVIDER_TIMEOUT_MS.');
  });

  it('requires Prisma and safe retry/lease bounds for knowledge ingestion workers', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        KNOWLEDGE_INGESTION_WORKER_ENABLED: 'true',
      }),
    ).toThrow('KNOWLEDGE_INGESTION_WORKER_ENABLED=true requires REPOSITORY_DRIVER=prisma.');

    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        KNOWLEDGE_INGESTION_RETRY_BASE_MS: '60001',
        KNOWLEDGE_INGESTION_RETRY_MAX_MS: '60000',
      }),
    ).toThrow(
      'KNOWLEDGE_INGESTION_RETRY_BASE_MS must not exceed KNOWLEDGE_INGESTION_RETRY_MAX_MS.',
    );

    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        KNOWLEDGE_AI_TIMEOUT_MS: '30000',
        KNOWLEDGE_INGESTION_CLAIM_TTL_MS: '45000',
      }),
    ).toThrow('KNOWLEDGE_INGESTION_CLAIM_TTL_MS must exceed KNOWLEDGE_AI_TIMEOUT_MS');
  });

  it('fails fast when production persistent knowledge writes have no consumer', () => {
    expect(() =>
      validateEnvironment({
        ...productionKnowledgeEnvironment(),
        KNOWLEDGE_PERSISTENT_WRITES_ENABLED: 'true',
      }),
    ).toThrow(
      'KNOWLEDGE_PERSISTENT_WRITES_ENABLED=true requires KNOWLEDGE_INGESTION_WORKER_ENABLED=true in production.',
    );

    expect(
      validateEnvironment({
        ...productionKnowledgeEnvironment(),
        KNOWLEDGE_PERSISTENT_WRITES_ENABLED: 'true',
        KNOWLEDGE_INGESTION_WORKER_ENABLED: 'true',
        OUTBOX_DATABASE_URL: 'postgresql://outbox@localhost/example',
      }),
    ).toMatchObject({
      KNOWLEDGE_PERSISTENT_WRITES_ENABLED: true,
      KNOWLEDGE_INGESTION_WORKER_ENABLED: true,
    });
  });

  it('keeps persistent writes opt-in in production and convenient for non-production Prisma', () => {
    expect(validateEnvironment(productionKnowledgeEnvironment())).toMatchObject({
      KNOWLEDGE_PERSISTENT_WRITES_ENABLED: false,
      KNOWLEDGE_INGESTION_WORKER_ENABLED: false,
    });
    expect(
      validateEnvironment({
        NODE_ENV: 'test',
        REPOSITORY_DRIVER: 'prisma',
        DATABASE_URL: 'postgresql://api@localhost/example',
      }),
    ).toMatchObject({
      KNOWLEDGE_PERSISTENT_WRITES_ENABLED: true,
      KNOWLEDGE_INGESTION_WORKER_ENABLED: false,
    });
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        KNOWLEDGE_PERSISTENT_WRITES_ENABLED: 'true',
      }),
    ).toThrow('KNOWLEDGE_PERSISTENT_WRITES_ENABLED=true requires REPOSITORY_DRIVER=prisma.');
  });

  it('never permits the local provider for an enabled production worker', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        ...PRODUCTION_CONNECTOR_ENVIRONMENT,
        REPOSITORY_DRIVER: 'prisma',
        DATABASE_URL: 'postgresql://api@localhost/example',
        OUTBOX_DATABASE_URL: 'postgresql://outbox@localhost/example',
        AUTH_DATABASE_URL: 'postgresql://auth@localhost/example',
        ADMIN_DATABASE_URL: 'postgresql://admin@localhost/example',
        LIFECYCLE_DATABASE_URL: 'postgresql://lifecycle@localhost/example',
        AUTH_TOKEN_PEPPER: 'production-test-token-pepper-at-least-32-characters',
        AUTH_PUBLIC_APP_URL: 'https://accounts.example.test',
        IM_OUTBOX_ENABLED: 'true',
        IM_PROVIDER: 'local',
      }),
    ).toThrow('IM_PROVIDER=local is forbidden');
  });

  it('requires a distinct worker login in production', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        ...PRODUCTION_CONNECTOR_ENVIRONMENT,
        REPOSITORY_DRIVER: 'prisma',
        DATABASE_URL: 'postgresql://api@localhost/example',
        AUTH_PUBLIC_APP_URL: 'https://accounts.example.test',
        IM_OUTBOX_ENABLED: 'true',
      }),
    ).toThrow('OUTBOX_DATABASE_URL is required');
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        ...PRODUCTION_CONNECTOR_ENVIRONMENT,
        REPOSITORY_DRIVER: 'prisma',
        DATABASE_URL: 'postgresql://api@localhost/example',
        OUTBOX_DATABASE_URL: 'postgresql://api@localhost/example',
        AUTH_PUBLIC_APP_URL: 'https://accounts.example.test',
        IM_OUTBOX_ENABLED: 'true',
      }),
    ).toThrow('OUTBOX_DATABASE_URL must use a different production username');

    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        ...PRODUCTION_CONNECTOR_ENVIRONMENT,
        REPOSITORY_DRIVER: 'prisma',
        DATABASE_URL: 'postgresql://api:one@localhost/example?schema=public',
        OUTBOX_DATABASE_URL: 'postgresql://api:two@other-host/example?sslmode=require',
        AUTH_PUBLIC_APP_URL: 'https://accounts.example.test',
        IM_OUTBOX_ENABLED: 'true',
      }),
    ).toThrow('OUTBOX_DATABASE_URL must use a different production username');
  });

  it.each([
    ['ADMIN_DATABASE_URL', 'postgresql://admin@localhost/example'],
    ['LIFECYCLE_DATABASE_URL', 'postgresql://lifecycle@localhost/example'],
  ])('does not let OUTBOX_DATABASE_URL reuse %s', (_capability, outboxDatabaseUrl) => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        ...PRODUCTION_CONNECTOR_ENVIRONMENT,
        REPOSITORY_DRIVER: 'prisma',
        DATABASE_URL: 'postgresql://api@localhost/example',
        OUTBOX_DATABASE_URL: outboxDatabaseUrl,
        AUTH_DATABASE_URL: 'postgresql://auth@localhost/example',
        ADMIN_DATABASE_URL: 'postgresql://admin@localhost/example',
        LIFECYCLE_DATABASE_URL: 'postgresql://lifecycle@localhost/example',
        AUTH_TOKEN_PEPPER: 'production-test-token-pepper-at-least-32-characters',
        AUTH_PUBLIC_APP_URL: 'https://accounts.example.test',
        IM_OUTBOX_ENABLED: 'true',
      }),
    ).toThrow('OUTBOX_DATABASE_URL must use a different production username');
  });

  it('requires complete Tencent credentials when the provider is selected', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'test', IM_PROVIDER: 'tencent' })).toThrow(
      'TENCENT_IM_SDK_APP_ID is required',
    );
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        IM_PROVIDER: 'tencent',
        TENCENT_IM_SDK_APP_ID: '1400000001',
      }),
    ).toThrow('TENCENT_IM_ADMIN_USER_ID');
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        IM_PROVIDER: 'tencent',
        TENCENT_IM_SDK_APP_ID: '1400000001',
        TENCENT_IM_ADMIN_USER_ID: 'administrator',
      }),
    ).toThrow('TENCENT_IM_SECRET_KEY is required');
  });

  it('accepts complete Tencent settings and rejects non-official endpoints', () => {
    const configured = validateEnvironment({
      NODE_ENV: 'test',
      IM_PROVIDER: 'tencent',
      TENCENT_IM_SDK_APP_ID: '1400000001',
      TENCENT_IM_ADMIN_USER_ID: 'administrator',
      TENCENT_IM_SECRET_KEY: 'server-side-secret',
      TENCENT_IM_API_BASE_URL: 'https://adminapisgp.im.qcloud.com',
    });
    expect(configured).toMatchObject({
      IM_PROVIDER: 'tencent',
      TENCENT_IM_SDK_APP_ID: 1_400_000_001,
      TENCENT_IM_ADMIN_USER_ID: 'administrator',
      TENCENT_IM_API_BASE_URL: 'https://adminapisgp.im.qcloud.com',
    });

    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        IM_PROVIDER: 'tencent',
        TENCENT_IM_SDK_APP_ID: '1400000001',
        TENCENT_IM_ADMIN_USER_ID: 'administrator',
        TENCENT_IM_SECRET_KEY: 'server-side-secret',
        TENCENT_IM_API_BASE_URL: 'https://example.com',
      }),
    ).toThrow('allowlisted Tencent IM HTTPS host');
  });

  it('keeps the Tencent request timeout inside the worker timeout', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        REPOSITORY_DRIVER: 'prisma',
        DATABASE_URL: 'postgresql://api@localhost/example',
        IM_OUTBOX_ENABLED: 'true',
        IM_PROVIDER: 'tencent',
        TENCENT_IM_SDK_APP_ID: '1400000001',
        TENCENT_IM_ADMIN_USER_ID: 'administrator',
        TENCENT_IM_SECRET_KEY: 'server-side-secret',
        TENCENT_IM_HTTP_TIMEOUT_MS: '10000',
        IM_PROVIDER_TIMEOUT_MS: '10000',
      }),
    ).toThrow('TENCENT_IM_HTTP_TIMEOUT_MS must be less than IM_PROVIDER_TIMEOUT_MS');
  });

  it('requires secure WuKongIM credentials and origins', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'test', IM_PROVIDER: 'wukong' })).toThrow(
      'WUKONG_IM_TOKEN_SIGNING_SECRET is required',
    );
    const configured = validateEnvironment({
      NODE_ENV: 'test',
      IM_PROVIDER: 'wukong',
      WUKONG_IM_TOKEN_SIGNING_SECRET: 'test-signing-secret-value',
      WUKONG_IM_API_BASE_URL: 'http://127.0.0.1:5501',
      WUKONG_IM_PUBLIC_WS_URL: 'ws://127.0.0.1:5520',
    });
    expect(configured).toMatchObject({
      IM_PROVIDER: 'wukong',
      WUKONG_IM_API_BASE_URL: 'http://127.0.0.1:5501',
      WUKONG_IM_PUBLIC_WS_URL: 'ws://127.0.0.1:5520',
      WUKONG_IM_HTTP_TIMEOUT_MS: 5_000,
    });
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        IM_PROVIDER: 'wukong',
        WUKONG_IM_TOKEN_SIGNING_SECRET: 'test-signing-secret-value',
        WUKONG_IM_API_BASE_URL: 'http://example.com',
      }),
    ).toThrow('loopback HTTP');
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        IM_PROVIDER: 'wukong',
        WUKONG_IM_TOKEN_SIGNING_SECRET: 'test-signing-secret-value',
        WUKONG_IM_PUBLIC_WS_URL: 'ws://example.com',
      }),
    ).toThrow('loopback WS');
  });

  it('blocks production WuKongIM until upstream and proxy authentication are verified', () => {
    const production = {
      ...productionKnowledgeEnvironment(),
      IM_PROVIDER: 'wukong',
      WUKONG_IM_API_BASE_URL: 'https://im-internal.example.test',
      WUKONG_IM_PUBLIC_WS_URL: 'wss://im.example.test',
      WUKONG_IM_API_TOKEN: 'authenticated-internal-proxy-token',
      WUKONG_IM_TOKEN_SIGNING_SECRET: 'production-wukong-signing-secret-at-least-32-characters',
    };
    expect(() => validateEnvironment(production)).toThrow(
      'WUKONG_IM_VERIFIED_AUTH_ENABLED=true is required',
    );
    expect(
      validateEnvironment({ ...production, WUKONG_IM_VERIFIED_AUTH_ENABLED: 'true' }),
    ).toMatchObject({
      IM_PROVIDER: 'wukong',
      WUKONG_IM_VERIFIED_AUTH_ENABLED: true,
    });
  });

  it('requires Prisma and complete server-side credentials for Feishu directory sync', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        FEISHU_DIRECTORY_SYNC_ENABLED: 'true',
      }),
    ).toThrow('FEISHU_DIRECTORY_SYNC_ENABLED=true requires REPOSITORY_DRIVER=prisma.');

    const prisma = {
      NODE_ENV: 'test',
      REPOSITORY_DRIVER: 'prisma',
      DATABASE_URL: 'postgresql://api@localhost/example',
      FEISHU_DIRECTORY_SYNC_ENABLED: 'true',
    } as const;
    expect(() => validateEnvironment(prisma)).toThrow(
      'FEISHU_DIRECTORY_TARGET_TENANT_SLUG is required',
    );
    expect(() =>
      validateEnvironment({
        ...prisma,
        FEISHU_DIRECTORY_TARGET_TENANT_SLUG: 'future-collaboration',
      }),
    ).toThrow('FEISHU_APP_ID is required');
    expect(() =>
      validateEnvironment({
        ...prisma,
        FEISHU_DIRECTORY_TARGET_TENANT_SLUG: 'future-collaboration',
        FEISHU_APP_ID: 'cli_test',
      }),
    ).toThrow('FEISHU_APP_SECRET is required');
  });

  it('accepts complete Feishu settings and normalizes the target tenant slug', () => {
    expect(
      validateEnvironment({
        NODE_ENV: 'test',
        REPOSITORY_DRIVER: 'prisma',
        DATABASE_URL: 'postgresql://api@localhost/example',
        FEISHU_DIRECTORY_SYNC_ENABLED: 'true',
        FEISHU_DIRECTORY_TARGET_TENANT_SLUG: 'Future-Collaboration',
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'server-side-secret',
        FEISHU_API_BASE_URL: 'https://open.feishu.cn/',
        FEISHU_HTTP_TIMEOUT_MS: '12000',
        FEISHU_SYNC_LEASE_MS: '900000',
      }),
    ).toMatchObject({
      FEISHU_DIRECTORY_SYNC_ENABLED: true,
      FEISHU_DIRECTORY_TARGET_TENANT_SLUG: 'future-collaboration',
      FEISHU_APP_ID: 'cli_test',
      FEISHU_APP_SECRET: 'server-side-secret',
      FEISHU_API_BASE_URL: 'https://open.feishu.cn',
      FEISHU_HTTP_TIMEOUT_MS: 12_000,
      FEISHU_SYNC_LEASE_MS: 900_000,
    });
  });

  it('only permits the official Feishu HTTPS origin', () => {
    for (const baseUrl of [
      'http://open.feishu.cn',
      'https://open.feishu.cn.example.com',
      'https://api.example.com',
      'https://open.feishu.cn/open-apis',
    ]) {
      expect(() => validateEnvironment({ NODE_ENV: 'test', FEISHU_API_BASE_URL: baseUrl })).toThrow(
        'FEISHU_API_BASE_URL must be exactly https://open.feishu.cn.',
      );
    }
  });

  it('requires a valid target slug and a lease longer than one Feishu HTTP request', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        FEISHU_DIRECTORY_TARGET_TENANT_SLUG: 'invalid tenant',
      }),
    ).toThrow('FEISHU_DIRECTORY_TARGET_TENANT_SLUG must be 3-80 lowercase characters');

    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        REPOSITORY_DRIVER: 'prisma',
        DATABASE_URL: 'postgresql://api@localhost/example',
        FEISHU_DIRECTORY_SYNC_ENABLED: 'true',
        FEISHU_DIRECTORY_TARGET_TENANT_SLUG: 'future-collaboration',
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'server-side-secret',
        FEISHU_HTTP_TIMEOUT_MS: '10000',
        FEISHU_SYNC_LEASE_MS: '10000',
      }),
    ).toThrow('FEISHU_SYNC_LEASE_MS must be an integer between 900000 and 3600000.');
  });

  it('supports default-chain identity and static MinIO credentials without mixing them', () => {
    expect(
      validateEnvironment({
        NODE_ENV: 'test',
        KNOWLEDGE_OBJECT_STORE_DRIVER: 's3',
        KNOWLEDGE_OBJECT_STORE_S3_BUCKET: 'enterprise-knowledge',
        KNOWLEDGE_OBJECT_STORE_S3_CREDENTIAL_MODE: 'default_chain',
      }),
    ).toMatchObject({
      KNOWLEDGE_OBJECT_STORE_DRIVER: 's3',
      KNOWLEDGE_OBJECT_STORE_S3_CREDENTIAL_MODE: 'default_chain',
    });

    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        KNOWLEDGE_OBJECT_STORE_DRIVER: 's3',
        KNOWLEDGE_OBJECT_STORE_S3_BUCKET: 'enterprise-knowledge',
        KNOWLEDGE_OBJECT_STORE_S3_CREDENTIAL_MODE: 'static',
      }),
    ).toThrow('are required in static credential mode');

    expect(
      validateEnvironment({
        NODE_ENV: 'test',
        KNOWLEDGE_OBJECT_STORE_DRIVER: 's3',
        KNOWLEDGE_OBJECT_STORE_S3_ENDPOINT: 'http://127.0.0.1:9000',
        KNOWLEDGE_OBJECT_STORE_S3_BUCKET: 'enterprise-knowledge',
        KNOWLEDGE_OBJECT_STORE_S3_CREDENTIAL_MODE: 'static',
        KNOWLEDGE_OBJECT_STORE_S3_ACCESS_KEY_ID: 'minio-access',
        KNOWLEDGE_OBJECT_STORE_S3_SECRET_ACCESS_KEY: 'minio-secret',
      }),
    ).toMatchObject({
      KNOWLEDGE_OBJECT_STORE_S3_ENDPOINT: 'http://127.0.0.1:9000',
      KNOWLEDGE_OBJECT_STORE_S3_CREDENTIAL_MODE: 'static',
    });

    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        KNOWLEDGE_OBJECT_STORE_DRIVER: 's3',
        KNOWLEDGE_OBJECT_STORE_S3_BUCKET: 'enterprise-knowledge',
        KNOWLEDGE_OBJECT_STORE_S3_CREDENTIAL_MODE: 'default_chain',
        KNOWLEDGE_OBJECT_STORE_S3_ACCESS_KEY_ID: 'unexpected-access',
        KNOWLEDGE_OBJECT_STORE_S3_SECRET_ACCESS_KEY: 'unexpected-secret',
      }),
    ).toThrow('Static S3 credentials must not be set');
  });

  it('requires a region-matched customer-managed KMS key ARN for production S3', () => {
    const withoutKms = productionKnowledgeEnvironment();
    delete withoutKms.KNOWLEDGE_OBJECT_STORE_S3_KMS_KEY_ID;
    expect(() => validateEnvironment(withoutKms)).toThrow(
      'KNOWLEDGE_OBJECT_STORE_S3_KMS_KEY_ID is required',
    );

    expect(() =>
      validateEnvironment({
        ...productionKnowledgeEnvironment(),
        KNOWLEDGE_OBJECT_STORE_S3_KMS_KEY_ID: 'alias/enterprise-knowledge',
      }),
    ).toThrow('must be a customer-managed KMS key ARN in production');

    expect(() =>
      validateEnvironment({
        ...productionKnowledgeEnvironment(),
        KNOWLEDGE_OBJECT_STORE_S3_KMS_KEY_ID:
          'arn:aws:kms:eu-west-1:123456789012:key/12345678-1234-1234-1234-123456789012',
      }),
    ).toThrow('must match KNOWLEDGE_OBJECT_STORE_S3_REGION');

    expect(
      validateEnvironment({
        NODE_ENV: 'test',
        KNOWLEDGE_OBJECT_STORE_DRIVER: 's3',
        KNOWLEDGE_OBJECT_STORE_S3_BUCKET: 'enterprise-knowledge',
        KNOWLEDGE_OBJECT_STORE_S3_KMS_KEY_ID: 'alias/local-development-key',
      }),
    ).toMatchObject({
      KNOWLEDGE_OBJECT_STORE_S3_KMS_KEY_ID: 'alias/local-development-key',
    });
  });

  it('forbids local object storage and disabled malware scanning in production', () => {
    expect(() =>
      validateEnvironment({
        ...productionKnowledgeEnvironment(),
        KNOWLEDGE_OBJECT_STORE_DRIVER: 'local',
      }),
    ).toThrow('KNOWLEDGE_OBJECT_STORE_DRIVER=local is forbidden in production.');

    expect(() =>
      validateEnvironment({
        ...productionKnowledgeEnvironment(),
        KNOWLEDGE_FILE_SCANNER_DRIVER: 'disabled',
      }),
    ).toThrow('KNOWLEDGE_FILE_SCANNER_DRIVER=disabled is forbidden in production.');
  });

  it('requires safe object-store paths, origins, buckets, prefixes, and size bounds', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        KNOWLEDGE_OBJECT_STORE_LOCAL_ROOT: '.data/knowledge',
      }),
    ).toThrow('KNOWLEDGE_OBJECT_STORE_LOCAL_ROOT must be an absolute path.');
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        KNOWLEDGE_OBJECT_STORE_S3_BUCKET: 'Invalid_Bucket',
      }),
    ).toThrow('not a valid DNS-style bucket name');
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        KNOWLEDGE_OBJECT_STORE_S3_PREFIX: '../knowledge',
      }),
    ).toThrow('contains an unsafe path segment');
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        KNOWLEDGE_OBJECT_STORE_MAX_BYTES: '1024',
      }),
    ).toThrow('must be an integer between 1048576 and 2147483647');
    expect(() =>
      validateEnvironment({
        ...productionKnowledgeEnvironment(),
        KNOWLEDGE_OBJECT_STORE_S3_ENDPOINT: 'http://minio.internal:9000',
      }),
    ).toThrow('must be an HTTPS origin');
  });

  it('requires service authentication for production AI Runtime access', () => {
    expect(() =>
      validateEnvironment({
        ...productionKnowledgeEnvironment(),
        KNOWLEDGE_SEMANTIC_SEARCH_ENABLED: 'true',
      }),
    ).toThrow('AI_RUNTIME_SERVICE_TOKEN must contain at least 32 characters');

    expect(
      validateEnvironment({
        ...productionKnowledgeEnvironment(),
        KNOWLEDGE_SEMANTIC_SEARCH_ENABLED: 'true',
        AI_RUNTIME_SERVICE_TOKEN: 'runtime-service-token-at-least-32-characters',
      }).AI_RUNTIME_SERVICE_TOKEN,
    ).toBe('runtime-service-token-at-least-32-characters');
  });

  it('parses only opaque, HTTPS, server-side Tool endpoint bindings', () => {
    const configured = validateEnvironment({
      NODE_ENV: 'test',
      TOOL_ENDPOINT_BINDINGS_JSON: JSON.stringify({
        'secret://tenant/crm/customer': {
          url: 'https://crm.example.com/v1/customer',
          method: 'POST',
          headers: { authorization: 'Bearer server-only' },
          signingSecret: '12345678901234567890123456789012',
        },
      }),
      TOOL_DNS_SERVERS: '1.1.1.1,8.8.8.8',
    });
    expect(configured.TOOL_ENDPOINT_BINDINGS['secret://tenant/crm/customer']).toEqual({
      url: 'https://crm.example.com/v1/customer',
      method: 'POST',
      headers: { authorization: 'Bearer server-only' },
      signingSecret: '12345678901234567890123456789012',
    });
    expect(configured.TOOL_DNS_SERVERS).toEqual(['1.1.1.1', '8.8.8.8']);
    expect(configured).toMatchObject({
      TOOL_MAX_CONCURRENT_PER_VERSION: 4,
      TOOL_MAX_STARTS_PER_MINUTE_PER_VERSION: 60,
    });

    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        TOOL_ENDPOINT_BINDINGS_JSON: JSON.stringify({
          'https://crm.example.com': {
            url: 'https://crm.example.com/v1/customer',
            method: 'POST',
          },
        }),
      }),
    ).toThrow('must be opaque');
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        TOOL_ENDPOINT_BINDINGS_JSON: JSON.stringify({
          'secret://tenant/crm/customer': {
            url: 'http://crm.example.com/v1/customer',
            method: 'POST',
          },
        }),
      }),
    ).toThrow('must use HTTPS');
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        TOOL_ENDPOINT_BINDINGS_JSON: JSON.stringify({
          'secret://tenant/crm/customer': {
            url: 'https://crm.example.com/v1/customer',
            method: 'POST',
            headers: { host: 'evil.example.net' },
          },
        }),
      }),
    ).toThrow('unsafe header');
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        TOOL_MAX_CONCURRENT_PER_VERSION: '0',
      }),
    ).toThrow('TOOL_MAX_CONCURRENT_PER_VERSION must be an integer between 1 and 1000');
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        TOOL_MAX_STARTS_PER_MINUTE_PER_VERSION: '100001',
      }),
    ).toThrow('TOOL_MAX_STARTS_PER_MINUTE_PER_VERSION must be an integer between 1 and 100000');
  });

  it('requires explicit signed endpoint bindings and a dedicated Outbox login in production', () => {
    const production = {
      ...productionKnowledgeEnvironment(),
      TOOL_EXECUTION_WORKER_ENABLED: 'true',
      OUTBOX_DATABASE_URL: 'postgresql://outbox@localhost/example',
      TOOL_DNS_SERVERS: '1.1.1.1',
    };
    expect(() => validateEnvironment(production)).toThrow(
      'TOOL_ENDPOINT_BINDINGS_JSON is required',
    );
    expect(() =>
      validateEnvironment({
        ...production,
        TOOL_ENDPOINT_BINDINGS_JSON: JSON.stringify({
          'secret://tenant/crm/customer': {
            url: 'https://crm.example.com/v1/customer',
            method: 'POST',
          },
        }),
      }),
    ).toThrow('requires a signingSecret in production');
  });
});

function productionKnowledgeEnvironment(): Record<string, unknown> {
  return {
    NODE_ENV: 'production',
    ...PRODUCTION_CONNECTOR_ENVIRONMENT,
    REPOSITORY_DRIVER: 'prisma',
    DATABASE_URL: 'postgresql://api@localhost/example',
    AUTH_DATABASE_URL: 'postgresql://auth@localhost/example',
    ADMIN_DATABASE_URL: 'postgresql://admin@localhost/example',
    LIFECYCLE_DATABASE_URL: 'postgresql://lifecycle@localhost/example',
    AUTH_TOKEN_PEPPER: 'production-test-token-pepper-at-least-32-characters',
    AUTH_PUBLIC_APP_URL: 'https://accounts.example.test',
    AUTH_RECOVERY_EMAIL_PROVIDER: 'resend',
    AUTH_RECOVERY_EMAIL_API_KEY: 'server-only-resend-key',
    AUTH_RECOVERY_EMAIL_FROM: 'WorkMind <no-reply@example.test>',
    KNOWLEDGE_OBJECT_STORE_DRIVER: 's3',
    KNOWLEDGE_OBJECT_STORE_S3_BUCKET: 'enterprise-knowledge',
    KNOWLEDGE_OBJECT_STORE_S3_CREDENTIAL_MODE: 'default_chain',
    KNOWLEDGE_OBJECT_STORE_S3_KMS_KEY_ID: PRODUCTION_KMS_KEY_ARN,
    KNOWLEDGE_FILE_SCANNER_DRIVER: 'clamav',
    KNOWLEDGE_DOCUMENT_PARSER_DRIVER: 'docling',
    KNOWLEDGE_DOCLING_BASE_URL: 'https://docling.example.test',
    KNOWLEDGE_DOCLING_API_KEY: 'server-only-docling-key',
    KNOWLEDGE_WEB_IMPORT_ALLOWED_HOSTS: 'docs.example.test',
  };
}
