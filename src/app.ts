import config from '@/config';
import { closeConnectors, initConnectors, startConnectorMonitor } from '@core/lifecycle';
import logger from '@core/logger';
import errorMiddleware from '@core/middleware/error';
import notFoundMiddleware from '@core/middleware/not-found';
import { requestLogger } from '@core/middleware/request-logger';
import compression from 'compression';
import express from 'express';
import { readFileSync } from 'fs';
import helmet from 'helmet';
import http from 'http';
import https from 'https';
import { join, resolve } from 'path';

import loadRouters from '@core/routes';

class App {
  private app: express.Application;
  private env: string;
  private ssl: boolean;
  private port: string | number;
  private server: http.Server;
  private shuttingDown = false;

  /** Creates the app: middleware, auto-loaded module routes and error handling. */
  static async create(): Promise<App> {
    const app = new App();
    await app.initializeRoutes();
    app.initializeErrorHandling();
    return app;
  }

  private constructor() {
    this.app = express();
    this.env = config.env;
    this.port = config.port;
    this.ssl = config.ssl.enabled;

    this.initializeMiddleware();
  }

  public listen() {
    if (this.ssl) {
      const credentials: https.ServerOptions = {
        key: readFileSync(resolve(config.ssl.keyPath)),
        cert: readFileSync(resolve(config.ssl.certPath)),
        minVersion: config.ssl.minVersion,
      };

      this.server = https.createServer(credentials, this.app).listen(this.port, () => {
        logger.info('==========================================================================');
        logger.info(`🚀 App listening on the port SSL ${this.port} -  ENV: ${this.env}`);
        logger.info('==========================================================================');
      });
    } else {
      this.server = http.createServer(this.app).listen(this.port, () => {
        logger.info('==========================================================================');
        logger.info(`🚀 App listening on the port ${this.port} -  ENV: ${this.env}`);
        logger.info('==========================================================================');
      });
    }
    this.server.on('error', (e) => {
      this.onError(e);
    });
  }

  public getServer() {
    return this.app;
  }

  private initializeMiddleware() {
    this.app.disable('x-powered-by'); // Disable the X-Powered-By header
    this.app.use(
      helmet({
        hidePoweredBy: true, // Removes X-Powered-By
        frameguard: { action: 'deny' }, // Prevents clickjacking by denying iframe usage
        xssFilter: true, // Adds X-XSS-Protection header
        noSniff: true, // Adds X-Content-Type-Options header
        hsts: { maxAge: 31536000, includeSubDomains: true }, // Enforces HTTPS with HSTS
      }),
    );
    this.app.use(compression()); // Compress responses
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
  }

  private async initializeRoutes() {
    this.app.use(requestLogger);
    const routers = await loadRouters([join(__dirname, config.routesGlob)]);
    if (routers.length > 0) this.app.use(config.baseUrl, routers);

    this.app.use(notFoundMiddleware);
  }

  private initializeErrorHandling() {
    this.app.use(errorMiddleware);
  }

  /** Initialises the connectors, then starts listening. Exits if a connector cannot be initialised. */
  public async start() {
    try {
      await initConnectors();
      startConnectorMonitor();
    } catch (error) {
      logger.error({ info: 'Startup aborted: a connector failed to initialise', error });
      process.exit(1);
    }
    this.listen();
  }

  /** Stops accepting requests, closes the connectors and exits; forces the exit after `shutdownTimeoutMs`. */
  public gracefullyShutdown(reason: string) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    logger.info({ info: `Closing Server Due to (${reason})!!` });

    const timeoutMs = config.shutdownTimeoutMs;
    const forceExit = setTimeout(() => {
      logger.error({ info: `Shutdown took longer than ${timeoutMs}ms, forcing exit` });
      process.exit(1);
    }, timeoutMs);

    const closeServer = new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    closeServer
      .then(() => closeConnectors())
      .then(() => {
        logger.info({ info: 'Server Closed Gracefully!!! ' });
        clearTimeout(forceExit);
        process.exit();
      });
  }

  /**
   * Event listener for HTTP server "error" event.
   * Not sure: **testing**
   */

  private onError(error: NodeJS.ErrnoException) {
    if (error.syscall !== 'listen') {
      throw error;
    }

    var bind = typeof this.port === 'string' ? 'Pipe ' + this.port : 'Port ' + this.port;

    // handle specific listen errors with friendly messages
    switch (error.code) {
      case 'EACCES':
        logger.error({
          msg: 'Error - requires elevated privileges.',
          route: 'onError',
          error_message: bind + ' requires elevated privileges',
        });
        this.gracefullyShutdown('EACCES');

        break;
      case 'EADDRINUSE':
        logger.error({
          msg: 'Error - already in use.',
          route: 'onError',
          error_message: bind + ' is already in use',
        });
        this.gracefullyShutdown('EADDRINUSE');

        break;
      default:
        throw error;
    }
  }
}

export default App;
