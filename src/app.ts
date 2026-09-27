import errorMiddleware from '@middleware/error';
import checkAvailability from '@middleware/express';
import notFoundMiddleware from '@middleware/notFound';
import { requestLogger } from '@middleware/requestLogger';
import envHandler from '@utils/envHandler';
import { closeConnectors, initConnectors, startConnectorMonitor } from '@utils/lifecycle';
import logger from '@utils/logger';
import compression from 'compression';
import config from 'config';
import express from 'express';
import { readFileSync } from 'fs';
import helmet from 'helmet';
import http from 'http';
import https from 'https';
import { join, resolve } from 'path';

import loadRouters from '@utils/routeLoader';

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
    this.env = process.env['NODE_ENV'];
    this.port = envHandler.getPort();
    this.ssl = envHandler.getSSL();
    process.env['NODE_CONFIG_DIR'] = join(__dirname, 'config');
    process.env.NODE_PATH = resolve(__dirname);

    this.initializeMiddleware();
  }

  public listen() {
    if (this.ssl) {
      const credentials: https.ServerOptions = {
        key: readFileSync(resolve(__dirname, config.get('ssl.key'))),
        cert: readFileSync(resolve(__dirname, config.get('ssl.cert'))),
        minVersion: config.get('ssl.minVersion'),
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
    const routers = await loadRouters([join(__dirname, config.get('routerExp'))]);
    if (routers.length > 0) this.app.use(config.get('baseUrl'), routers);
    this.app.use(config.get('baseUrl'), checkAvailability);

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

    const timeoutMs: number = config.get('shutdownTimeoutMs');
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
