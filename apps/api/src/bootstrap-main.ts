import 'reflect-metadata';

import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import type { EnvironmentVariables } from './config/environment.js';
import { stopApiOpenTelemetry } from './observability/opentelemetry.js';

export async function bootstrap(): Promise<void> {
  try {
    const app = await NestFactory.create(AppModule, { bufferLogs: true });
    const config = app.get(ConfigService<EnvironmentVariables, true>);
    const origins = config.get('CORS_ORIGINS', { infer: true });

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
