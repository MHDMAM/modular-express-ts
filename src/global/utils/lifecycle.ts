import registry from '@/connectors';
import { Connector } from '@lTypes/connector';
import logger from '@utils/logger';

/** Initialises every enabled connector in order. On failure, closes the ones already started and rethrows. */
export async function initConnectors(connectors: Connector[] = registry): Promise<void> {
  const started: Connector[] = [];
  for (const connector of connectors.filter((c) => c.enabled)) {
    try {
      await connector.init();
      started.push(connector);
      logger.info({ info: 'Connector ready', connector: connector.name });
    } catch (error) {
      logger.error({ info: 'Connector failed to initialise', connector: connector.name, error });
      await closeConnectors(started);
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
