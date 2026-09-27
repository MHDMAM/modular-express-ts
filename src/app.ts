import errorMiddleware from '@middleware/error';
import checkAvailability from '@middleware/express';
import notFoundMiddleware from '@middleware/notFound';
import { requestLogger } from '@middleware/requestLogger';
import envHandler from '@utils/envHandler';
import logger from '@utils/logger';
import compression from 'compression';
import config from 'config';
import express from 'express';
import { readFileSync } from 'fs';
import helmet from 'helmet';
import http from 'http';
import https from 'https';
import { join, resolve } from 'path';
if (config.get('kafka.enabled')) import('@utils/kafka'); // Ensure this file runs to start Kafka initialization

import routeLoader from '@utils/routeLoader';

class App {
  private app: express.Application;
  private env: string;
  private ssl: boolean;
  private port: string | number;
  private server: http.Server;

  constructor() {
    this.app = express();
    this.env = process.env['NODE_ENV'];
    this.port = envHandler.getPort();
    this.ssl = envHandler.getSSL();
    process.env['NODE_CONFIG_DIR'] = join(__dirname, 'config');
    process.env.NODE_PATH = resolve(__dirname);

    this.initializeMiddleware();
    this.initializeRoutes();
    this.initializeErrorHandling();
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

  private initializeRoutes() {
    this.app.use(requestLogger);
    const routeRoot = join(__dirname, config.get('routerExp'));
    const routes = routeLoader.importClassesFromDirectories([routeRoot]);
    if (routes?.length > 0) this.app.use(config.get('baseUrl'), routes);
    this.app.use(config.get('baseUrl'), checkAvailability);

    this.app.use('*', notFoundMiddleware);
  }

  private initializeErrorHandling() {
    this.app.use(errorMiddleware);
  }

  public gracefullyShutdown(reason: string) {
    logger.info({
      info: `Closing Server Due to (${reason})!!`,
    });
    if (!this.server) process.exit();
    this.server.close(() => {
      logger.info({
        info: 'Server Closed Gracefully!!! ',
      });
      clearTimeout(forceExit);
      process.exit();
    });
    // Force close server after 5secs
    let forceExit = setTimeout((e) => {
      logger.info({
        info: 'Been 5 Seconds, Forcing server to close !!!',
        error_message: e,
      });
      process.exit();
    }, 5000);
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
