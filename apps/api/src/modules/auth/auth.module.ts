import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './application/auth.service.js';
import { AuthRecoveryNotificationService } from './application/auth-recovery-notification.service.js';
import { AuthRecoveryService } from './application/auth-recovery.service.js';
import { LoginAttemptLimiter } from './application/login-attempt-limiter.service.js';
import { PasswordHasher } from './application/password-hasher.js';
import { RecoveryResponseTimingService } from './application/recovery-response-timing.service.js';
import { RecoveryRequestLimiter } from './application/recovery-request-limiter.service.js';
import { TokenService } from './application/token.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRecoveryService,
    AuthRecoveryNotificationService,
    LoginAttemptLimiter,
    RecoveryRequestLimiter,
    RecoveryResponseTimingService,
    PasswordHasher,
    TokenService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, AuthRecoveryNotificationService, PasswordHasher, TokenService],
})
export class AuthModule {}
