import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';

export type NodeEnvironment = 'development' | 'test' | 'production';

declare const s3KmsKeyReferenceBrand: unique symbol;
export type S3KmsKeyReference = string & {
  readonly [s3KmsKeyReferenceBrand]: 'S3KmsKeyReference';
};

export interface ToolEndpointBinding {
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly headers: Readonly<Record<string, string>>;
  readonly signingSecret: string | null;
}

export interface EnvironmentVariables {
  readonly NODE_ENV: NodeEnvironment;
  readonly PORT: number;
  readonly HOST: string;
  readonly CORS_ORIGINS: readonly string[];
  readonly REPOSITORY_DRIVER: 'memory' | 'prisma';
  readonly DATABASE_URL?: string;
  readonly OUTBOX_DATABASE_URL?: string;
  readonly AUTH_DATABASE_URL?: string;
  readonly ADMIN_DATABASE_URL?: string;
  readonly LIFECYCLE_DATABASE_URL?: string;
  readonly SCIM_DATABASE_URL?: string;
  readonly AUTH_TOKEN_PEPPER: string;
  readonly CONNECTOR_CREDENTIAL_KEYRING: Readonly<Record<string, string>>;
  readonly CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID?: string;
  readonly IDENTITY_SECRET_KEYRING: Readonly<Record<string, string>>;
  readonly IDENTITY_SECRET_ACTIVE_KEY_ID?: string;
  readonly AUTH_MFA_CHALLENGE_TTL_SECONDS: number;
  readonly IDENTITY_OIDC_HTTP_TIMEOUT_MS: number;
  readonly AUTH_ACCESS_TTL_SECONDS: number;
  readonly AUTH_REFRESH_TTL_SECONDS: number;
  readonly AUTH_LOGIN_RATE_LIMIT_ENABLED: boolean;
  readonly AUTH_LOGIN_RATE_LIMIT_NETWORK_ENABLED: boolean;
  readonly AUTH_LOGIN_RATE_LIMIT_ACCOUNT_FAILURES: number;
  readonly AUTH_LOGIN_RATE_LIMIT_NETWORK_FAILURES: number;
  readonly AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS: number;
  readonly AUTH_LOGIN_RATE_LIMIT_BLOCK_SECONDS: number;
  readonly AUTH_RATE_LIMIT_BUCKET_CAPACITY_PER_SCOPE: number;
  readonly AUTH_RECOVERY_RATE_LIMIT_ACCOUNT_REQUESTS?: number;
  readonly AUTH_RECOVERY_RATE_LIMIT_NETWORK_REQUESTS?: number;
  readonly AUTH_RECOVERY_RATE_LIMIT_WINDOW_SECONDS?: number;
  readonly AUTH_PASSWORD_RESET_TTL_SECONDS?: number;
  readonly AUTH_MEMBER_INVITATION_TTL_SECONDS?: number;
  readonly AUTH_MEMBER_INVITATION_FALLBACK_TTL_SECONDS?: number;
  readonly AUTH_RECOVERY_EMAIL_PROVIDER?: 'disabled' | 'resend';
  readonly AUTH_RECOVERY_EMAIL_API_KEY?: string;
  readonly AUTH_RECOVERY_EMAIL_FROM?: string;
  readonly AUTH_RECOVERY_EMAIL_HTTP_TIMEOUT_MS?: number;
  readonly AUTH_PUBLIC_APP_URL?: string;
  readonly REGISTRATION_MODE: 'disabled' | 'open';
  readonly ALLOW_DEV_IDENTITY_HEADERS: boolean;
  readonly DEV_TENANT_ID: string;
  readonly DEV_USER_ID: string;
  readonly TRUST_PROXY_IDENTITY_HEADERS: boolean;
  readonly IM_OUTBOX_ENABLED: boolean;
  readonly IM_PROVIDER: 'local' | 'tencent' | 'wukong';
  readonly IM_OUTBOX_POLL_INTERVAL_MS: number;
  readonly IM_OUTBOX_BATCH_SIZE: number;
  readonly IM_OUTBOX_MAX_ATTEMPTS: number;
  readonly IM_OUTBOX_RETRY_BASE_MS: number;
  readonly IM_OUTBOX_RETRY_MAX_MS: number;
  readonly IM_OUTBOX_CLAIM_TTL_MS: number;
  readonly IM_PROVIDER_TIMEOUT_MS: number;
  readonly TENCENT_IM_SDK_APP_ID?: number;
  readonly TENCENT_IM_ADMIN_USER_ID?: string;
  readonly TENCENT_IM_SECRET_KEY?: string;
  readonly TENCENT_IM_API_BASE_URL: string;
  readonly TENCENT_IM_USER_SIG_TTL_SECONDS: number;
  readonly TENCENT_IM_HTTP_TIMEOUT_MS: number;
  readonly WUKONG_IM_API_BASE_URL: string;
  readonly WUKONG_IM_PUBLIC_WS_URL: string;
  readonly WUKONG_IM_API_TOKEN?: string;
  readonly WUKONG_IM_TOKEN_SIGNING_SECRET?: string;
  readonly WUKONG_IM_HTTP_TIMEOUT_MS: number;
  readonly WUKONG_IM_VERIFIED_AUTH_ENABLED: boolean;
  readonly AGENT_RUN_WORKER_ENABLED: boolean;
  readonly AGENT_RUN_WORKER_CONCURRENCY: number;
  readonly AGENT_RUN_POLL_INTERVAL_MS: number;
  readonly AGENT_RUN_CLAIM_TTL_MS: number;
  readonly TOOL_EXECUTION_WORKER_ENABLED: boolean;
  readonly TOOL_EXECUTION_WORKER_CONCURRENCY: number;
  readonly TOOL_EXECUTION_POLL_INTERVAL_MS: number;
  readonly TOOL_EXECUTION_CLAIM_TTL_MS: number;
  readonly TOOL_MAX_CONCURRENT_PER_VERSION: number;
  readonly TOOL_MAX_STARTS_PER_MINUTE_PER_VERSION: number;
  readonly TOOL_PROVIDER_MAX_RESPONSE_BYTES: number;
  readonly TOOL_CIRCUIT_FAILURE_THRESHOLD: number;
  readonly TOOL_CIRCUIT_OPEN_MS: number;
  readonly TOOL_ENDPOINT_BINDINGS: Readonly<Record<string, ToolEndpointBinding>>;
  readonly TOOL_DNS_SERVERS: readonly string[];
  readonly FINOPS_PROJECTION_WORKER_ENABLED: boolean;
  readonly FINOPS_PROJECTION_BATCH_SIZE: number;
  readonly FINOPS_PROJECTION_POLL_INTERVAL_MS: number;
  readonly FINOPS_PROJECTION_CLAIM_TTL_MS: number;
  readonly AI_RUNTIME_URL: string;
  readonly AI_RUNTIME_HTTP_TIMEOUT_MS: number;
  readonly AI_RUNTIME_SERVICE_TOKEN?: string;
  readonly AI_EVALUATION_RUNNER_HMAC_SECRET?: string;
  readonly KNOWLEDGE_SEMANTIC_SEARCH_ENABLED: boolean;
  readonly KNOWLEDGE_RERANK_ENABLED: boolean;
  readonly KNOWLEDGE_AI_TIMEOUT_MS: number;
  readonly KNOWLEDGE_EMBEDDING_DIMENSIONS: 1536;
  readonly KNOWLEDGE_VECTOR_SEARCH_MODE: 'exact' | 'hnsw';
  readonly KNOWLEDGE_OBJECT_STORE_DRIVER: 'local' | 's3';
  readonly KNOWLEDGE_OBJECT_STORE_MAX_BYTES: number;
  readonly KNOWLEDGE_OBJECT_STORE_LOCAL_ROOT?: string;
  readonly KNOWLEDGE_OBJECT_STORE_S3_ENDPOINT?: string;
  readonly KNOWLEDGE_OBJECT_STORE_S3_REGION: string;
  readonly KNOWLEDGE_OBJECT_STORE_S3_BUCKET?: string;
  readonly KNOWLEDGE_OBJECT_STORE_S3_CREDENTIAL_MODE: 'default_chain' | 'static';
  readonly KNOWLEDGE_OBJECT_STORE_S3_ACCESS_KEY_ID?: string;
  readonly KNOWLEDGE_OBJECT_STORE_S3_SECRET_ACCESS_KEY?: string;
  readonly KNOWLEDGE_OBJECT_STORE_S3_FORCE_PATH_STYLE: boolean;
  readonly KNOWLEDGE_OBJECT_STORE_S3_PREFIX: string;
  readonly KNOWLEDGE_OBJECT_STORE_S3_KMS_KEY_ID?: S3KmsKeyReference;
  readonly KNOWLEDGE_FILE_SCANNER_DRIVER: 'disabled' | 'clamav';
  readonly KNOWLEDGE_FILE_SCANNER_CLAMAV_HOST: string;
  readonly KNOWLEDGE_FILE_SCANNER_CLAMAV_PORT: number;
  readonly KNOWLEDGE_FILE_SCANNER_TIMEOUT_MS: number;
  readonly KNOWLEDGE_DOCUMENT_PARSER_DRIVER: 'local' | 'docling';
  readonly KNOWLEDGE_DOCLING_BASE_URL?: string;
  readonly KNOWLEDGE_DOCLING_API_KEY?: string;
  readonly KNOWLEDGE_DOCLING_TIMEOUT_MS: number;
  readonly KNOWLEDGE_DOCLING_MAX_RESPONSE_BYTES: number;
  readonly KNOWLEDGE_WEB_IMPORT_ALLOWED_HOSTS: readonly string[];
  readonly KNOWLEDGE_WEB_IMPORT_TIMEOUT_MS: number;
  readonly KNOWLEDGE_WEB_IMPORT_MAX_BYTES: number;
  readonly KNOWLEDGE_PERSISTENT_WRITES_ENABLED: boolean;
  readonly KNOWLEDGE_INGESTION_WORKER_ENABLED: boolean;
  readonly KNOWLEDGE_INGESTION_POLL_INTERVAL_MS: number;
  readonly KNOWLEDGE_INGESTION_BATCH_SIZE: number;
  readonly KNOWLEDGE_INGESTION_MAX_ATTEMPTS: number;
  readonly KNOWLEDGE_INGESTION_RETRY_BASE_MS: number;
  readonly KNOWLEDGE_INGESTION_RETRY_MAX_MS: number;
  readonly KNOWLEDGE_INGESTION_CLAIM_TTL_MS: number;
  readonly FEISHU_DIRECTORY_SYNC_ENABLED: boolean;
  readonly FEISHU_DIRECTORY_RECONCILE_REMOVALS: boolean;
  readonly FEISHU_DIRECTORY_TARGET_TENANT_SLUG?: string;
  readonly FEISHU_APP_ID?: string;
  readonly FEISHU_APP_SECRET?: string;
  readonly FEISHU_API_BASE_URL: string;
  readonly FEISHU_HTTP_TIMEOUT_MS: number;
  readonly FEISHU_SYNC_LEASE_MS: number;
  readonly FEISHU_SYNC_PREVIEW_TTL_MS: number;
  readonly FEISHU_SYNC_WORKER_ENABLED: boolean;
  readonly FEISHU_SYNC_WORKER_POLL_INTERVAL_MS: number;
  readonly FEISHU_SYNC_WORKER_BATCH_SIZE: number;
  readonly FEISHU_SYNC_MAX_ATTEMPTS: number;
  readonly FEISHU_SYNC_RETRY_BASE_MS: number;
  readonly FEISHU_SYNC_RETRY_MAX_MS: number;
}

/**
 * API-only configuration boundary. Provider credentials belong to the isolated
 * AI Runtime process and are removed even when local development shares a root
 * dotenv file or the parent shell exported them globally.
 */
export function validateApiEnvironment(source: Record<string, unknown>): EnvironmentVariables {
  for (const key of Object.keys(process.env)) {
    if (isRuntimeProviderSecret(key)) delete process.env[key];
  }
  const sanitized = Object.fromEntries(
    Object.entries(source).filter(([key]) => !isRuntimeProviderSecret(key)),
  );
  return validateEnvironment(sanitized);
}

function isRuntimeProviderSecret(key: string): boolean {
  return key.startsWith('MANUS_') || (key.startsWith('AI_RUNTIME_') && key.endsWith('_API_KEY'));
}

const DEFAULT_TENANT_ID = '00000000-0000-7000-8000-000000000001';
const DEFAULT_USER_ID = '00000000-0000-7000-8000-000000000101';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENCENT_IM_DEFAULT_API_BASE_URL = 'https://console.tim.qq.com';
const WUKONG_IM_DEFAULT_API_BASE_URL = 'http://127.0.0.1:5501';
const WUKONG_IM_DEFAULT_PUBLIC_WS_URL = 'ws://127.0.0.1:5520';
const TENCENT_IM_ACCOUNT_PATTERN = /^[A-Za-z0-9_-]+$/;
const TENANT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FEISHU_DEFAULT_API_BASE_URL = 'https://open.feishu.cn';
const TENCENT_IM_OFFICIAL_API_HOSTS = new Set([
  'console.tim.qq.com',
  'adminapisgp.im.qcloud.com',
  'adminapikr.im.qcloud.com',
  'adminapijpn.im.qcloud.com',
  'adminapiger.im.qcloud.com',
  'adminapiusa.im.qcloud.com',
  'adminapiidn.im.qcloud.com',
  'adminapiksa.im.qcloud.com',
  'adminapi.my-imcloud.com',
  'adminapisgp.my-imcloud.com',
  'adminapikr.my-imcloud.com',
  'adminapijpn.my-imcloud.com',
  'adminapiger.my-imcloud.com',
  'adminapiusa.my-imcloud.com',
  'adminapiidn.my-imcloud.com',
  'adminapiksa.my-imcloud.com',
]);

export function validateEnvironment(source: Record<string, unknown>): EnvironmentVariables {
  const nodeEnvironment = parseNodeEnvironment(source.NODE_ENV);
  const port = parsePort(source.PORT ?? source.API_PORT);
  const host = parseHost(source.HOST ?? source.API_HOST);
  const corsOrigins = parseCorsOrigins(
    source.CORS_ORIGINS ?? source.API_CORS_ORIGINS,
    nodeEnvironment,
  );
  const repositoryDriver = parseRepositoryDriver(source.REPOSITORY_DRIVER);
  const databaseUrl = parseOptionalString(source.DATABASE_URL);
  const configuredOutboxDatabaseUrl = parseOptionalString(source.OUTBOX_DATABASE_URL);
  const configuredAuthDatabaseUrl = parseOptionalString(source.AUTH_DATABASE_URL);
  const configuredAdminDatabaseUrl = parseOptionalString(source.ADMIN_DATABASE_URL);
  const configuredLifecycleDatabaseUrl = parseOptionalString(source.LIFECYCLE_DATABASE_URL);
  const configuredScimDatabaseUrl = parseOptionalString(source.SCIM_DATABASE_URL);
  const authTokenPepper =
    parseOptionalString(source.AUTH_TOKEN_PEPPER) ??
    'development-only-token-pepper-change-before-production';
  const connectorCredentialKeyring = parseConnectorCredentialKeyring(
    source.CONNECTOR_CREDENTIAL_KEYRING_JSON,
  );
  const connectorCredentialActiveKeyId = parseConnectorCredentialKeyId(
    source.CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID,
    'CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID',
  );
  const identitySecretKeyring = parseIdentitySecretKeyring(source.IDENTITY_SECRET_KEYRING_JSON);
  const identitySecretActiveKeyId = parseConnectorCredentialKeyId(
    source.IDENTITY_SECRET_ACTIVE_KEY_ID,
    'IDENTITY_SECRET_ACTIVE_KEY_ID',
  );
  const authAccessTtlSeconds = parseInteger(
    source.AUTH_ACCESS_TTL_SECONDS,
    'AUTH_ACCESS_TTL_SECONDS',
    900,
    60,
    86_400,
  );
  const authRefreshTtlSeconds = parseInteger(
    source.AUTH_REFRESH_TTL_SECONDS,
    'AUTH_REFRESH_TTL_SECONDS',
    2_592_000,
    3_600,
    31_536_000,
  );
  const authMfaChallengeTtlSeconds = parseInteger(
    source.AUTH_MFA_CHALLENGE_TTL_SECONDS,
    'AUTH_MFA_CHALLENGE_TTL_SECONDS',
    300,
    60,
    600,
  );
  const identityOidcHttpTimeoutMs = parseInteger(
    source.IDENTITY_OIDC_HTTP_TIMEOUT_MS,
    'IDENTITY_OIDC_HTTP_TIMEOUT_MS',
    10_000,
    500,
    60_000,
  );
  const authLoginRateLimitEnabled = parseBoolean(
    source.AUTH_LOGIN_RATE_LIMIT_ENABLED,
    nodeEnvironment === 'production' && repositoryDriver === 'prisma',
  );
  const authLoginRateLimitNetworkEnabled = parseBoolean(
    source.AUTH_LOGIN_RATE_LIMIT_NETWORK_ENABLED,
    nodeEnvironment === 'production' && repositoryDriver === 'prisma',
  );
  const authLoginRateLimitAccountFailures = parseInteger(
    source.AUTH_LOGIN_RATE_LIMIT_ACCOUNT_FAILURES,
    'AUTH_LOGIN_RATE_LIMIT_ACCOUNT_FAILURES',
    5,
    2,
    100,
  );
  const authLoginRateLimitNetworkFailures = parseInteger(
    source.AUTH_LOGIN_RATE_LIMIT_NETWORK_FAILURES,
    'AUTH_LOGIN_RATE_LIMIT_NETWORK_FAILURES',
    30,
    2,
    1_000,
  );
  const authLoginRateLimitWindowSeconds = parseInteger(
    source.AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    'AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS',
    900,
    60,
    86_400,
  );
  const authLoginRateLimitBlockSeconds = parseInteger(
    source.AUTH_LOGIN_RATE_LIMIT_BLOCK_SECONDS,
    'AUTH_LOGIN_RATE_LIMIT_BLOCK_SECONDS',
    900,
    60,
    86_400,
  );
  const authRateLimitBucketCapacityPerScope = parseInteger(
    source.AUTH_RATE_LIMIT_BUCKET_CAPACITY_PER_SCOPE,
    'AUTH_RATE_LIMIT_BUCKET_CAPACITY_PER_SCOPE',
    100_000,
    100,
    1_000_000,
  );
  const authRecoveryRateLimitAccountRequests = parseInteger(
    source.AUTH_RECOVERY_RATE_LIMIT_ACCOUNT_REQUESTS,
    'AUTH_RECOVERY_RATE_LIMIT_ACCOUNT_REQUESTS',
    3,
    1,
    100,
  );
  const authRecoveryRateLimitNetworkRequests = parseInteger(
    source.AUTH_RECOVERY_RATE_LIMIT_NETWORK_REQUESTS,
    'AUTH_RECOVERY_RATE_LIMIT_NETWORK_REQUESTS',
    20,
    1,
    1_000,
  );
  const authRecoveryRateLimitWindowSeconds = parseInteger(
    source.AUTH_RECOVERY_RATE_LIMIT_WINDOW_SECONDS,
    'AUTH_RECOVERY_RATE_LIMIT_WINDOW_SECONDS',
    3_600,
    60,
    86_400,
  );
  const authPasswordResetTtlSeconds = parseInteger(
    source.AUTH_PASSWORD_RESET_TTL_SECONDS,
    'AUTH_PASSWORD_RESET_TTL_SECONDS',
    1_800,
    300,
    86_400,
  );
  const authMemberInvitationTtlSeconds = parseInteger(
    source.AUTH_MEMBER_INVITATION_TTL_SECONDS,
    'AUTH_MEMBER_INVITATION_TTL_SECONDS',
    604_800,
    900,
    2_592_000,
  );
  const authMemberInvitationFallbackTtlSeconds = parseInteger(
    source.AUTH_MEMBER_INVITATION_FALLBACK_TTL_SECONDS,
    'AUTH_MEMBER_INVITATION_FALLBACK_TTL_SECONDS',
    900,
    300,
    3_600,
  );
  if (authMemberInvitationFallbackTtlSeconds > authMemberInvitationTtlSeconds) {
    throw new Error(
      'AUTH_MEMBER_INVITATION_FALLBACK_TTL_SECONDS must not exceed AUTH_MEMBER_INVITATION_TTL_SECONDS.',
    );
  }
  const authRecoveryEmailProvider = parseAuthRecoveryEmailProvider(
    source.AUTH_RECOVERY_EMAIL_PROVIDER,
  );
  const authRecoveryEmailApiKey = parseOptionalString(source.AUTH_RECOVERY_EMAIL_API_KEY);
  const authRecoveryEmailFrom = parseOptionalString(source.AUTH_RECOVERY_EMAIL_FROM);
  const authRecoveryEmailHttpTimeoutMs = parseInteger(
    source.AUTH_RECOVERY_EMAIL_HTTP_TIMEOUT_MS,
    'AUTH_RECOVERY_EMAIL_HTTP_TIMEOUT_MS',
    10_000,
    500,
    60_000,
  );
  const authPublicAppUrl = parseAuthPublicAppUrl(
    source.AUTH_PUBLIC_APP_URL ?? corsOrigins[0],
    nodeEnvironment,
  );
  const registrationMode = parseRegistrationMode(source.REGISTRATION_MODE, nodeEnvironment);
  const allowDevIdentityHeaders = parseBoolean(
    source.ALLOW_DEV_IDENTITY_HEADERS,
    nodeEnvironment === 'test',
  );
  const imOutboxEnabled = parseBoolean(
    source.IM_OUTBOX_ENABLED,
    nodeEnvironment === 'development' && repositoryDriver === 'prisma',
  );
  const imProvider = parseImProvider(source.IM_PROVIDER);
  const imOutboxPollIntervalMs = parseInteger(
    source.IM_OUTBOX_POLL_INTERVAL_MS,
    'IM_OUTBOX_POLL_INTERVAL_MS',
    500,
    10,
    60_000,
  );
  const imOutboxBatchSize = parseInteger(
    source.IM_OUTBOX_BATCH_SIZE,
    'IM_OUTBOX_BATCH_SIZE',
    20,
    1,
    100,
  );
  const imOutboxMaxAttempts = parseInteger(
    source.IM_OUTBOX_MAX_ATTEMPTS,
    'IM_OUTBOX_MAX_ATTEMPTS',
    8,
    1,
    100,
  );
  const imOutboxRetryBaseMs = parseInteger(
    source.IM_OUTBOX_RETRY_BASE_MS,
    'IM_OUTBOX_RETRY_BASE_MS',
    1_000,
    1,
    86_400_000,
  );
  const imOutboxRetryMaxMs = parseInteger(
    source.IM_OUTBOX_RETRY_MAX_MS,
    'IM_OUTBOX_RETRY_MAX_MS',
    60_000,
    1,
    86_400_000,
  );
  const imOutboxClaimTtlMs = parseInteger(
    source.IM_OUTBOX_CLAIM_TTL_MS,
    'IM_OUTBOX_CLAIM_TTL_MS',
    30_000,
    1_000,
    3_600_000,
  );
  const imProviderTimeoutMs = parseInteger(
    source.IM_PROVIDER_TIMEOUT_MS,
    'IM_PROVIDER_TIMEOUT_MS',
    10_000,
    100,
    600_000,
  );
  const tencentSdkAppId = parseOptionalPositiveInteger(
    source.TENCENT_IM_SDK_APP_ID,
    'TENCENT_IM_SDK_APP_ID',
  );
  const tencentAdminUserId = parseOptionalString(source.TENCENT_IM_ADMIN_USER_ID);
  const tencentSecretKey = parseOptionalString(source.TENCENT_IM_SECRET_KEY);
  const tencentApiBaseUrl = parseTencentApiBaseUrl(
    source.TENCENT_IM_API_BASE_URL ?? TENCENT_IM_DEFAULT_API_BASE_URL,
  );
  const tencentUserSigTtlSeconds = parseInteger(
    source.TENCENT_IM_USER_SIG_TTL_SECONDS,
    'TENCENT_IM_USER_SIG_TTL_SECONDS',
    5_184_000,
    3_600,
    31_536_000,
  );
  const tencentHttpTimeoutMs = parseInteger(
    source.TENCENT_IM_HTTP_TIMEOUT_MS,
    'TENCENT_IM_HTTP_TIMEOUT_MS',
    5_000,
    500,
    60_000,
  );
  const wukongApiBaseUrl = parseWukongApiBaseUrl(
    source.WUKONG_IM_API_BASE_URL ?? WUKONG_IM_DEFAULT_API_BASE_URL,
    imProvider === 'wukong' ? nodeEnvironment : 'development',
  );
  const wukongPublicWsUrl = parseWukongPublicWsUrl(
    source.WUKONG_IM_PUBLIC_WS_URL ?? WUKONG_IM_DEFAULT_PUBLIC_WS_URL,
    imProvider === 'wukong' ? nodeEnvironment : 'development',
  );
  const wukongApiToken = parseOptionalSecret(source.WUKONG_IM_API_TOKEN, 'WUKONG_IM_API_TOKEN');
  const wukongTokenSigningSecret = parseOptionalSecret(
    source.WUKONG_IM_TOKEN_SIGNING_SECRET,
    'WUKONG_IM_TOKEN_SIGNING_SECRET',
  );
  const wukongHttpTimeoutMs = parseInteger(
    source.WUKONG_IM_HTTP_TIMEOUT_MS,
    'WUKONG_IM_HTTP_TIMEOUT_MS',
    5_000,
    500,
    60_000,
  );
  const wukongVerifiedAuthEnabled = parseBoolean(source.WUKONG_IM_VERIFIED_AUTH_ENABLED, false);
  const agentRunWorkerEnabled = parseBoolean(
    source.AGENT_RUN_WORKER_ENABLED,
    nodeEnvironment === 'development' && repositoryDriver === 'prisma',
  );
  const agentRunWorkerConcurrency = parseInteger(
    source.AGENT_RUN_WORKER_CONCURRENCY,
    'AGENT_RUN_WORKER_CONCURRENCY',
    1,
    1,
    8,
  );
  const agentRunPollIntervalMs = parseInteger(
    source.AGENT_RUN_POLL_INTERVAL_MS,
    'AGENT_RUN_POLL_INTERVAL_MS',
    500,
    10,
    60_000,
  );
  const agentRunClaimTtlMs = parseInteger(
    source.AGENT_RUN_CLAIM_TTL_MS,
    'AGENT_RUN_CLAIM_TTL_MS',
    120_000,
    5_000,
    3_600_000,
  );
  const toolExecutionWorkerEnabled = parseBoolean(
    source.TOOL_EXECUTION_WORKER_ENABLED,
    nodeEnvironment === 'development' && repositoryDriver === 'prisma',
  );
  const toolExecutionWorkerConcurrency = parseInteger(
    source.TOOL_EXECUTION_WORKER_CONCURRENCY,
    'TOOL_EXECUTION_WORKER_CONCURRENCY',
    2,
    1,
    32,
  );
  const toolExecutionPollIntervalMs = parseInteger(
    source.TOOL_EXECUTION_POLL_INTERVAL_MS,
    'TOOL_EXECUTION_POLL_INTERVAL_MS',
    500,
    10,
    60_000,
  );
  const toolExecutionClaimTtlMs = parseInteger(
    source.TOOL_EXECUTION_CLAIM_TTL_MS,
    'TOOL_EXECUTION_CLAIM_TTL_MS',
    180_000,
    135_001,
    3_600_000,
  );
  const finopsProjectionWorkerEnabled = parseBoolean(
    source.FINOPS_PROJECTION_WORKER_ENABLED,
    nodeEnvironment === 'development' && repositoryDriver === 'prisma',
  );
  const finopsProjectionBatchSize = parseInteger(
    source.FINOPS_PROJECTION_BATCH_SIZE,
    'FINOPS_PROJECTION_BATCH_SIZE',
    25,
    1,
    500,
  );
  const finopsProjectionPollIntervalMs = parseInteger(
    source.FINOPS_PROJECTION_POLL_INTERVAL_MS,
    'FINOPS_PROJECTION_POLL_INTERVAL_MS',
    5_000,
    100,
    300_000,
  );
  const finopsProjectionClaimTtlMs = parseInteger(
    source.FINOPS_PROJECTION_CLAIM_TTL_MS,
    'FINOPS_PROJECTION_CLAIM_TTL_MS',
    60_000,
    5_000,
    3_600_000,
  );
  const toolMaxConcurrentPerVersion = parseInteger(
    source.TOOL_MAX_CONCURRENT_PER_VERSION,
    'TOOL_MAX_CONCURRENT_PER_VERSION',
    4,
    1,
    1_000,
  );
  const toolMaxStartsPerMinutePerVersion = parseInteger(
    source.TOOL_MAX_STARTS_PER_MINUTE_PER_VERSION,
    'TOOL_MAX_STARTS_PER_MINUTE_PER_VERSION',
    60,
    1,
    100_000,
  );
  const toolProviderMaxResponseBytes = parseInteger(
    source.TOOL_PROVIDER_MAX_RESPONSE_BYTES,
    'TOOL_PROVIDER_MAX_RESPONSE_BYTES',
    1_048_576,
    1_024,
    16_777_216,
  );
  const toolCircuitFailureThreshold = parseInteger(
    source.TOOL_CIRCUIT_FAILURE_THRESHOLD,
    'TOOL_CIRCUIT_FAILURE_THRESHOLD',
    5,
    2,
    100,
  );
  const toolCircuitOpenMs = parseInteger(
    source.TOOL_CIRCUIT_OPEN_MS,
    'TOOL_CIRCUIT_OPEN_MS',
    30_000,
    1_000,
    3_600_000,
  );
  const toolEndpointBindings = parseToolEndpointBindings(
    source.TOOL_ENDPOINT_BINDINGS_JSON,
    nodeEnvironment,
    toolExecutionWorkerEnabled,
  );
  const toolDnsServers = parseToolDnsServers(source.TOOL_DNS_SERVERS);
  const aiRuntimeUrl = parseAiRuntimeUrl(source.AI_RUNTIME_URL ?? 'http://127.0.0.1:8100');
  const aiRuntimeHttpTimeoutMs = parseInteger(
    source.AI_RUNTIME_HTTP_TIMEOUT_MS,
    'AI_RUNTIME_HTTP_TIMEOUT_MS',
    90_000,
    1_000,
    600_000,
  );
  const aiRuntimeServiceToken = parseOptionalString(source.AI_RUNTIME_SERVICE_TOKEN);
  const aiEvaluationRunnerHmacSecret = parseOptionalString(source.AI_EVALUATION_RUNNER_HMAC_SECRET);
  const knowledgeSemanticSearchEnabled = parseBoolean(
    source.KNOWLEDGE_SEMANTIC_SEARCH_ENABLED,
    false,
  );
  const knowledgeRerankEnabled = parseBoolean(source.KNOWLEDGE_RERANK_ENABLED, false);
  const knowledgeAiTimeoutMs = parseInteger(
    source.KNOWLEDGE_AI_TIMEOUT_MS,
    'KNOWLEDGE_AI_TIMEOUT_MS',
    30_000,
    1_000,
    120_000,
  );
  const knowledgeEmbeddingDimensions = parseInteger(
    source.KNOWLEDGE_EMBEDDING_DIMENSIONS,
    'KNOWLEDGE_EMBEDDING_DIMENSIONS',
    1_536,
    1_536,
    1_536,
  ) as 1536;
  const knowledgeVectorSearchMode = parseKnowledgeVectorSearchMode(
    source.KNOWLEDGE_VECTOR_SEARCH_MODE,
  );
  const knowledgeObjectStoreDriver = parseKnowledgeObjectStoreDriver(
    source.KNOWLEDGE_OBJECT_STORE_DRIVER,
  );
  const knowledgeObjectStoreMaxBytes = parseInteger(
    source.KNOWLEDGE_OBJECT_STORE_MAX_BYTES,
    'KNOWLEDGE_OBJECT_STORE_MAX_BYTES',
    52_428_800,
    1_048_576,
    536_870_912,
  );
  const knowledgeObjectStoreLocalRoot = parseOptionalAbsolutePath(
    source.KNOWLEDGE_OBJECT_STORE_LOCAL_ROOT,
    'KNOWLEDGE_OBJECT_STORE_LOCAL_ROOT',
  );
  const knowledgeObjectStoreS3Endpoint = parseOptionalS3Endpoint(
    source.KNOWLEDGE_OBJECT_STORE_S3_ENDPOINT,
    nodeEnvironment,
  );
  const knowledgeObjectStoreS3Region = parseS3Region(source.KNOWLEDGE_OBJECT_STORE_S3_REGION);
  const knowledgeObjectStoreS3Bucket = parseOptionalS3Bucket(
    source.KNOWLEDGE_OBJECT_STORE_S3_BUCKET,
  );
  const knowledgeObjectStoreS3CredentialMode = parseS3CredentialMode(
    source.KNOWLEDGE_OBJECT_STORE_S3_CREDENTIAL_MODE,
  );
  const knowledgeObjectStoreS3AccessKeyId = parseOptionalS3Credential(
    source.KNOWLEDGE_OBJECT_STORE_S3_ACCESS_KEY_ID,
    'KNOWLEDGE_OBJECT_STORE_S3_ACCESS_KEY_ID',
    3,
  );
  const knowledgeObjectStoreS3SecretAccessKey = parseOptionalS3Credential(
    source.KNOWLEDGE_OBJECT_STORE_S3_SECRET_ACCESS_KEY,
    'KNOWLEDGE_OBJECT_STORE_S3_SECRET_ACCESS_KEY',
    8,
  );
  const knowledgeObjectStoreS3ForcePathStyle = parseBoolean(
    source.KNOWLEDGE_OBJECT_STORE_S3_FORCE_PATH_STYLE,
    true,
  );
  const knowledgeObjectStoreS3Prefix = parseS3Prefix(source.KNOWLEDGE_OBJECT_STORE_S3_PREFIX);
  const knowledgeObjectStoreS3KmsKeyId = parseOptionalS3KmsKeyReference(
    source.KNOWLEDGE_OBJECT_STORE_S3_KMS_KEY_ID,
    nodeEnvironment,
    knowledgeObjectStoreS3Region,
  );
  const knowledgeFileScannerDriver = parseKnowledgeFileScannerDriver(
    source.KNOWLEDGE_FILE_SCANNER_DRIVER,
  );
  const knowledgeFileScannerClamAvHost = parseServiceHost(
    source.KNOWLEDGE_FILE_SCANNER_CLAMAV_HOST,
    'KNOWLEDGE_FILE_SCANNER_CLAMAV_HOST',
    '127.0.0.1',
  );
  const knowledgeFileScannerClamAvPort = parseInteger(
    source.KNOWLEDGE_FILE_SCANNER_CLAMAV_PORT,
    'KNOWLEDGE_FILE_SCANNER_CLAMAV_PORT',
    3_310,
    1,
    65_535,
  );
  const knowledgeFileScannerTimeoutMs = parseInteger(
    source.KNOWLEDGE_FILE_SCANNER_TIMEOUT_MS,
    'KNOWLEDGE_FILE_SCANNER_TIMEOUT_MS',
    30_000,
    100,
    300_000,
  );
  const knowledgeDocumentParserDriver = parseKnowledgeDocumentParserDriver(
    source.KNOWLEDGE_DOCUMENT_PARSER_DRIVER,
  );
  const knowledgeDoclingBaseUrl = parseOptionalServiceOrigin(
    source.KNOWLEDGE_DOCLING_BASE_URL,
    'KNOWLEDGE_DOCLING_BASE_URL',
    nodeEnvironment,
  );
  const knowledgeDoclingApiKey = parseOptionalSecret(
    source.KNOWLEDGE_DOCLING_API_KEY,
    'KNOWLEDGE_DOCLING_API_KEY',
  );
  const knowledgeDoclingTimeoutMs = parseInteger(
    source.KNOWLEDGE_DOCLING_TIMEOUT_MS,
    'KNOWLEDGE_DOCLING_TIMEOUT_MS',
    120_000,
    1_000,
    900_000,
  );
  const knowledgeDoclingMaxResponseBytes = parseInteger(
    source.KNOWLEDGE_DOCLING_MAX_RESPONSE_BYTES,
    'KNOWLEDGE_DOCLING_MAX_RESPONSE_BYTES',
    33_554_432,
    1_024,
    134_217_728,
  );
  const knowledgeWebImportAllowedHosts = parseKnowledgeWebImportAllowedHosts(
    source.KNOWLEDGE_WEB_IMPORT_ALLOWED_HOSTS,
  );
  const knowledgeWebImportTimeoutMs = parseInteger(
    source.KNOWLEDGE_WEB_IMPORT_TIMEOUT_MS,
    'KNOWLEDGE_WEB_IMPORT_TIMEOUT_MS',
    15_000,
    500,
    60_000,
  );
  const knowledgeWebImportMaxBytes = parseInteger(
    source.KNOWLEDGE_WEB_IMPORT_MAX_BYTES,
    'KNOWLEDGE_WEB_IMPORT_MAX_BYTES',
    5_242_880,
    1_024,
    20_971_520,
  );
  const knowledgePersistentWritesEnabled = parseBoolean(
    source.KNOWLEDGE_PERSISTENT_WRITES_ENABLED,
    nodeEnvironment !== 'production' && repositoryDriver === 'prisma',
  );
  const knowledgeIngestionWorkerEnabled = parseBoolean(
    source.KNOWLEDGE_INGESTION_WORKER_ENABLED,
    nodeEnvironment === 'development' && repositoryDriver === 'prisma',
  );
  const knowledgeIngestionPollIntervalMs = parseInteger(
    source.KNOWLEDGE_INGESTION_POLL_INTERVAL_MS,
    'KNOWLEDGE_INGESTION_POLL_INTERVAL_MS',
    500,
    10,
    60_000,
  );
  const knowledgeIngestionBatchSize = parseInteger(
    source.KNOWLEDGE_INGESTION_BATCH_SIZE,
    'KNOWLEDGE_INGESTION_BATCH_SIZE',
    2,
    1,
    20,
  );
  const knowledgeIngestionMaxAttempts = parseInteger(
    source.KNOWLEDGE_INGESTION_MAX_ATTEMPTS,
    'KNOWLEDGE_INGESTION_MAX_ATTEMPTS',
    5,
    1,
    20,
  );
  const knowledgeIngestionRetryBaseMs = parseInteger(
    source.KNOWLEDGE_INGESTION_RETRY_BASE_MS,
    'KNOWLEDGE_INGESTION_RETRY_BASE_MS',
    1_000,
    1,
    86_400_000,
  );
  const knowledgeIngestionRetryMaxMs = parseInteger(
    source.KNOWLEDGE_INGESTION_RETRY_MAX_MS,
    'KNOWLEDGE_INGESTION_RETRY_MAX_MS',
    60_000,
    1,
    86_400_000,
  );
  const knowledgeIngestionClaimTtlMs = parseInteger(
    source.KNOWLEDGE_INGESTION_CLAIM_TTL_MS,
    'KNOWLEDGE_INGESTION_CLAIM_TTL_MS',
    120_000,
    5_000,
    3_600_000,
  );
  const feishuDirectorySyncEnabled = parseBoolean(source.FEISHU_DIRECTORY_SYNC_ENABLED, false);
  const feishuDirectoryReconcileRemovals = parseBoolean(
    source.FEISHU_DIRECTORY_RECONCILE_REMOVALS,
    false,
  );
  const feishuDirectoryTargetTenantSlug = parseOptionalTenantSlug(
    source.FEISHU_DIRECTORY_TARGET_TENANT_SLUG,
    'FEISHU_DIRECTORY_TARGET_TENANT_SLUG',
  );
  const feishuAppId = parseOptionalString(source.FEISHU_APP_ID);
  const feishuAppSecret = parseOptionalString(source.FEISHU_APP_SECRET);
  const feishuApiBaseUrl = parseFeishuApiBaseUrl(
    source.FEISHU_API_BASE_URL ?? FEISHU_DEFAULT_API_BASE_URL,
  );
  const feishuHttpTimeoutMs = parseInteger(
    source.FEISHU_HTTP_TIMEOUT_MS,
    'FEISHU_HTTP_TIMEOUT_MS',
    10_000,
    500,
    60_000,
  );
  const feishuSyncLeaseMs = parseInteger(
    source.FEISHU_SYNC_LEASE_MS,
    'FEISHU_SYNC_LEASE_MS',
    1_800_000,
    900_000,
    3_600_000,
  );
  const feishuSyncPreviewTtlMs = parseInteger(
    source.FEISHU_SYNC_PREVIEW_TTL_MS,
    'FEISHU_SYNC_PREVIEW_TTL_MS',
    900_000,
    60_000,
    86_400_000,
  );
  const feishuSyncWorkerEnabled = parseBoolean(
    source.FEISHU_SYNC_WORKER_ENABLED,
    repositoryDriver === 'prisma',
  );
  const feishuSyncWorkerPollIntervalMs = parseInteger(
    source.FEISHU_SYNC_WORKER_POLL_INTERVAL_MS,
    'FEISHU_SYNC_WORKER_POLL_INTERVAL_MS',
    2_000,
    250,
    60_000,
  );
  const feishuSyncWorkerBatchSize = parseInteger(
    source.FEISHU_SYNC_WORKER_BATCH_SIZE,
    'FEISHU_SYNC_WORKER_BATCH_SIZE',
    2,
    1,
    20,
  );
  const feishuSyncMaxAttempts = parseInteger(
    source.FEISHU_SYNC_MAX_ATTEMPTS,
    'FEISHU_SYNC_MAX_ATTEMPTS',
    4,
    1,
    20,
  );
  const feishuSyncRetryBaseMs = parseInteger(
    source.FEISHU_SYNC_RETRY_BASE_MS,
    'FEISHU_SYNC_RETRY_BASE_MS',
    10_000,
    1_000,
    3_600_000,
  );
  const feishuSyncRetryMaxMs = parseInteger(
    source.FEISHU_SYNC_RETRY_MAX_MS,
    'FEISHU_SYNC_RETRY_MAX_MS',
    300_000,
    1_000,
    86_400_000,
  );

  if (nodeEnvironment === 'production' && repositoryDriver === 'memory') {
    throw new Error('REPOSITORY_DRIVER=memory is forbidden in production.');
  }
  if (repositoryDriver === 'prisma' && databaseUrl === undefined) {
    throw new Error('DATABASE_URL is required when REPOSITORY_DRIVER=prisma.');
  }
  if (authAccessTtlSeconds >= authRefreshTtlSeconds) {
    throw new Error('AUTH_ACCESS_TTL_SECONDS must be less than AUTH_REFRESH_TTL_SECONDS.');
  }
  if (authLoginRateLimitNetworkFailures < authLoginRateLimitAccountFailures) {
    throw new Error(
      'AUTH_LOGIN_RATE_LIMIT_NETWORK_FAILURES must be greater than or equal to AUTH_LOGIN_RATE_LIMIT_ACCOUNT_FAILURES.',
    );
  }
  if (authRecoveryRateLimitNetworkRequests < authRecoveryRateLimitAccountRequests) {
    throw new Error(
      'AUTH_RECOVERY_RATE_LIMIT_NETWORK_REQUESTS must be greater than or equal to AUTH_RECOVERY_RATE_LIMIT_ACCOUNT_REQUESTS.',
    );
  }
  if (
    authRecoveryEmailProvider === 'resend' &&
    (authRecoveryEmailApiKey === undefined || authRecoveryEmailFrom === undefined)
  ) {
    throw new Error(
      'AUTH_RECOVERY_EMAIL_API_KEY and AUTH_RECOVERY_EMAIL_FROM are required when AUTH_RECOVERY_EMAIL_PROVIDER=resend.',
    );
  }
  if (nodeEnvironment === 'production' && !authLoginRateLimitEnabled) {
    throw new Error('AUTH_LOGIN_RATE_LIMIT_ENABLED cannot be disabled in production.');
  }
  if (nodeEnvironment === 'production' && !authLoginRateLimitNetworkEnabled) {
    throw new Error('AUTH_LOGIN_RATE_LIMIT_NETWORK_ENABLED cannot be disabled in production.');
  }
  if (nodeEnvironment === 'production' && authTokenPepper.length < 32) {
    throw new Error('AUTH_TOKEN_PEPPER must contain at least 32 characters in production.');
  }
  if (nodeEnvironment === 'production' && connectorCredentialActiveKeyId === undefined) {
    throw new Error(
      'CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID is required in production so connector credentials do not reuse AUTH_TOKEN_PEPPER.',
    );
  }
  if (
    Object.keys(connectorCredentialKeyring).length > 0 &&
    connectorCredentialActiveKeyId === undefined
  ) {
    throw new Error(
      'CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID is required when CONNECTOR_CREDENTIAL_KEYRING_JSON is configured.',
    );
  }
  if (
    connectorCredentialActiveKeyId !== undefined &&
    connectorCredentialKeyring[connectorCredentialActiveKeyId] === undefined
  ) {
    throw new Error(
      'CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID must reference a key in CONNECTOR_CREDENTIAL_KEYRING_JSON.',
    );
  }
  if (nodeEnvironment === 'production' && identitySecretActiveKeyId === undefined) {
    throw new Error(
      'IDENTITY_SECRET_ACTIVE_KEY_ID is required in production for MFA and enterprise IdP secrets.',
    );
  }
  if (Object.keys(identitySecretKeyring).length > 0 && identitySecretActiveKeyId === undefined) {
    throw new Error(
      'IDENTITY_SECRET_ACTIVE_KEY_ID is required when IDENTITY_SECRET_KEYRING_JSON is configured.',
    );
  }
  if (
    identitySecretActiveKeyId !== undefined &&
    identitySecretKeyring[identitySecretActiveKeyId] === undefined
  ) {
    throw new Error(
      'IDENTITY_SECRET_ACTIVE_KEY_ID must reference a key in IDENTITY_SECRET_KEYRING_JSON.',
    );
  }
  if (imOutboxEnabled && repositoryDriver !== 'prisma') {
    throw new Error('IM_OUTBOX_ENABLED=true requires REPOSITORY_DRIVER=prisma.');
  }
  if (agentRunWorkerEnabled && repositoryDriver !== 'prisma') {
    throw new Error('AGENT_RUN_WORKER_ENABLED=true requires REPOSITORY_DRIVER=prisma.');
  }
  if (toolExecutionWorkerEnabled && repositoryDriver !== 'prisma') {
    throw new Error('TOOL_EXECUTION_WORKER_ENABLED=true requires REPOSITORY_DRIVER=prisma.');
  }
  if (finopsProjectionWorkerEnabled && repositoryDriver !== 'prisma') {
    throw new Error('FINOPS_PROJECTION_WORKER_ENABLED=true requires REPOSITORY_DRIVER=prisma.');
  }
  if (knowledgeIngestionWorkerEnabled && repositoryDriver !== 'prisma') {
    throw new Error('KNOWLEDGE_INGESTION_WORKER_ENABLED=true requires REPOSITORY_DRIVER=prisma.');
  }
  if (knowledgePersistentWritesEnabled && repositoryDriver !== 'prisma') {
    throw new Error('KNOWLEDGE_PERSISTENT_WRITES_ENABLED=true requires REPOSITORY_DRIVER=prisma.');
  }
  if (
    nodeEnvironment === 'production' &&
    knowledgePersistentWritesEnabled &&
    !knowledgeIngestionWorkerEnabled
  ) {
    throw new Error(
      'KNOWLEDGE_PERSISTENT_WRITES_ENABLED=true requires KNOWLEDGE_INGESTION_WORKER_ENABLED=true in production.',
    );
  }
  if (
    nodeEnvironment === 'production' &&
    (imOutboxEnabled ||
      agentRunWorkerEnabled ||
      toolExecutionWorkerEnabled ||
      finopsProjectionWorkerEnabled ||
      knowledgeIngestionWorkerEnabled)
  ) {
    if (configuredOutboxDatabaseUrl === undefined) {
      throw new Error('OUTBOX_DATABASE_URL is required for an enabled production outbox worker.');
    }
    const apiDatabaseUsername = parseDatabaseUsername(databaseUrl, 'DATABASE_URL');
    const outboxDatabaseUsername = parseDatabaseUsername(
      configuredOutboxDatabaseUrl,
      'OUTBOX_DATABASE_URL',
    );
    const conflictingCapabilityUsernames = [
      apiDatabaseUsername,
      ...(configuredAuthDatabaseUrl === undefined
        ? []
        : [parseDatabaseUsername(configuredAuthDatabaseUrl, 'AUTH_DATABASE_URL')]),
      ...(configuredAdminDatabaseUrl === undefined
        ? []
        : [parseDatabaseUsername(configuredAdminDatabaseUrl, 'ADMIN_DATABASE_URL')]),
      ...(configuredLifecycleDatabaseUrl === undefined
        ? []
        : [parseDatabaseUsername(configuredLifecycleDatabaseUrl, 'LIFECYCLE_DATABASE_URL')]),
      ...(configuredScimDatabaseUrl === undefined
        ? []
        : [parseDatabaseUsername(configuredScimDatabaseUrl, 'SCIM_DATABASE_URL')]),
    ];
    if (conflictingCapabilityUsernames.includes(outboxDatabaseUsername)) {
      throw new Error(
        'OUTBOX_DATABASE_URL must use a different production username from DATABASE_URL, AUTH_DATABASE_URL, ADMIN_DATABASE_URL, LIFECYCLE_DATABASE_URL, and SCIM_DATABASE_URL.',
      );
    }
  }
  if (
    nodeEnvironment === 'production' &&
    agentRunWorkerEnabled &&
    new URL(aiRuntimeUrl).protocol !== 'https:'
  ) {
    throw new Error('AI_RUNTIME_URL must use HTTPS for an enabled production Agent worker.');
  }
  if (
    nodeEnvironment === 'production' &&
    (agentRunWorkerEnabled || knowledgeSemanticSearchEnabled || knowledgeRerankEnabled) &&
    (aiRuntimeServiceToken === undefined || aiRuntimeServiceToken.length < 32)
  ) {
    throw new Error(
      'AI_RUNTIME_SERVICE_TOKEN must contain at least 32 characters when production AI Runtime access is enabled.',
    );
  }
  if (
    nodeEnvironment === 'production' &&
    aiEvaluationRunnerHmacSecret !== undefined &&
    aiEvaluationRunnerHmacSecret.length < 32
  ) {
    throw new Error(
      'AI_EVALUATION_RUNNER_HMAC_SECRET must contain at least 32 characters in production.',
    );
  }
  if (nodeEnvironment === 'production' && repositoryDriver === 'prisma') {
    if (
      configuredAuthDatabaseUrl === undefined ||
      configuredAdminDatabaseUrl === undefined ||
      configuredLifecycleDatabaseUrl === undefined ||
      configuredScimDatabaseUrl === undefined
    ) {
      throw new Error(
        'AUTH_DATABASE_URL, ADMIN_DATABASE_URL, LIFECYCLE_DATABASE_URL, and SCIM_DATABASE_URL are required for the production Prisma adapter.',
      );
    }
    const usernames = [
      parseDatabaseUsername(databaseUrl, 'DATABASE_URL'),
      parseDatabaseUsername(configuredAuthDatabaseUrl, 'AUTH_DATABASE_URL'),
      parseDatabaseUsername(configuredAdminDatabaseUrl, 'ADMIN_DATABASE_URL'),
      parseDatabaseUsername(configuredLifecycleDatabaseUrl, 'LIFECYCLE_DATABASE_URL'),
      parseDatabaseUsername(configuredScimDatabaseUrl, 'SCIM_DATABASE_URL'),
    ];
    if (new Set(usernames).size !== usernames.length) {
      throw new Error(
        'DATABASE_URL, AUTH_DATABASE_URL, ADMIN_DATABASE_URL, LIFECYCLE_DATABASE_URL, and SCIM_DATABASE_URL must use different production usernames.',
      );
    }
  }
  if (nodeEnvironment === 'production' && imOutboxEnabled && imProvider === 'local') {
    throw new Error('IM_PROVIDER=local is forbidden when the production outbox worker is enabled.');
  }
  if (imProvider === 'tencent') {
    if (tencentSdkAppId === undefined) {
      throw new Error('TENCENT_IM_SDK_APP_ID is required when IM_PROVIDER=tencent.');
    }
    if (!isTencentAccountId(tencentAdminUserId)) {
      throw new Error(
        'TENCENT_IM_ADMIN_USER_ID must be 1-32 ASCII bytes using letters, numbers, _ or -.',
      );
    }
    if (tencentSecretKey === undefined) {
      throw new Error('TENCENT_IM_SECRET_KEY is required when IM_PROVIDER=tencent.');
    }
    if (imOutboxEnabled && tencentHttpTimeoutMs >= imProviderTimeoutMs) {
      throw new Error('TENCENT_IM_HTTP_TIMEOUT_MS must be less than IM_PROVIDER_TIMEOUT_MS.');
    }
  }
  if (imProvider === 'wukong') {
    if (wukongTokenSigningSecret === undefined) {
      throw new Error('WUKONG_IM_TOKEN_SIGNING_SECRET is required when IM_PROVIDER=wukong.');
    }
    if (nodeEnvironment === 'production' && wukongTokenSigningSecret.length < 32) {
      throw new Error(
        'WUKONG_IM_TOKEN_SIGNING_SECRET must contain at least 32 characters in production.',
      );
    }
    if (nodeEnvironment === 'production' && wukongApiToken === undefined) {
      throw new Error('WUKONG_IM_API_TOKEN is required when production uses WuKongIM.');
    }
    if (nodeEnvironment === 'production' && !wukongVerifiedAuthEnabled) {
      throw new Error(
        'WUKONG_IM_VERIFIED_AUTH_ENABLED=true is required after REST proxy and gateway token verification have been independently tested.',
      );
    }
    if (imOutboxEnabled && wukongHttpTimeoutMs >= imProviderTimeoutMs) {
      throw new Error('WUKONG_IM_HTTP_TIMEOUT_MS must be less than IM_PROVIDER_TIMEOUT_MS.');
    }
  }
  if (imOutboxRetryBaseMs > imOutboxRetryMaxMs) {
    throw new Error('IM_OUTBOX_RETRY_BASE_MS must not exceed IM_OUTBOX_RETRY_MAX_MS.');
  }
  if (imOutboxClaimTtlMs <= imProviderTimeoutMs) {
    throw new Error('IM_OUTBOX_CLAIM_TTL_MS must be greater than IM_PROVIDER_TIMEOUT_MS.');
  }
  if (agentRunClaimTtlMs <= aiRuntimeHttpTimeoutMs + 15_000) {
    throw new Error(
      'AGENT_RUN_CLAIM_TTL_MS must exceed AI_RUNTIME_HTTP_TIMEOUT_MS by more than 15000ms.',
    );
  }
  if (toolExecutionClaimTtlMs <= 135_000) {
    throw new Error(
      'TOOL_EXECUTION_CLAIM_TTL_MS must exceed the maximum Tool timeout by more than 15000ms.',
    );
  }
  if (
    nodeEnvironment === 'production' &&
    toolExecutionWorkerEnabled &&
    source.TOOL_DNS_SERVERS === undefined
  ) {
    throw new Error(
      'TOOL_DNS_SERVERS must explicitly name the platform-controlled resolver in production.',
    );
  }
  if (knowledgeSemanticSearchEnabled && repositoryDriver !== 'prisma') {
    throw new Error('KNOWLEDGE_SEMANTIC_SEARCH_ENABLED=true requires REPOSITORY_DRIVER=prisma.');
  }
  if (knowledgeRerankEnabled && !knowledgeSemanticSearchEnabled) {
    throw new Error('KNOWLEDGE_RERANK_ENABLED=true requires semantic search.');
  }
  if (knowledgeIngestionRetryBaseMs > knowledgeIngestionRetryMaxMs) {
    throw new Error(
      'KNOWLEDGE_INGESTION_RETRY_BASE_MS must not exceed KNOWLEDGE_INGESTION_RETRY_MAX_MS.',
    );
  }
  if (knowledgeIngestionClaimTtlMs <= knowledgeAiTimeoutMs + 15_000) {
    throw new Error(
      'KNOWLEDGE_INGESTION_CLAIM_TTL_MS must exceed KNOWLEDGE_AI_TIMEOUT_MS by more than 15000ms.',
    );
  }
  if (feishuDirectorySyncEnabled) {
    if (repositoryDriver !== 'prisma') {
      throw new Error('FEISHU_DIRECTORY_SYNC_ENABLED=true requires REPOSITORY_DRIVER=prisma.');
    }
    if (feishuDirectoryTargetTenantSlug === undefined) {
      throw new Error(
        'FEISHU_DIRECTORY_TARGET_TENANT_SLUG is required when Feishu directory sync is enabled.',
      );
    }
    if (feishuAppId === undefined) {
      throw new Error('FEISHU_APP_ID is required when Feishu directory sync is enabled.');
    }
    if (feishuAppSecret === undefined) {
      throw new Error('FEISHU_APP_SECRET is required when Feishu directory sync is enabled.');
    }
    if (feishuSyncLeaseMs <= feishuHttpTimeoutMs) {
      throw new Error('FEISHU_SYNC_LEASE_MS must be greater than FEISHU_HTTP_TIMEOUT_MS.');
    }
  }
  if (feishuSyncWorkerEnabled && repositoryDriver !== 'prisma') {
    throw new Error('FEISHU_SYNC_WORKER_ENABLED=true requires REPOSITORY_DRIVER=prisma.');
  }
  if (feishuSyncRetryBaseMs > feishuSyncRetryMaxMs) {
    throw new Error('FEISHU_SYNC_RETRY_BASE_MS must not exceed FEISHU_SYNC_RETRY_MAX_MS.');
  }
  if (nodeEnvironment === 'production' && authRecoveryEmailProvider !== 'resend') {
    throw new Error('AUTH_RECOVERY_EMAIL_PROVIDER must be resend in production.');
  }
  if (nodeEnvironment === 'production' && knowledgeObjectStoreDriver === 'local') {
    throw new Error('KNOWLEDGE_OBJECT_STORE_DRIVER=local is forbidden in production.');
  }
  if (knowledgeObjectStoreDriver === 's3') {
    if (knowledgeObjectStoreS3Bucket === undefined) {
      throw new Error(
        'KNOWLEDGE_OBJECT_STORE_S3_BUCKET is required when KNOWLEDGE_OBJECT_STORE_DRIVER=s3.',
      );
    }
    if (
      knowledgeObjectStoreS3CredentialMode === 'static' &&
      (knowledgeObjectStoreS3AccessKeyId === undefined ||
        knowledgeObjectStoreS3SecretAccessKey === undefined)
    ) {
      throw new Error(
        'KNOWLEDGE_OBJECT_STORE_S3_ACCESS_KEY_ID and KNOWLEDGE_OBJECT_STORE_S3_SECRET_ACCESS_KEY are required in static credential mode.',
      );
    }
    if (
      knowledgeObjectStoreS3CredentialMode === 'default_chain' &&
      (knowledgeObjectStoreS3AccessKeyId !== undefined ||
        knowledgeObjectStoreS3SecretAccessKey !== undefined)
    ) {
      throw new Error(
        'Static S3 credentials must not be set when KNOWLEDGE_OBJECT_STORE_S3_CREDENTIAL_MODE=default_chain.',
      );
    }
    if (nodeEnvironment === 'production' && knowledgeObjectStoreS3KmsKeyId === undefined) {
      throw new Error(
        'KNOWLEDGE_OBJECT_STORE_S3_KMS_KEY_ID is required for the S3 knowledge object store in production.',
      );
    }
  }
  if (nodeEnvironment === 'production' && knowledgeFileScannerDriver === 'disabled') {
    throw new Error('KNOWLEDGE_FILE_SCANNER_DRIVER=disabled is forbidden in production.');
  }
  if (knowledgeFileScannerTimeoutMs >= knowledgeIngestionClaimTtlMs) {
    throw new Error(
      'KNOWLEDGE_FILE_SCANNER_TIMEOUT_MS must be less than KNOWLEDGE_INGESTION_CLAIM_TTL_MS.',
    );
  }
  if (knowledgeDocumentParserDriver === 'docling') {
    if (knowledgeDoclingBaseUrl === undefined) {
      throw new Error(
        'KNOWLEDGE_DOCLING_BASE_URL is required when KNOWLEDGE_DOCUMENT_PARSER_DRIVER=docling.',
      );
    }
    if (nodeEnvironment === 'production' && knowledgeDoclingApiKey === undefined) {
      throw new Error('KNOWLEDGE_DOCLING_API_KEY is required for Docling in production.');
    }
  }
  if (nodeEnvironment === 'production' && knowledgeDocumentParserDriver !== 'docling') {
    throw new Error('KNOWLEDGE_DOCUMENT_PARSER_DRIVER must be docling in production.');
  }
  if (nodeEnvironment === 'production' && knowledgeWebImportAllowedHosts.length === 0) {
    throw new Error(
      'KNOWLEDGE_WEB_IMPORT_ALLOWED_HOSTS must explicitly allow at least one host in production.',
    );
  }

  return {
    NODE_ENV: nodeEnvironment,
    PORT: port,
    HOST: host,
    CORS_ORIGINS: corsOrigins,
    REPOSITORY_DRIVER: repositoryDriver,
    ...(databaseUrl === undefined ? {} : { DATABASE_URL: databaseUrl }),
    ...(configuredOutboxDatabaseUrl === undefined
      ? databaseUrl === undefined
        ? {}
        : { OUTBOX_DATABASE_URL: databaseUrl }
      : { OUTBOX_DATABASE_URL: configuredOutboxDatabaseUrl }),
    ...(configuredAuthDatabaseUrl === undefined
      ? databaseUrl === undefined
        ? {}
        : { AUTH_DATABASE_URL: databaseUrl }
      : { AUTH_DATABASE_URL: configuredAuthDatabaseUrl }),
    ...(configuredAdminDatabaseUrl === undefined
      ? databaseUrl === undefined
        ? {}
        : { ADMIN_DATABASE_URL: databaseUrl }
      : { ADMIN_DATABASE_URL: configuredAdminDatabaseUrl }),
    ...(configuredLifecycleDatabaseUrl === undefined
      ? databaseUrl === undefined
        ? {}
        : { LIFECYCLE_DATABASE_URL: databaseUrl }
      : { LIFECYCLE_DATABASE_URL: configuredLifecycleDatabaseUrl }),
    ...(configuredScimDatabaseUrl === undefined
      ? databaseUrl === undefined
        ? {}
        : { SCIM_DATABASE_URL: databaseUrl }
      : { SCIM_DATABASE_URL: configuredScimDatabaseUrl }),
    AUTH_TOKEN_PEPPER: authTokenPepper,
    CONNECTOR_CREDENTIAL_KEYRING: connectorCredentialKeyring,
    ...(connectorCredentialActiveKeyId === undefined
      ? {}
      : { CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID: connectorCredentialActiveKeyId }),
    IDENTITY_SECRET_KEYRING: identitySecretKeyring,
    ...(identitySecretActiveKeyId === undefined
      ? {}
      : { IDENTITY_SECRET_ACTIVE_KEY_ID: identitySecretActiveKeyId }),
    AUTH_ACCESS_TTL_SECONDS: authAccessTtlSeconds,
    AUTH_REFRESH_TTL_SECONDS: authRefreshTtlSeconds,
    AUTH_MFA_CHALLENGE_TTL_SECONDS: authMfaChallengeTtlSeconds,
    IDENTITY_OIDC_HTTP_TIMEOUT_MS: identityOidcHttpTimeoutMs,
    AUTH_LOGIN_RATE_LIMIT_ENABLED: authLoginRateLimitEnabled,
    AUTH_LOGIN_RATE_LIMIT_NETWORK_ENABLED: authLoginRateLimitNetworkEnabled,
    AUTH_LOGIN_RATE_LIMIT_ACCOUNT_FAILURES: authLoginRateLimitAccountFailures,
    AUTH_LOGIN_RATE_LIMIT_NETWORK_FAILURES: authLoginRateLimitNetworkFailures,
    AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS: authLoginRateLimitWindowSeconds,
    AUTH_LOGIN_RATE_LIMIT_BLOCK_SECONDS: authLoginRateLimitBlockSeconds,
    AUTH_RATE_LIMIT_BUCKET_CAPACITY_PER_SCOPE: authRateLimitBucketCapacityPerScope,
    AUTH_RECOVERY_RATE_LIMIT_ACCOUNT_REQUESTS: authRecoveryRateLimitAccountRequests,
    AUTH_RECOVERY_RATE_LIMIT_NETWORK_REQUESTS: authRecoveryRateLimitNetworkRequests,
    AUTH_RECOVERY_RATE_LIMIT_WINDOW_SECONDS: authRecoveryRateLimitWindowSeconds,
    AUTH_PASSWORD_RESET_TTL_SECONDS: authPasswordResetTtlSeconds,
    AUTH_MEMBER_INVITATION_TTL_SECONDS: authMemberInvitationTtlSeconds,
    AUTH_MEMBER_INVITATION_FALLBACK_TTL_SECONDS: authMemberInvitationFallbackTtlSeconds,
    AUTH_RECOVERY_EMAIL_PROVIDER: authRecoveryEmailProvider,
    ...(authRecoveryEmailApiKey === undefined
      ? {}
      : { AUTH_RECOVERY_EMAIL_API_KEY: authRecoveryEmailApiKey }),
    ...(authRecoveryEmailFrom === undefined
      ? {}
      : { AUTH_RECOVERY_EMAIL_FROM: authRecoveryEmailFrom }),
    AUTH_RECOVERY_EMAIL_HTTP_TIMEOUT_MS: authRecoveryEmailHttpTimeoutMs,
    AUTH_PUBLIC_APP_URL: authPublicAppUrl,
    REGISTRATION_MODE: registrationMode,
    ALLOW_DEV_IDENTITY_HEADERS: allowDevIdentityHeaders,
    DEV_TENANT_ID: parseUuid(
      source.DEV_TENANT_ID ?? source.DEFAULT_TENANT_ID ?? DEFAULT_TENANT_ID,
      'DEV_TENANT_ID',
    ),
    DEV_USER_ID: parseUuid(source.DEV_USER_ID ?? DEFAULT_USER_ID, 'DEV_USER_ID'),
    TRUST_PROXY_IDENTITY_HEADERS: parseBoolean(source.TRUST_PROXY_IDENTITY_HEADERS, false),
    IM_OUTBOX_ENABLED: imOutboxEnabled,
    IM_PROVIDER: imProvider,
    IM_OUTBOX_POLL_INTERVAL_MS: imOutboxPollIntervalMs,
    IM_OUTBOX_BATCH_SIZE: imOutboxBatchSize,
    IM_OUTBOX_MAX_ATTEMPTS: imOutboxMaxAttempts,
    IM_OUTBOX_RETRY_BASE_MS: imOutboxRetryBaseMs,
    IM_OUTBOX_RETRY_MAX_MS: imOutboxRetryMaxMs,
    IM_OUTBOX_CLAIM_TTL_MS: imOutboxClaimTtlMs,
    IM_PROVIDER_TIMEOUT_MS: imProviderTimeoutMs,
    ...(tencentSdkAppId === undefined ? {} : { TENCENT_IM_SDK_APP_ID: tencentSdkAppId }),
    ...(tencentAdminUserId === undefined ? {} : { TENCENT_IM_ADMIN_USER_ID: tencentAdminUserId }),
    ...(tencentSecretKey === undefined ? {} : { TENCENT_IM_SECRET_KEY: tencentSecretKey }),
    TENCENT_IM_API_BASE_URL: tencentApiBaseUrl,
    TENCENT_IM_USER_SIG_TTL_SECONDS: tencentUserSigTtlSeconds,
    TENCENT_IM_HTTP_TIMEOUT_MS: tencentHttpTimeoutMs,
    WUKONG_IM_API_BASE_URL: wukongApiBaseUrl,
    WUKONG_IM_PUBLIC_WS_URL: wukongPublicWsUrl,
    ...(wukongApiToken === undefined ? {} : { WUKONG_IM_API_TOKEN: wukongApiToken }),
    ...(wukongTokenSigningSecret === undefined
      ? {}
      : { WUKONG_IM_TOKEN_SIGNING_SECRET: wukongTokenSigningSecret }),
    WUKONG_IM_HTTP_TIMEOUT_MS: wukongHttpTimeoutMs,
    WUKONG_IM_VERIFIED_AUTH_ENABLED: wukongVerifiedAuthEnabled,
    AGENT_RUN_WORKER_ENABLED: agentRunWorkerEnabled,
    AGENT_RUN_WORKER_CONCURRENCY: agentRunWorkerConcurrency,
    AGENT_RUN_POLL_INTERVAL_MS: agentRunPollIntervalMs,
    AGENT_RUN_CLAIM_TTL_MS: agentRunClaimTtlMs,
    TOOL_EXECUTION_WORKER_ENABLED: toolExecutionWorkerEnabled,
    TOOL_EXECUTION_WORKER_CONCURRENCY: toolExecutionWorkerConcurrency,
    TOOL_EXECUTION_POLL_INTERVAL_MS: toolExecutionPollIntervalMs,
    TOOL_EXECUTION_CLAIM_TTL_MS: toolExecutionClaimTtlMs,
    TOOL_MAX_CONCURRENT_PER_VERSION: toolMaxConcurrentPerVersion,
    TOOL_MAX_STARTS_PER_MINUTE_PER_VERSION: toolMaxStartsPerMinutePerVersion,
    TOOL_PROVIDER_MAX_RESPONSE_BYTES: toolProviderMaxResponseBytes,
    TOOL_CIRCUIT_FAILURE_THRESHOLD: toolCircuitFailureThreshold,
    TOOL_CIRCUIT_OPEN_MS: toolCircuitOpenMs,
    TOOL_ENDPOINT_BINDINGS: toolEndpointBindings,
    TOOL_DNS_SERVERS: toolDnsServers,
    FINOPS_PROJECTION_WORKER_ENABLED: finopsProjectionWorkerEnabled,
    FINOPS_PROJECTION_BATCH_SIZE: finopsProjectionBatchSize,
    FINOPS_PROJECTION_POLL_INTERVAL_MS: finopsProjectionPollIntervalMs,
    FINOPS_PROJECTION_CLAIM_TTL_MS: finopsProjectionClaimTtlMs,
    AI_RUNTIME_URL: aiRuntimeUrl,
    AI_RUNTIME_HTTP_TIMEOUT_MS: aiRuntimeHttpTimeoutMs,
    ...(aiRuntimeServiceToken === undefined
      ? {}
      : { AI_RUNTIME_SERVICE_TOKEN: aiRuntimeServiceToken }),
    ...(aiEvaluationRunnerHmacSecret === undefined
      ? {}
      : { AI_EVALUATION_RUNNER_HMAC_SECRET: aiEvaluationRunnerHmacSecret }),
    KNOWLEDGE_SEMANTIC_SEARCH_ENABLED: knowledgeSemanticSearchEnabled,
    KNOWLEDGE_RERANK_ENABLED: knowledgeRerankEnabled,
    KNOWLEDGE_AI_TIMEOUT_MS: knowledgeAiTimeoutMs,
    KNOWLEDGE_EMBEDDING_DIMENSIONS: knowledgeEmbeddingDimensions,
    KNOWLEDGE_VECTOR_SEARCH_MODE: knowledgeVectorSearchMode,
    KNOWLEDGE_OBJECT_STORE_DRIVER: knowledgeObjectStoreDriver,
    KNOWLEDGE_OBJECT_STORE_MAX_BYTES: knowledgeObjectStoreMaxBytes,
    ...(knowledgeObjectStoreLocalRoot === undefined
      ? {}
      : { KNOWLEDGE_OBJECT_STORE_LOCAL_ROOT: knowledgeObjectStoreLocalRoot }),
    ...(knowledgeObjectStoreS3Endpoint === undefined
      ? {}
      : { KNOWLEDGE_OBJECT_STORE_S3_ENDPOINT: knowledgeObjectStoreS3Endpoint }),
    KNOWLEDGE_OBJECT_STORE_S3_REGION: knowledgeObjectStoreS3Region,
    ...(knowledgeObjectStoreS3Bucket === undefined
      ? {}
      : { KNOWLEDGE_OBJECT_STORE_S3_BUCKET: knowledgeObjectStoreS3Bucket }),
    KNOWLEDGE_OBJECT_STORE_S3_CREDENTIAL_MODE: knowledgeObjectStoreS3CredentialMode,
    ...(knowledgeObjectStoreS3AccessKeyId === undefined
      ? {}
      : { KNOWLEDGE_OBJECT_STORE_S3_ACCESS_KEY_ID: knowledgeObjectStoreS3AccessKeyId }),
    ...(knowledgeObjectStoreS3SecretAccessKey === undefined
      ? {}
      : {
          KNOWLEDGE_OBJECT_STORE_S3_SECRET_ACCESS_KEY: knowledgeObjectStoreS3SecretAccessKey,
        }),
    KNOWLEDGE_OBJECT_STORE_S3_FORCE_PATH_STYLE: knowledgeObjectStoreS3ForcePathStyle,
    KNOWLEDGE_OBJECT_STORE_S3_PREFIX: knowledgeObjectStoreS3Prefix,
    ...(knowledgeObjectStoreS3KmsKeyId === undefined
      ? {}
      : { KNOWLEDGE_OBJECT_STORE_S3_KMS_KEY_ID: knowledgeObjectStoreS3KmsKeyId }),
    KNOWLEDGE_FILE_SCANNER_DRIVER: knowledgeFileScannerDriver,
    KNOWLEDGE_FILE_SCANNER_CLAMAV_HOST: knowledgeFileScannerClamAvHost,
    KNOWLEDGE_FILE_SCANNER_CLAMAV_PORT: knowledgeFileScannerClamAvPort,
    KNOWLEDGE_FILE_SCANNER_TIMEOUT_MS: knowledgeFileScannerTimeoutMs,
    KNOWLEDGE_DOCUMENT_PARSER_DRIVER: knowledgeDocumentParserDriver,
    ...(knowledgeDoclingBaseUrl === undefined
      ? {}
      : { KNOWLEDGE_DOCLING_BASE_URL: knowledgeDoclingBaseUrl }),
    ...(knowledgeDoclingApiKey === undefined
      ? {}
      : { KNOWLEDGE_DOCLING_API_KEY: knowledgeDoclingApiKey }),
    KNOWLEDGE_DOCLING_TIMEOUT_MS: knowledgeDoclingTimeoutMs,
    KNOWLEDGE_DOCLING_MAX_RESPONSE_BYTES: knowledgeDoclingMaxResponseBytes,
    KNOWLEDGE_WEB_IMPORT_ALLOWED_HOSTS: knowledgeWebImportAllowedHosts,
    KNOWLEDGE_WEB_IMPORT_TIMEOUT_MS: knowledgeWebImportTimeoutMs,
    KNOWLEDGE_WEB_IMPORT_MAX_BYTES: knowledgeWebImportMaxBytes,
    KNOWLEDGE_PERSISTENT_WRITES_ENABLED: knowledgePersistentWritesEnabled,
    KNOWLEDGE_INGESTION_WORKER_ENABLED: knowledgeIngestionWorkerEnabled,
    KNOWLEDGE_INGESTION_POLL_INTERVAL_MS: knowledgeIngestionPollIntervalMs,
    KNOWLEDGE_INGESTION_BATCH_SIZE: knowledgeIngestionBatchSize,
    KNOWLEDGE_INGESTION_MAX_ATTEMPTS: knowledgeIngestionMaxAttempts,
    KNOWLEDGE_INGESTION_RETRY_BASE_MS: knowledgeIngestionRetryBaseMs,
    KNOWLEDGE_INGESTION_RETRY_MAX_MS: knowledgeIngestionRetryMaxMs,
    KNOWLEDGE_INGESTION_CLAIM_TTL_MS: knowledgeIngestionClaimTtlMs,
    FEISHU_DIRECTORY_SYNC_ENABLED: feishuDirectorySyncEnabled,
    FEISHU_DIRECTORY_RECONCILE_REMOVALS: feishuDirectoryReconcileRemovals,
    ...(feishuDirectoryTargetTenantSlug === undefined
      ? {}
      : { FEISHU_DIRECTORY_TARGET_TENANT_SLUG: feishuDirectoryTargetTenantSlug }),
    ...(feishuAppId === undefined ? {} : { FEISHU_APP_ID: feishuAppId }),
    ...(feishuAppSecret === undefined ? {} : { FEISHU_APP_SECRET: feishuAppSecret }),
    FEISHU_API_BASE_URL: feishuApiBaseUrl,
    FEISHU_HTTP_TIMEOUT_MS: feishuHttpTimeoutMs,
    FEISHU_SYNC_LEASE_MS: feishuSyncLeaseMs,
    FEISHU_SYNC_PREVIEW_TTL_MS: feishuSyncPreviewTtlMs,
    FEISHU_SYNC_WORKER_ENABLED: feishuSyncWorkerEnabled,
    FEISHU_SYNC_WORKER_POLL_INTERVAL_MS: feishuSyncWorkerPollIntervalMs,
    FEISHU_SYNC_WORKER_BATCH_SIZE: feishuSyncWorkerBatchSize,
    FEISHU_SYNC_MAX_ATTEMPTS: feishuSyncMaxAttempts,
    FEISHU_SYNC_RETRY_BASE_MS: feishuSyncRetryBaseMs,
    FEISHU_SYNC_RETRY_MAX_MS: feishuSyncRetryMaxMs,
  };
}

function parseKnowledgeVectorSearchMode(value: unknown): 'exact' | 'hnsw' {
  const parsed = value ?? 'exact';
  if (parsed !== 'exact' && parsed !== 'hnsw') {
    throw new Error('KNOWLEDGE_VECTOR_SEARCH_MODE must be exact or hnsw.');
  }
  return parsed;
}

function parseKnowledgeObjectStoreDriver(value: unknown): 'local' | 's3' {
  const parsed = value ?? 'local';
  if (parsed !== 'local' && parsed !== 's3') {
    throw new Error('KNOWLEDGE_OBJECT_STORE_DRIVER must be local or s3.');
  }
  return parsed;
}

function parseKnowledgeFileScannerDriver(value: unknown): 'disabled' | 'clamav' {
  const parsed = value ?? 'disabled';
  if (parsed !== 'disabled' && parsed !== 'clamav') {
    throw new Error('KNOWLEDGE_FILE_SCANNER_DRIVER must be disabled or clamav.');
  }
  return parsed;
}

function parseKnowledgeDocumentParserDriver(value: unknown): 'local' | 'docling' {
  const parsed = value ?? 'local';
  if (parsed !== 'local' && parsed !== 'docling') {
    throw new Error('KNOWLEDGE_DOCUMENT_PARSER_DRIVER must be local or docling.');
  }
  return parsed;
}

function parseServiceHost(value: unknown, key: string, fallback: string): string {
  const parsed = parseOptionalString(value) ?? fallback;
  if (parsed.length > 253 || /[\s/\\@?#\u0000-\u001f\u007f]/u.test(parsed)) {
    throw new Error(`${key} is invalid.`);
  }
  return parsed;
}

function parseOptionalServiceOrigin(
  value: unknown,
  key: string,
  environment: NodeEnvironment,
): string | undefined {
  const configured = parseOptionalString(value);
  if (configured === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(`${key} must be an HTTP(S) origin.`);
  }
  if (
    (parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && environment !== 'production')) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error(`${key} must be an HTTPS origin (HTTP is allowed outside production).`);
  }
  return parsed.origin;
}

function parseOptionalSecret(value: unknown, key: string): string | undefined {
  const parsed = parseOptionalString(value);
  if (parsed === undefined) return undefined;
  if (parsed.length < 16 || parsed.length > 512 || /[\u0000-\u001f\u007f\s]/u.test(parsed)) {
    throw new Error(`${key} must contain 16-512 non-whitespace characters.`);
  }
  return parsed;
}

function parseOptionalAbsolutePath(value: unknown, key: string): string | undefined {
  const parsed = parseOptionalString(value);
  if (parsed === undefined) return undefined;
  if (!isAbsolute(parsed)) throw new Error(`${key} must be an absolute path.`);
  return parsed;
}

function parseOptionalS3Endpoint(value: unknown, environment: NodeEnvironment): string | undefined {
  const configured = parseOptionalString(value);
  if (configured === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('KNOWLEDGE_OBJECT_STORE_S3_ENDPOINT must be an HTTP(S) origin.');
  }
  if (
    (parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && environment !== 'production')) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error(
      'KNOWLEDGE_OBJECT_STORE_S3_ENDPOINT must be an HTTPS origin (HTTP is allowed outside production).',
    );
  }
  return parsed.origin;
}

function parseS3Region(value: unknown): string {
  const parsed = parseOptionalString(value) ?? 'us-east-1';
  if (parsed.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(parsed)) {
    throw new Error('KNOWLEDGE_OBJECT_STORE_S3_REGION is invalid.');
  }
  return parsed;
}

function parseOptionalS3Bucket(value: unknown): string | undefined {
  const parsed = parseOptionalString(value);
  if (parsed === undefined) return undefined;
  if (
    parsed.length < 3 ||
    parsed.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(parsed) ||
    parsed.includes('..') ||
    parsed.includes('.-') ||
    parsed.includes('-.') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed)
  ) {
    throw new Error('KNOWLEDGE_OBJECT_STORE_S3_BUCKET is not a valid DNS-style bucket name.');
  }
  return parsed;
}

function parseS3CredentialMode(value: unknown): 'default_chain' | 'static' {
  const parsed = value ?? 'default_chain';
  if (parsed !== 'default_chain' && parsed !== 'static') {
    throw new Error('KNOWLEDGE_OBJECT_STORE_S3_CREDENTIAL_MODE must be default_chain or static.');
  }
  return parsed;
}

function parseOptionalS3Credential(
  value: unknown,
  key: string,
  minimumLength: number,
): string | undefined {
  const parsed = parseOptionalString(value);
  if (parsed === undefined) return undefined;
  if (
    parsed.length < minimumLength ||
    parsed.length > 256 ||
    /[\u0000-\u001f\u007f\s]/.test(parsed)
  ) {
    throw new Error(`${key} must contain ${minimumLength}-256 non-whitespace characters.`);
  }
  return parsed;
}

function parseS3Prefix(value: unknown): string {
  const parsed = (parseOptionalString(value) ?? 'knowledge/v1')
    .replaceAll('\\', '/')
    .replace(/^\/+|\/+$/g, '');
  if (
    parsed.length === 0 ||
    parsed.length > 200 ||
    parsed.split('/').some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))
  ) {
    throw new Error('KNOWLEDGE_OBJECT_STORE_S3_PREFIX contains an unsafe path segment.');
  }
  return parsed;
}

function parseOptionalS3KmsKeyReference(
  value: unknown,
  environment: NodeEnvironment,
  region: string,
): S3KmsKeyReference | undefined {
  const parsed = parseOptionalString(value);
  if (parsed === undefined) return undefined;
  if (
    parsed.length > 256 ||
    /[\u0000-\u001f\u007f\s]/u.test(parsed) ||
    (!isKmsKeyArn(parsed) &&
      !/^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|mrk-[0-9a-f]{32}|alias\/[A-Za-z0-9/_-]{1,249})$/i.test(
        parsed,
      ))
  ) {
    throw new Error(
      'KNOWLEDGE_OBJECT_STORE_S3_KMS_KEY_ID must be a KMS key ARN, key ID, multi-Region key ID, or alias.',
    );
  }
  if (environment === 'production') {
    const arn = parseKmsKeyArn(parsed);
    if (arn === undefined) {
      throw new Error(
        'KNOWLEDGE_OBJECT_STORE_S3_KMS_KEY_ID must be a customer-managed KMS key ARN in production.',
      );
    }
    if (arn.region !== region || arn.partition !== kmsPartitionForRegion(region)) {
      throw new Error(
        'KNOWLEDGE_OBJECT_STORE_S3_KMS_KEY_ID must match KNOWLEDGE_OBJECT_STORE_S3_REGION and its AWS partition.',
      );
    }
  }
  return parsed as S3KmsKeyReference;
}

function isKmsKeyArn(value: string): boolean {
  return parseKmsKeyArn(value) !== undefined;
}

function parseKmsKeyArn(
  value: string,
): { readonly partition: string; readonly region: string } | undefined {
  const match =
    /^arn:(aws|aws-cn|aws-us-gov):kms:([a-z0-9-]+):[0-9]{12}:key\/(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$/i.exec(
      value,
    );
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { partition: match[1].toLowerCase(), region: match[2].toLowerCase() };
}

function kmsPartitionForRegion(region: string): string {
  if (region.startsWith('cn-')) return 'aws-cn';
  if (region.startsWith('us-gov-')) return 'aws-us-gov';
  return 'aws';
}

function parseConnectorCredentialKeyring(value: unknown): Readonly<Record<string, string>> {
  const raw = parseOptionalString(value);
  if (raw === undefined) return {};
  if (Buffer.byteLength(raw, 'utf8') > 16_384) {
    throw new Error('CONNECTOR_CREDENTIAL_KEYRING_JSON exceeds the 16 KiB configuration limit.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('CONNECTOR_CREDENTIAL_KEYRING_JSON must be valid JSON.');
  }
  if (!isPlainRecord(parsed)) {
    throw new Error('CONNECTOR_CREDENTIAL_KEYRING_JSON must be an object keyed by key ID.');
  }
  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > 16) {
    throw new Error('CONNECTOR_CREDENTIAL_KEYRING_JSON must contain 1-16 keys.');
  }
  const keyring: Record<string, string> = {};
  for (const [keyId, encodedKey] of entries) {
    parseConnectorCredentialKeyId(keyId, 'Connector credential key ID');
    if (
      typeof encodedKey !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/u.test(encodedKey) ||
      Buffer.from(encodedKey, 'base64url').length !== 32 ||
      Buffer.from(encodedKey, 'base64url').toString('base64url') !== encodedKey
    ) {
      throw new Error(
        `Connector credential key ${keyId} must be an unpadded base64url-encoded 32-byte key.`,
      );
    }
    keyring[keyId] = encodedKey;
  }
  return Object.freeze(keyring);
}

function parseIdentitySecretKeyring(value: unknown): Readonly<Record<string, string>> {
  const raw = parseOptionalString(value);
  if (raw === undefined) return {};
  if (Buffer.byteLength(raw, 'utf8') > 16_384) {
    throw new Error('IDENTITY_SECRET_KEYRING_JSON exceeds the 16 KiB configuration limit.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('IDENTITY_SECRET_KEYRING_JSON must be valid JSON.');
  }
  if (!isPlainRecord(parsed)) {
    throw new Error('IDENTITY_SECRET_KEYRING_JSON must be an object keyed by key ID.');
  }
  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > 16) {
    throw new Error('IDENTITY_SECRET_KEYRING_JSON must contain 1-16 keys.');
  }
  const keyring: Record<string, string> = {};
  for (const [keyId, encodedKey] of entries) {
    parseConnectorCredentialKeyId(keyId, 'Identity secret key ID');
    if (
      typeof encodedKey !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/u.test(encodedKey) ||
      Buffer.from(encodedKey, 'base64url').length !== 32 ||
      Buffer.from(encodedKey, 'base64url').toString('base64url') !== encodedKey
    ) {
      throw new Error(
        `Identity secret key ${keyId} must be an unpadded base64url-encoded 32-byte key.`,
      );
    }
    keyring[keyId] = encodedKey;
  }
  return Object.freeze(keyring);
}

function parseConnectorCredentialKeyId(value: unknown, name: string): string | undefined {
  const parsed = parseOptionalString(value);
  if (parsed === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(parsed)) {
    throw new Error(`${name} must contain 1-64 safe ASCII characters.`);
  }
  return parsed;
}

function parseRegistrationMode(value: unknown, environment: NodeEnvironment): 'disabled' | 'open' {
  const parsed = value ?? (environment === 'production' ? 'disabled' : 'open');
  if (parsed !== 'disabled' && parsed !== 'open') {
    throw new Error('REGISTRATION_MODE must be disabled or open.');
  }
  return parsed;
}

function parseAuthRecoveryEmailProvider(value: unknown): 'disabled' | 'resend' {
  const parsed = value ?? 'disabled';
  if (parsed !== 'disabled' && parsed !== 'resend') {
    throw new Error('AUTH_RECOVERY_EMAIL_PROVIDER must be disabled or resend.');
  }
  return parsed;
}

function parseAuthPublicAppUrl(value: unknown, environment: NodeEnvironment): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error('AUTH_PUBLIC_APP_URL must be an HTTP(S) origin.');
  }
  const local =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]';
  if (
    (parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && environment !== 'production' && local)) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error(
      'AUTH_PUBLIC_APP_URL must be an HTTPS origin (local HTTP is allowed outside production).',
    );
  }
  return parsed.origin;
}

function parseImProvider(value: unknown): 'local' | 'tencent' | 'wukong' {
  const parsed = value ?? 'local';
  if (parsed !== 'local' && parsed !== 'tencent' && parsed !== 'wukong') {
    throw new Error('IM_PROVIDER must be local, tencent, or wukong.');
  }
  return parsed;
}

function parseWukongApiBaseUrl(value: unknown, environment: NodeEnvironment): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error('WUKONG_IM_API_BASE_URL must be a valid HTTP(S) origin.');
  }
  const localHttp =
    environment !== 'production' &&
    parsed.protocol === 'http:' &&
    isLoopbackHostname(parsed.hostname);
  if (
    (parsed.protocol !== 'https:' && !localHttp) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error(
      'WUKONG_IM_API_BASE_URL must be an HTTPS origin (loopback HTTP is allowed outside production).',
    );
  }
  return parsed.origin;
}

function parseWukongPublicWsUrl(value: unknown, environment: NodeEnvironment): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error('WUKONG_IM_PUBLIC_WS_URL must be a valid WebSocket origin.');
  }
  const localWs =
    environment !== 'production' &&
    parsed.protocol === 'ws:' &&
    isLoopbackHostname(parsed.hostname);
  if (
    (parsed.protocol !== 'wss:' && !localWs) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error(
      'WUKONG_IM_PUBLIC_WS_URL must be a WSS origin (loopback WS is allowed outside production).',
    );
  }
  return parsed.origin;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]';
}

function parseToolEndpointBindings(
  value: unknown,
  environment: NodeEnvironment,
  workerEnabled: boolean,
): Readonly<Record<string, ToolEndpointBinding>> {
  const raw = parseOptionalString(value);
  if (raw === undefined) {
    if (environment === 'production' && workerEnabled) {
      throw new Error(
        'TOOL_ENDPOINT_BINDINGS_JSON is required for an enabled production Tool worker.',
      );
    }
    return {};
  }
  if (Buffer.byteLength(raw, 'utf8') > 524_288) {
    throw new Error('TOOL_ENDPOINT_BINDINGS_JSON exceeds the 512 KiB configuration limit.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('TOOL_ENDPOINT_BINDINGS_JSON must be valid JSON.');
  }
  if (!isPlainRecord(parsed)) {
    throw new Error('TOOL_ENDPOINT_BINDINGS_JSON must be an object keyed by opaque references.');
  }
  const entries = Object.entries(parsed);
  if (entries.length > 1_000) {
    throw new Error('TOOL_ENDPOINT_BINDINGS_JSON may contain at most 1000 bindings.');
  }
  const bindings: Record<string, ToolEndpointBinding> = {};
  for (const [reference, candidate] of entries) {
    if (
      reference.length < 3 ||
      reference.length > 300 ||
      !/^(?:secret|vault|kms):\/\/[A-Za-z0-9._/-]+$/u.test(reference)
    ) {
      throw new Error(
        'Tool endpoint binding keys must be opaque secret://, vault://, or kms:// references.',
      );
    }
    if (!isPlainRecord(candidate)) {
      throw new Error(`Tool endpoint binding ${reference} must be an object.`);
    }
    const unknownKeys = Object.keys(candidate).filter(
      (key) => !['url', 'method', 'headers', 'signingSecret'].includes(key),
    );
    if (unknownKeys.length > 0) {
      throw new Error(`Tool endpoint binding ${reference} contains unsupported properties.`);
    }
    const method = candidate.method;
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method))) {
      throw new Error(`Tool endpoint binding ${reference} has an unsupported HTTP method.`);
    }
    const url = parseBoundToolUrl(candidate.url, reference);
    const headers = parseBoundToolHeaders(candidate.headers, reference);
    const signingSecret =
      candidate.signingSecret === undefined
        ? null
        : parseBoundToolSigningSecret(candidate.signingSecret, reference);
    if (environment === 'production' && workerEnabled && signingSecret === null) {
      throw new Error(`Tool endpoint binding ${reference} requires a signingSecret in production.`);
    }
    bindings[reference] = {
      url,
      method: method as ToolEndpointBinding['method'],
      headers,
      signingSecret,
    };
  }
  return bindings;
}

function parseBoundToolUrl(value: unknown, reference: string): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error(`Tool endpoint binding ${reference} must contain a valid HTTPS URL.`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.port !== '' && parsed.port !== '443') ||
    parsed.hash !== ''
  ) {
    throw new Error(
      `Tool endpoint binding ${reference} must use HTTPS without userinfo, fragments, or a custom port.`,
    );
  }
  return parsed.toString();
}

function parseBoundToolHeaders(
  value: unknown,
  reference: string,
): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (!isPlainRecord(value) || Object.keys(value).length > 32) {
    throw new Error(`Tool endpoint binding ${reference} headers must be an object of at most 32.`);
  }
  const blocked = new Set([
    'connection',
    'content-length',
    'host',
    'idempotency-key',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]);
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase();
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]{1,80}$/u.test(name) ||
      blocked.has(name) ||
      name.startsWith('x-enterprise-') ||
      typeof rawValue !== 'string' ||
      rawValue.length < 1 ||
      rawValue.length > 2_048 ||
      /[\r\n\u0000]/u.test(rawValue)
    ) {
      throw new Error(`Tool endpoint binding ${reference} contains an unsafe header.`);
    }
    headers[name] = rawValue;
  }
  return headers;
}

function parseBoundToolSigningSecret(value: unknown, reference: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 32 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(
      `Tool endpoint binding ${reference} signingSecret must contain 32-512 characters.`,
    );
  }
  return value;
}

function parseToolDnsServers(value: unknown): readonly string[] {
  const raw = parseOptionalString(value) ?? '1.1.1.1,8.8.8.8';
  const servers = raw
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean);
  if (servers.length < 1 || servers.length > 8 || new Set(servers).size !== servers.length) {
    throw new Error('TOOL_DNS_SERVERS must contain 1-8 unique DNS server addresses.');
  }
  for (const server of servers) {
    const ipv4WithPort = /^([^:]+):(\d{1,5})$/u.exec(server);
    const address = ipv4WithPort?.[1] ?? server;
    const port = ipv4WithPort === null ? null : Number(ipv4WithPort[2]);
    if (
      isIP(address) === 0 ||
      (port !== null && (!Number.isInteger(port) || port < 1 || port > 65_535))
    ) {
      throw new Error('TOOL_DNS_SERVERS entries must be IP addresses with optional IPv4 ports.');
    }
  }
  return servers;
}

function parseKnowledgeWebImportAllowedHosts(value: unknown): readonly string[] {
  const hosts = (parseOptionalString(value) ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/\.$/u, ''))
    .filter(Boolean);
  if (hosts.length > 100 || new Set(hosts).size !== hosts.length) {
    throw new Error(
      'KNOWLEDGE_WEB_IMPORT_ALLOWED_HOSTS must contain at most 100 unique exact hostnames.',
    );
  }
  const hostnamePattern =
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
  if (hosts.some((host) => !hostnamePattern.test(host))) {
    throw new Error(
      'KNOWLEDGE_WEB_IMPORT_ALLOWED_HOSTS entries must be exact DNS hostnames without wildcards.',
    );
  }
  return hosts;
}

function parseRepositoryDriver(value: unknown): 'memory' | 'prisma' {
  const parsed = value ?? 'memory';
  if (parsed !== 'memory' && parsed !== 'prisma') {
    throw new Error('REPOSITORY_DRIVER must be memory or prisma.');
  }
  return parsed;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOptionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const parsed = String(value).trim();
  return parsed.length === 0 ? undefined : parsed;
}

function parseOptionalTenantSlug(value: unknown, key: string): string | undefined {
  const parsed = parseOptionalString(value)?.toLowerCase();
  if (parsed === undefined) return undefined;
  if (parsed.length < 3 || parsed.length > 80 || !TENANT_SLUG_PATTERN.test(parsed)) {
    throw new Error(
      `${key} must be 3-80 lowercase characters using letters, numbers, and single hyphens.`,
    );
  }
  return parsed;
}

function parseNodeEnvironment(value: unknown): NodeEnvironment {
  const candidate = value ?? 'development';
  if (candidate !== 'development' && candidate !== 'test' && candidate !== 'production') {
    throw new Error('NODE_ENV must be development, test, or production.');
  }
  return candidate;
}

function parsePort(value: unknown): number {
  const parsed = Number(value ?? 3000);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return parsed;
}

function parseHost(value: unknown): string {
  const parsed = String(value ?? '127.0.0.1').trim();
  if (parsed.length === 0 || parsed.length > 255) {
    throw new Error('HOST must be a non-empty hostname or IP address.');
  }
  return parsed;
}

function parseCorsOrigins(value: unknown, nodeEnvironment: NodeEnvironment): readonly string[] {
  const raw = String(value ?? 'http://localhost:5173');
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    throw new Error('CORS_ORIGINS must contain at least one origin.');
  }
  if (nodeEnvironment === 'production' && origins.includes('*')) {
    throw new Error('CORS_ORIGINS cannot contain * in production.');
  }
  return origins;
}

function parseUuid(value: unknown, key: string): string {
  const parsed = String(value);
  if (!UUID_PATTERN.test(parsed)) {
    throw new Error(`${key} must be a UUID.`);
  }
  return parsed;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error('Boolean environment values must be true or false.');
}

function parseInteger(
  value: unknown,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseOptionalPositiveInteger(value: unknown, key: string): number | undefined {
  if (value === undefined || String(value).trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive safe integer.`);
  }
  return parsed;
}

function parseTencentApiBaseUrl(value: unknown): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error('TENCENT_IM_API_BASE_URL must be a valid HTTPS URL.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !TENCENT_IM_OFFICIAL_API_HOSTS.has(parsed.hostname.toLowerCase())
  ) {
    throw new Error('TENCENT_IM_API_BASE_URL must use an allowlisted Tencent IM HTTPS host.');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
}

function parseFeishuApiBaseUrl(value: unknown): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error('FEISHU_API_BASE_URL must be the official Feishu HTTPS origin.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.toLowerCase() !== 'open.feishu.cn' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error('FEISHU_API_BASE_URL must be exactly https://open.feishu.cn.');
  }
  return FEISHU_DEFAULT_API_BASE_URL;
}

function parseAiRuntimeUrl(value: unknown): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error('AI_RUNTIME_URL must be a valid HTTP(S) origin.');
  }
  const local =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]';
  if (
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error(
      'AI_RUNTIME_URL must be an HTTPS origin, except for a local development server.',
    );
  }
  return parsed.origin;
}

function isTencentAccountId(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 32 &&
    TENCENT_IM_ACCOUNT_PATTERN.test(value)
  );
}

function parseDatabaseUsername(value: string | undefined, key: string): string {
  try {
    if (value === undefined) throw new Error('missing URL');
    const parsed = new URL(value);
    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
      throw new Error('unsupported protocol');
    }
    const username = decodeURIComponent(parsed.username);
    if (username.length === 0) throw new Error('missing username');
    return username;
  } catch {
    throw new Error(`${key} must be a valid PostgreSQL URL with a username.`);
  }
}
