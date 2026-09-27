import logger from '@utils/logger';
import { join, resolve } from 'path';
import App from './app';
process.env['NODE_CONFIG_DIR'] = join(__dirname, 'config');
process.env.NODE_PATH = resolve(__dirname);

const app = new App();
app.start();

process.on('unhandledRejection', function (reason: Error, promise: Promise<any>) {
  /* I just caught an unhandled promise rejection, 
       since we already have fallback handler for unhandled errors (see below),
       let throw and let him handle that
    */

  logger.error({
    info: 'Unhandled Rejection',
    error: reason,
    error_message: reason && reason.message,
    error_stack: reason && reason.stack,
    promise,
  });
  throw reason;
});

process.on('uncaughtException', (reason: Error, origin: string) => {
  logger.error({
    info: 'Uncaught Exception',
    error: reason,
    error_message: reason && reason.message,
    error_stack: reason && reason.stack,
    origin,
  });

  app.gracefullyShutdown(origin);
});

process.on('deprecation', (dep) => {
  logger.info({
    route: 'Deprecation',
    stack: dep && dep.stack,
    error_message: dep && dep.message,
    dep,
  });
});

process.on('warning', (warning) => {
  logger.debug({
    route: 'warning',
    stack: warning && warning.stack,
    error_message: warning && warning.message,
    warning,
  });
});

// politely ask a program to terminate.
process.on('SIGINT', () => {
  app.gracefullyShutdown('SIGINT');
});

// cause program termination.
process.on('SIGTERM', () => {
  app.gracefullyShutdown('SIGTERM');
});
