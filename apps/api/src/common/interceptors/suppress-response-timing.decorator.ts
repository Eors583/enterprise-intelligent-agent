import { SetMetadata } from '@nestjs/common';

export const SUPPRESS_RESPONSE_TIMING = 'enterprise-agent:suppress-response-timing';

/** Prevents credential endpoints from exposing precise application duration. */
export const SuppressResponseTiming = (): MethodDecorator =>
  SetMetadata(SUPPRESS_RESPONSE_TIMING, true);
