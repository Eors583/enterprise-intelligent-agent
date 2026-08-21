import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Optional,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  acceptMemberInvitationRequestSchema,
  completePasswordResetRequestSchema,
  changePasswordRequestSchema,
  loginRequestSchema,
  mfaEnrollmentStartRequestSchema,
  mfaEnrollmentVerifyRequestSchema,
  mfaLoginVerifyRequestSchema,
  recentMfaChallengeRequestSchema,
  recentMfaVerifyRequestSchema,
  refreshSessionRequestSchema,
  registerTenantRequestSchema,
  requestPasswordResetRequestSchema,
  type AcceptMemberInvitationRequest,
  type AcceptMemberInvitationResponse,
  type AuthSessionResponse,
  type BrowserAuthSessionResponse,
  type BrowserLoginResult,
  type ChangePasswordRequest,
  type ChangePasswordResponse,
  type CompletePasswordResetRequest,
  type CompletePasswordResetResponse,
  type CurrentSessionResponse,
  type LoginRequest,
  type LoginResult,
  type MfaEnrollmentStartRequest,
  type MfaEnrollmentStartResponse,
  type MfaEnrollmentVerifyRequest,
  type MfaEnrollmentVerifyResponse,
  type MfaLoginVerifyRequest,
  type MfaStatusResponse,
  type RecentMfaChallengeRequest,
  type RecentMfaChallengeResponse,
  type RecentMfaVerifyRequest,
  type RecentMfaVerifyResponse,
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
import { MfaService } from './application/mfa.service.js';
import { RecoveryResponseTimingService } from './application/recovery-response-timing.service.js';
import {
  RecoveryRateLimitExceededException,
  RecoveryRequestLimiter,
} from './application/recovery-request-limiter.service.js';
import type { AuthenticatedPrincipal } from './domain/authenticated-principal.js';
import { BrowserSessionTransport } from './browser-session.transport.js';
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
    @Inject(BrowserSessionTransport)
    private readonly browserSession: BrowserSessionTransport,
    @Optional()
    @Inject(MfaService)
    private readonly mfa?: MfaService,
  ) {}

  @Public()
  @SuppressResponseTiming()
  @Post('browser/register-tenant')
  async registerBrowserTenant(
    @Body(new SchemaValidationPipe(registerTenantRequestSchema))
    request: RegisterTenantRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BrowserLoginResult> {
    const result = await this.auth.registerTenant(request);
    return 'accessToken' in result ? this.browserSession.issue(response, result) : result;
  }

  @Public()
  @SuppressResponseTiming()
  @Post('browser/login')
  @HttpCode(HttpStatus.OK)
  async browserLogin(
    @Body(new SchemaValidationPipe(loginRequestSchema)) request: LoginRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BrowserLoginResult> {
    const result = await this.login(request, httpRequest);
    return 'accessToken' in result ? this.browserSession.issue(response, result) : result;
  }

  @Public()
  @SuppressResponseTiming()
  @Post('browser/mfa/login/verify')
  @HttpCode(HttpStatus.OK)
  async completeBrowserMfaLogin(
    @Body(new SchemaValidationPipe(mfaLoginVerifyRequestSchema))
    request: MfaLoginVerifyRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BrowserAuthSessionResponse> {
    return this.browserSession.issue(response, await this.auth.completeMfaLogin(request));
  }

  @Public()
  @SuppressResponseTiming()
  @Post('browser/refresh')
  @HttpCode(HttpStatus.OK)
  async refreshBrowserSession(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BrowserAuthSessionResponse> {
    this.browserSession.requireCsrf(request);
    return this.browserSession.issue(
      response,
      await this.auth.refresh({
        refreshToken: this.browserSession.requireRefreshToken(request),
      }),
    );
  }

  @Post('browser/logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutBrowserSession(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    try {
      await this.auth.logout(requirePrincipal(request));
    } finally {
      this.browserSession.clear(response);
    }
  }

  @Public()
  @SuppressResponseTiming()
  @Post('register-tenant')
  registerTenant(
    @Body(new SchemaValidationPipe(registerTenantRequestSchema)) request: RegisterTenantRequest,
  ): Promise<LoginResult> {
    return this.auth.registerTenant(request);
  }

  @Public()
  @SuppressResponseTiming()
  @Post('mfa/login/verify')
  @HttpCode(HttpStatus.OK)
  completeMfaLogin(
    @Body(new SchemaValidationPipe(mfaLoginVerifyRequestSchema))
    request: MfaLoginVerifyRequest,
  ): Promise<AuthSessionResponse> {
    return this.auth.completeMfaLogin(request);
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
  ): Promise<LoginResult> {
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

  @Get('mfa')
  mfaStatus(@Req() request: Request): Promise<MfaStatusResponse> {
    return requireMfa(this.mfa).status(requirePrincipal(request));
  }

  @Post('mfa/enrollment/start')
  @HttpCode(HttpStatus.OK)
  startMfaEnrollment(
    @Body(new SchemaValidationPipe(mfaEnrollmentStartRequestSchema))
    request: MfaEnrollmentStartRequest,
    @Req() httpRequest: Request,
  ): Promise<MfaEnrollmentStartResponse> {
    return requireMfa(this.mfa).startEnrollment(request, requirePrincipal(httpRequest));
  }

  @Post('mfa/enrollment/verify')
  @HttpCode(HttpStatus.OK)
  verifyMfaEnrollment(
    @Body(new SchemaValidationPipe(mfaEnrollmentVerifyRequestSchema))
    request: MfaEnrollmentVerifyRequest,
    @Req() httpRequest: Request,
  ): Promise<MfaEnrollmentVerifyResponse> {
    return requireMfa(this.mfa).verifyEnrollment(request, requirePrincipal(httpRequest));
  }

  @Post('mfa/recent/challenge')
  @HttpCode(HttpStatus.OK)
  beginRecentMfa(
    @Body(new SchemaValidationPipe(recentMfaChallengeRequestSchema))
    request: RecentMfaChallengeRequest,
    @Req() httpRequest: Request,
  ): Promise<RecentMfaChallengeResponse> {
    return requireMfa(this.mfa).beginRecentMfa(request.purpose, requirePrincipal(httpRequest));
  }

  @Post('mfa/recent/verify')
  @SuppressResponseTiming()
  @HttpCode(HttpStatus.OK)
  verifyRecentMfa(
    @Body(new SchemaValidationPipe(recentMfaVerifyRequestSchema))
    request: RecentMfaVerifyRequest,
    @Req() httpRequest: Request,
  ): Promise<RecentMfaVerifyResponse> {
    return requireMfa(this.mfa).verifyRecentMfa(request, requirePrincipal(httpRequest));
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

function requireMfa(service: MfaService | undefined): MfaService {
  if (service === undefined) {
    throw new UnauthorizedException('Multi-factor authentication is unavailable.');
  }
  return service;
}
