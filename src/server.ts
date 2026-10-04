// Must stay the first import: copies config.json into the environment before anything reads it
import './core/config-file-load.js';

import logger from '#core/logger';

import App from './app.js';

let app: App | undefined;
App.create()
  .then((created) => {
    app = created;
    return app.start();
  })
  .catch((error) => {
    logger.error({ info: 'Failed to start', error });
    process.exit(1);
  });

/** Shuts down gracefully once the app exists; exits directly if startup has not finished. */
const shutdown = (reason: string) => (app ? app.gracefullyShutdown(reason) : process.exit(1));

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

  shutdown(origin);
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
  shutdown('SIGINT');
});

// cause program termination.
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

// pm2 asks for a shutdown with a message instead of a signal (shutdown_with_message, needed on Windows)
process.on('message', (message) => {
  if (message === 'shutdown') shutdown('shutdown message');
});
