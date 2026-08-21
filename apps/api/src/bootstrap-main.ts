import 'reflect-metadata';

import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module.js';
import type { EnvironmentVariables } from './config/environment.js';
import { stopApiOpenTelemetry } from './observability/opentelemetry.js';

export async function bootstrap(): Promise<void> {
  try {
    const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
    const config = app.get(ConfigService<EnvironmentVariables, true>);
    const origins = config.get('CORS_ORIGINS', { infer: true });

    // A governed retrieval benchmark can contain up to 500 source-grounded
    // cases. Express' 100 KiB default rejects a normal 200-case JSON import
    // before the Zod contract can enforce the real row and field limits.
    app.useBodyParser('json', { limit: '2mb' });

    app.enableCors({
      origin: [...origins],
      credentials: true,
      allowedHeaders: [
        'authorization',
        'content-type',
        'traceparent',
        'tracestate',
        'baggage',
        'x-correlation-id',
        'x-csrf-token',
        'x-request-id',
        'x-tenant-id',
        'x-user-id',
      ],
      exposedHeaders: ['server-timing', 'traceparent', 'x-correlation-id', 'x-request-id'],
    });
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
    app.enableShutdownHooks();

    await app.listen(config.get('PORT', { infer: true }), config.get('HOST', { infer: true }));
  } catch (error) {
    await stopApiOpenTelemetry();
    throw error;
  }
}
