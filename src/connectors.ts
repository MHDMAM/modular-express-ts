import hazelcast from '@libs/Hazelcast';
import kafka from '@libs/Kafka';
import redis from '@libs/Redis';
import { Connector } from '@lTypes/connector';

/** Connectors initialised (in this order) before the server starts, and closed (in reverse order) on shutdown. */
const connectors: Connector[] = [hazelcast, kafka, redis];

export default connectors;
