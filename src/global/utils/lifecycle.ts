import registry from '@/connectors';
import { Connector } from '@lTypes/connector';
import logger from '@utils/logger';
import config from 'config';

/** Rejects if `promise` does not settle within `timeoutMs`. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), timeoutMs)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Initialises every enabled connector in order. Clients often retry an unreachable server forever, so each
 * connector gets `timeoutMs` to become ready. On failure or timeout, closes the failed connector (stopping its
 * retries) and the ones already started, then rethrows.
 */
export async function initConnectors(
  connectors: Connector[] = registry,
  timeoutMs: number = config.get('connectorInitTimeoutMs'),
): Promise<void> {
  const started: Connector[] = [];
  for (const connector of connectors.filter((c) => c.enabled)) {
    try {
      await withTimeout(connector.init(), timeoutMs, `${connector.name} was not ready within ${timeoutMs}ms`);
      started.push(connector);
      logger.info({ info: 'Connector ready', connector: connector.name });
    } catch (error) {
      logger.error({ info: 'Connector failed to initialise', connector: connector.name, error });
      await closeConnectors([...started, connector]);
      throw error;
    }
  }
}

/** Closes every enabled connector in reverse order; failures are logged, never thrown. */
export async function closeConnectors(connectors: Connector[] = registry): Promise<void> {
  for (const connector of [...connectors].filter((c) => c.enabled).reverse()) {
    try {
      await connector.close();
      logger.info({ info: 'Connector closed', connector: connector.name });
    } catch (error) {
      logger.error({ info: 'Connector failed to close', connector: connector.name, error });
    }
  }
}

/** Readiness of every enabled connector, e.g. `{ kafka: true, redis: false }`. */
export function connectorStatus(connectors: Connector[] = registry): Record<string, boolean> {
  return Object.fromEntries(connectors.filter((c) => c.enabled).map((c) => [c.name, c.isReady()]));
}
