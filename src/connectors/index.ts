import type { Connector } from '#core/lifecycle';
import hazelcast from './hazelcast/hazelcast';
import kafka from './kafka/kafka';
import mssql from './mssql/mssql';
import redis from './redis/redis';

/** Connectors initialised (in this order) before the server starts, and closed (in reverse order) on shutdown. */
const connectors: Connector[] = [hazelcast, kafka, mssql, redis];

export default connectors;
