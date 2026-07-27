import type { AuthenticatedPrincipal } from '../../modules/auth/domain/authenticated-principal.js';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      authPrincipal?: AuthenticatedPrincipal;
    }
  }
}

export {};
