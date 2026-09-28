import type { Connector } from '#core/lifecycle';

import hazelcast from './hazelcast/hazelcast.js';
import kafka from './kafka/kafka.js';
import mssql from './mssql/mssql.js';
import redis from './redis/redis.js';

/** Connectors initialised (in this order) before the server starts, and closed (in reverse order) on shutdown. */
const connectors: Connector[] = [hazelcast, kafka, mssql, redis];

export default connectors;
