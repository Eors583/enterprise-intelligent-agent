import { validateApiEnvironment } from './config/environment.js';
import {
  installOpenTelemetryShutdownHooks,
  startApiOpenTelemetry,
} from './observability/opentelemetry.js';

const environment = validateApiEnvironment(process.env);
await startApiOpenTelemetry(process.env, environment.NODE_ENV);
installOpenTelemetryShutdownHooks();

const { bootstrap } = await import('./bootstrap-main.js');
await bootstrap();
