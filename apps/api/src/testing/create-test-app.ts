import { ValidationPipe, type INestApplication, RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../app.module.js';
import { AgentOperationalReadinessService } from '../modules/ai-safety-model-routing/agent-operational-readiness.service.js';
import { LoginAttemptLimiter } from '../modules/auth/application/login-attempt-limiter.service.js';

export interface TestApplicationOverrides {
  /**
   * Explicit test fixture for suites whose subject is downstream orchestration,
   * not provider connectivity. Production AppModule wiring is unchanged when
   * this override is omitted.
   */
  readonly agentOperationalReadiness?: Pick<AgentOperationalReadinessService, 'inspectAgents'>;
  /** Isolates non-authentication integration suites from shared throttle fixtures. */
  readonly loginAttemptLimiter?: Pick<
    LoginAttemptLimiter,
    'createContext' | 'beginAttempt' | 'clearSuccessfulAttempt'
  >;
}

export async function createTestApp(
  overrides: TestApplicationOverrides = {},
): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (overrides.agentOperationalReadiness !== undefined) {
    builder
      .overrideProvider(AgentOperationalReadinessService)
      .useValue(overrides.agentOperationalReadiness);
  }
  if (overrides.loginAttemptLimiter !== undefined) {
    builder.overrideProvider(LoginAttemptLimiter).useValue(overrides.loginAttemptLimiter);
  }
  const module = await builder.compile();
  const app = module.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  await app.init();
  return app;
}
