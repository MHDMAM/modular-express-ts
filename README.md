# modular-express-ts

Express + TypeScript API boilerplate with auto-loaded modules, structured logging, a consistent response envelope and
optional MSSQL, Kafka, Hazelcast and Redis connectors.

## Quick Start

```sh
npm i
cp .env.example .env   # optional: every variable has a default
npm run dev            # tsx watch mode, NODE_ENV=development
curl localhost:3000/api/v1/health
```

## Scripts

| Script                 | Description                                                       |
| ---------------------- | ----------------------------------------------------------------- |
| `npm run dev`          | Start in watch mode (tsx), loading `.env` if present              |
| `npm run debug`        | Same as `dev` with the Node inspector enabled                     |
| `npm run build`        | Clean `dist/`, compile with `tsc` and rewrite path aliases        |
| `npm start`            | Run the compiled app from `dist/`, loading `.env` if present      |
| `npm run typecheck`    | Type-check without emitting                                       |
| `npm run format`       | Format with Prettier (imports organised automatically)            |
| `npm run format:check` | Check formatting (as CI does)                                     |
| `npm test`             | Run the Vitest tests from `test/` (`npm run test:watch` to watch) |

## Project Structure

```
src/
  server.ts            # entry point: process signals, unhandled errors, graceful shutdown
  app.ts               # express app: middleware, route loading, error handling, http/https
  config.ts            # core configuration from environment variables (zod)
  connectors/          # index.ts: registry of connectors started before listening and closed on shutdown
    kafka/ redis/ hazelcast/ mssql/  # one folder per connector: code, env schema, tests
  core/                # logger, request context, errors, connector lifecycle, route loading, middleware
  http/                # optional outbound HTTP: HttpClient, ServiceRequester
  modules/
    health/            # example module
      routerV1.ts
      controller.ts
test/                  # Vitest tests
```

## Modules & Routing

Every file matching `ROUTES_GLOB` (default `modules/**/routerV1.{js,ts}`) is loaded automatically and its default export
(an Express `Router`) is mounted under `API_BASE_PATH` (default `/api/v1`). To add a module, create
`src/modules/<name>/routerV1.ts`.

## Request Context & Logging

Every request runs inside a request context (Node's `AsyncLocalStorage`) holding a `requestId` (from `x-request-id`, or
generated) and a W3C `traceId` (from `traceparent`, or generated). Anything running during the request, however deep in
the call chain, can read it with `getRequestContext()` from `@core/request-context`, without passing ids around.

- Every log line written during the request gets `requestId` and `traceId` automatically. Logs are one JSON object per
  line: `{ time, level, requestId, traceId, ...fields }`; errors are serialized with their message and stack.
- `ServiceRequester` and `kafka.send()` forward `x-request-id` and `traceparent`, and Kafka handlers run in a context
  rebuilt from the message headers, so one id follows a request across services.
- Request/response headers and bodies are not logged, as they may carry credentials or personal data.
- Keep the context to request metadata (ids, tenant, user reference); pass business data as normal arguments.

## Responses & Errors

- The request id is echoed back in the `x-request-id` response header (and available as `req.ref`).
- Object responses sent with `res.send()` get a `_metadata` block (request/response time, processing time) and a default
  `status` of `<STATUS_PREFIX>1000` (e.g. `APP1000`).
- Throw or `next()` an `HttpException` (e.g. `HttpException.notFound()`) to return `{ status, message, ...data }` with
  the matching HTTP code. Unknown errors become a 500, invalid JSON bodies a 400.
- Status codes follow `<STATUS_PREFIX><version><3-digit code>`; see `formatStatus` in `src/core/errors.ts`.

## Health & Lifecycle

- `GET /health`: liveness, the process is up.
- `GET /health/ready`: readiness, `503` unless every enabled connector is `running`; the payload lists each connector's
  status. Use it for load balancer or Kubernetes readiness probes.

On startup every enabled connector in `src/connectors/index.ts` is initialised in order before the server listens; if
one fails or is not ready within `CONNECTOR_INIT_TIMEOUT_MS` (default 30s), the connectors are closed and the process
exits. On `SIGINT`/`SIGTERM` the server stops accepting requests, the connectors are closed in reverse order (each
within `CONNECTOR_CLOSE_TIMEOUT_MS`, default 5s), and the process exits (forced after `SHUTDOWN_TIMEOUT_MS`, default
10s).

Each connector has a status, logged on every change: `disabled`, `starting` → `running` or `failed`, `unavailable`
(running but not ready, e.g. reconnecting) and back to `running`, then `stopping` → `stopped`. A summary is logged once
all connectors have started, and readiness is re-checked every `CONNECTOR_MONITOR_INTERVAL_MS` (default 10s).

A connector implements `Connector` from `src/core/lifecycle.ts` (`init`, `close`, `isReady`). Connectors load their
client library inside `init()`, so a disabled connector never loads it.

## Configuration

All configuration comes from environment variables, validated with [zod](https://zod.dev) at startup: an invalid value
stops the app with a message listing every invalid variable. `.env.example` documents every variable with its default;
`npm run dev` and `npm start` load `.env` when present (Node's `--env-file-if-exists`). In deployments, set real
environment variables (e.g. Kubernetes ConfigMaps and Secrets) and never commit `.env`.

Core settings are in `src/config.ts` (`import config from '@/config'` gives typed values). Each connector reads its own
variables next to its code (`KAFKA_*` in `@connectors/kafka/kafka`, ...), so removing a connector removes its
configuration.

Booleans accept `true`/`false`, `1`/`0` or `yes`/`no`; lists are comma-separated; unset or empty variables use the
default.

## Optional Connectors

All are disabled by default.

- **MSSQL** (`@connectors/mssql/mssql`): set `MSSQL_ENABLED=true` and `MSSQL_DATABASE`.
  `executeQuery(query, inputs, tables)` runs parameterised queries (`@name`); inputs named after a column of `tables`
  get that column's SQL type and length from the schema loaded on startup. `executeSP(procedure, inputs, outputs)` runs
  stored procedures. Parameter values are never logged.
- **Kafka** (`@connectors/kafka/kafka`, Confluent's official client): set `KAFKA_ENABLED=true` and `KAFKA_BROKERS`.
  Register topic handlers with `kafka.subscribe(topic, handler)` when your module loads (a consumer runs only if
  handlers exist) and publish with `await kafka.send(topic, { key, value })`. A handler that throws sends the message to
  `<topic>.dlq` (`KAFKA_DEAD_LETTER_SUFFIX`, empty to retry instead). Set `KAFKA_SSL` and `KAFKA_SASL_MECHANISM`,
  `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD` for managed Kafka.
- **Hazelcast** (`@connectors/hazelcast/hazelcast`): set `HAZELCAST_ENABLED=true` and `HAZELCAST_MEMBERS`. Implements
  `Cache` (`get`, `set` with a TTL in milliseconds, `delete`) over `HAZELCAST_MAP_NAME`, and `map(name)` returns any
  distributed map. Other client options can be added in `hazelcastConfigFromEnv`.
- **Redis** (`@connectors/redis/redis`, works with Valkey): set `REDIS_ENABLED=true` and `REDIS_URL`. Implements `Cache`
  with JSON values, a TTL in milliseconds and an optional `REDIS_KEY_PREFIX`; `redis.raw` is the node-redis client for
  other commands.

## Outbound HTTP

Create one `ServiceRequester` (`@http/service-requester`) per downstream service and reuse it:

```ts
const users = new ServiceRequester('users', { baseURL: 'https://users.internal' });
const res = await users.httpCall<User>({ url: `/users/${id}` });
if (!res.success) return next(HttpException.internal());
```

- Sends `x-request-id` and `traceparent` from the request context (`ref` overrides the request id) and `x-source`
  (`APP_NAME`), with a 5s timeout per attempt.
- Retries 408/429/502/503/504 and network errors with exponential backoff and jitter, honouring `Retry-After`; only
  idempotent methods (GET, HEAD, OPTIONS, PUT, DELETE) are retried unless configured otherwise.
- A circuit breaker shared by all calls to the service opens after 5 consecutive failures (5xx, 408, 429 or no response)
  and lets a trial request through after 30s; while open, calls fail fast with code `ECIRCUITOPEN`.
- Logs method, URL, status and duration only, never headers or bodies.
- Never throws: returns `{ success: true, data, headers }` or `{ success: false, reason: { status, code, message } }`.

`HttpClient` (`@http/http-client`) provides the same retry and circuit breaker options without the service conventions.
Both are built on [cockatiel](https://github.com/connor4312/cockatiel) and axios.

## Maintenance

- Requires Node.js 24 (current LTS, see `.nvmrc`).
- CI (`.github/workflows/ci.yml`) checks formatting, types, tests and the build on every push and pull request.
- [Renovate](https://docs.renovatebot.com) (`renovate.json`) opens monthly dependency update PRs: minor and patch
  updates grouped in one PR, each major update in its own PR. Install the Renovate GitHub app on the repository to
  enable it.

## License

[MIT](LICENSE)
