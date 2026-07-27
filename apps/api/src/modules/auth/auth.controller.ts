import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  acceptMemberInvitationRequestSchema,
  completePasswordResetRequestSchema,
  changePasswordRequestSchema,
  loginRequestSchema,
  refreshSessionRequestSchema,
  registerTenantRequestSchema,
  requestPasswordResetRequestSchema,
  type AcceptMemberInvitationRequest,
  type AcceptMemberInvitationResponse,
  type AuthSessionResponse,
  type ChangePasswordRequest,
  type ChangePasswordResponse,
  type CompletePasswordResetRequest,
  type CompletePasswordResetResponse,
  type CurrentSessionResponse,
  type LoginRequest,
  type RefreshSessionRequest,
  type RegisterTenantRequest,
  type RequestPasswordResetRequest,
  type RequestPasswordResetResponse,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { SuppressResponseTiming } from '../../common/interceptors/suppress-response-timing.decorator.js';
import { AuthService } from './application/auth.service.js';
import {
  AuthRecoveryService,
  PASSWORD_RESET_REQUEST_ACCEPTED_RESPONSE,
} from './application/auth-recovery.service.js';
import { LoginAttemptLimiter } from './application/login-attempt-limiter.service.js';
import { RecoveryResponseTimingService } from './application/recovery-response-timing.service.js';
import {
  RecoveryRateLimitExceededException,
  RecoveryRequestLimiter,
} from './application/recovery-request-limiter.service.js';
import type { AuthenticatedPrincipal } from './domain/authenticated-principal.js';
import { Public } from './public.decorator.js';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AuthRecoveryService) private readonly recovery: AuthRecoveryService,
    @Inject(LoginAttemptLimiter) private readonly loginAttempts: LoginAttemptLimiter,
    @Inject(RecoveryRequestLimiter) private readonly recoveryRequests: RecoveryRequestLimiter,
    @Inject(RecoveryResponseTimingService)
    private readonly recoveryResponseTiming: RecoveryResponseTimingService,
  ) {}

  @Public()
  @SuppressResponseTiming()
  @Post('register-tenant')
  registerTenant(
    @Body(new SchemaValidationPipe(registerTenantRequestSchema)) request: RegisterTenantRequest,
  ): Promise<AuthSessionResponse> {
    return this.auth.registerTenant(request);
  }

  @Public()
  @SuppressResponseTiming()
  @Post('password-reset/request')
  @HttpCode(HttpStatus.ACCEPTED)
  async requestPasswordReset(
    @Body(new SchemaValidationPipe(requestPasswordResetRequestSchema))
    request: RequestPasswordResetRequest,
    @Req() httpRequest: Request,
  ): Promise<RequestPasswordResetResponse> {
    const responseBudget = this.recoveryResponseTiming.start();
    try {
      try {
        await this.recoveryRequests.beginRequest(
          this.recoveryRequests.createContext({
            namespace: 'password-request',
            tenantSlug: request.tenantSlug,
            accountValue: request.email,
            ...(clientAddress(httpRequest) === undefined
              ? {}
              : { clientAddress: clientAddress(httpRequest) }),
          }),
        );
      } catch (error) {
        if (error instanceof RecoveryRateLimitExceededException) {
          return PASSWORD_RESET_REQUEST_ACCEPTED_RESPONSE;
        }
        throw error;
      }
      return await this.recovery.requestPasswordReset(request);
    } finally {
      await responseBudget.wait();
    }
  }

  @Public()
  @SuppressResponseTiming()
  @Post('password-reset/complete')
  @HttpCode(HttpStatus.OK)
  async completePasswordReset(
    @Body(new SchemaValidationPipe(completePasswordResetRequestSchema))
    request: CompletePasswordResetRequest,
    @Req() httpRequest: Request,
  ): Promise<CompletePasswordResetResponse> {
    await this.recoveryRequests.beginRequest(
      this.recoveryRequests.createContext({
        namespace: 'reset-token',
        tenantSlug: 'opaque-token',
        accountValue: request.token,
        ...(clientAddress(httpRequest) === undefined
          ? {}
          : { clientAddress: clientAddress(httpRequest) }),
      }),
    );
    return this.recovery.completePasswordReset(request);
  }

  @Public()
  @SuppressResponseTiming()
  @Post('invitations/accept')
  @HttpCode(HttpStatus.OK)
  async acceptMemberInvitation(
    @Body(new SchemaValidationPipe(acceptMemberInvitationRequestSchema))
    request: AcceptMemberInvitationRequest,
    @Req() httpRequest: Request,
  ): Promise<AcceptMemberInvitationResponse> {
    await this.recoveryRequests.beginRequest(
      this.recoveryRequests.createContext({
        namespace: 'invite-token',
        tenantSlug: 'opaque-token',
        accountValue: request.token,
        ...(clientAddress(httpRequest) === undefined
          ? {}
          : { clientAddress: clientAddress(httpRequest) }),
      }),
    );
    return this.recovery.acceptMemberInvitation(request);
  }

  @Public()
  @SuppressResponseTiming()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new SchemaValidationPipe(loginRequestSchema)) request: LoginRequest,
    @Req() httpRequest: Request,
  ): Promise<AuthSessionResponse> {
    const clientAddress = httpRequest.ip ?? httpRequest.socket.remoteAddress;
    const context = this.loginAttempts.createContext({
      tenantSlug: request.tenantSlug,
      email: request.email,
      ...(clientAddress === undefined ? {} : { clientAddress }),
    });
    await this.loginAttempts.beginAttempt(context);
    try {
      const result = await this.auth.login(request);
      try {
        await this.loginAttempts.clearSuccessfulAttempt(context);
      } catch {
        // A cleanup outage must not discard a newly-created valid session. The
        // next window still expires at the database clock boundary.
        this.logger.warn('Could not clear a successful login throttle bucket.');
      }
      return result;
    } catch (error) {
      throw error;
    }
  }

  @Public()
  @SuppressResponseTiming()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(
    @Body(new SchemaValidationPipe(refreshSessionRequestSchema)) request: RefreshSessionRequest,
  ): Promise<AuthSessionResponse> {
    return this.auth.refresh(request);
  }

  @Get('me')
  me(@Req() request: Request): CurrentSessionResponse {
    return this.auth.current(requirePrincipal(request));
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  changePassword(
    @Body(new SchemaValidationPipe(changePasswordRequestSchema)) request: ChangePasswordRequest,
    @Req() httpRequest: Request,
  ): Promise<ChangePasswordResponse> {
    return this.auth.changePassword(request, requirePrincipal(httpRequest));
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Req() request: Request): Promise<void> {
    return this.auth.logout(requirePrincipal(request));
  }
}

function clientAddress(request: Request): string | undefined {
  return request.ip ?? request.socket.remoteAddress;
}

function requirePrincipal(request: Request): AuthenticatedPrincipal {
  if (request.authPrincipal === undefined) {
    throw new UnauthorizedException('Authentication required.');
  }
  return request.authPrincipal;
}
