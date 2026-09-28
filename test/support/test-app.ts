import config from '#config';
import http from 'http';
import { AddressInfo } from 'net';
import App from '../../src/app';

export interface TestApp {
  /** Base URL of the API, including `baseUrl` (e.g. `http://127.0.0.1:1234/api/v1`). */
  url: string;
  close(): Promise<void>;
}

/** Starts the Express app on a random port, without connectors (they are tested separately). */
export async function startTestApp(): Promise<TestApp> {
  const server = http.createServer((await App.create()).getServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${config.baseUrl}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
