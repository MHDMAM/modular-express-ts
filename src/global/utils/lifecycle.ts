import registry from '@/connectors';
import { Connector } from '@lTypes/connector';
import logger from '@utils/logger';
import config from 'config';

/**
 * - `disabled`: turned off in config, never initialised
 * - `starting` → `running` (initialised and ready) or `failed` (init threw or timed out)
 * - `unavailable`: was running but is not ready now (e.g. reconnecting); back to `running` when it recovers
 * - `stopping` → `stopped` on shutdown
 */
export type ConnectorStatus = 'disabled' | 'starting' | 'running' | 'unavailable' | 'failed' | 'stopping' | 'stopped';

const statuses = new WeakMap<Connector, ConnectorStatus>();
let monitor: NodeJS.Timeout | undefined;

function setStatus(connector: Connector, status: ConnectorStatus, details: Record<string, unknown> = {}) {
  const previous = statuses.get(connector);
  if (previous === status) return;
  statuses.set(connector, status);
  const level = status === 'failed' ? 'error' : status === 'unavailable' ? 'warn' : 'info';
  logger[level]({ info: `Connector ${status}`, connector: connector.name, previous, ...details });
}

/** Current status; a running connector that is not ready is reported as `unavailable`. */
export function getConnectorStatus(connector: Connector): ConnectorStatus {
  if (!connector.enabled) return 'disabled';
  const status = statuses.get(connector) ?? 'stopped';
  if (status === 'running' && !connector.isReady()) return 'unavailable';
  if (status === 'unavailable' && connector.isReady()) return 'running';
  return status;
}

/** Status of every enabled connector, e.g. `{ kafka: 'running', redis: 'unavailable' }`. */
export function connectorStatus(connectors: Connector[] = registry): Record<string, ConnectorStatus> {
  return Object.fromEntries(connectors.filter((c) => c.enabled).map((c) => [c.name, getConnectorStatus(c)]));
}

/** Rejects if `promise` does not settle within `timeoutMs`. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), timeoutMs)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Initialises every enabled connector in order. Clients often retry an unreachable server forever, so each
 * connector gets `timeoutMs` to become ready. On failure or timeout, closes the failed connector (stopping its
 * retries) and the ones already started, then rethrows. Logs each connector's status and a summary.
 */
export async function initConnectors(
  connectors: Connector[] = registry,
  timeoutMs: number = config.get('connectorInitTimeoutMs'),
): Promise<void> {
  const started: Connector[] = [];
  for (const connector of connectors) {
    if (!connector.enabled) {
      setStatus(connector, 'disabled');
      continue;
    }
    setStatus(connector, 'starting');
    const start = Date.now();
    try {
      await withTimeout(connector.init(), timeoutMs, `${connector.name} was not ready within ${timeoutMs}ms`);
      started.push(connector);
      setStatus(connector, 'running', { durationMs: Date.now() - start });
    } catch (error) {
      setStatus(connector, 'failed', { durationMs: Date.now() - start, error });
      await closeConnectors([...started, connector]);
      throw error;
    }
  }
  logger.info({
    info: 'Connectors started',
    connectors: Object.fromEntries(connectors.map((c) => [c.name, getConnectorStatus(c)])),
  });
}

/** Closes every enabled connector in reverse order; failures are logged, never thrown. */
export async function closeConnectors(connectors: Connector[] = registry): Promise<void> {
  stopConnectorMonitor();
  for (const connector of [...connectors].filter((c) => c.enabled).reverse()) {
    const failed = statuses.get(connector) === 'failed';
    if (!failed) setStatus(connector, 'stopping');
    try {
      await connector.close();
      if (!failed) setStatus(connector, 'stopped');
    } catch (error) {
      logger.error({ info: 'Connector failed to close', connector: connector.name, error });
    }
  }
}

/** Logs connectors going `unavailable` and back to `running` (called periodically by the monitor). */
export function checkConnectors(connectors: Connector[] = registry): void {
  for (const connector of connectors) {
    const status = statuses.get(connector);
    if (status === 'running' || status === 'unavailable') setStatus(connector, getConnectorStatus(connector));
  }
}

/** Starts checking connector readiness every `intervalMs`, logging changes. Does not keep the process alive. */
export function startConnectorMonitor(
  connectors: Connector[] = registry,
  intervalMs: number = config.get('connectorMonitorIntervalMs'),
): void {
  stopConnectorMonitor();
  monitor = setInterval(() => checkConnectors(connectors), intervalMs).unref();
}

export function stopConnectorMonitor(): void {
  if (monitor) clearInterval(monitor);
  monitor = undefined;
}
