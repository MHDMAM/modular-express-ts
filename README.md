# modular-express-ts

Express + TypeScript API boilerplate with auto-loaded modules, structured logging, a consistent response envelope and
optional MSSQL, Kafka, Hazelcast and Redis connectors.

## Creating a Project

Copy the template (GitHub's "Use this template", or `npx degit MHDMAM/modular-express-ts my-app`), then keep only the
features you need:

```sh
node scaffold/scaffold.ts --name my-app --features http,redis   # or --features none
npm install
```

Features: `http`, `mssql`, `kafka`, `hazelcast`, `redis`, `config-file`, `docker`, `pm2`, `ecs` (see
`scaffold/features.json`). The others are removed with their code, tests, dependencies, environment variables and
documentation; the script also renames the project and then removes itself.

## Quick Start

```sh
npm i
cp .env.example .env   # optional: every variable has a default
npm run dev            # tsx watch mode, NODE_ENV=development
curl localhost:3000/api/v1/health
```

## Scripts

| Script                 | Description                                                  |
| ---------------------- | ------------------------------------------------------------ |
| `npm run dev`          | Start in watch mode (tsx), loading `.env` if present         |
| `npm run debug`        | Same as `dev` with the Node inspector enabled                |
| `npm run build`        | Clean `dist/` and compile with `tsc`                         |
| `npm start`            | Run the compiled app from `dist/`, loading `.env` if present |
| `npm run typecheck`    | Type-check without emitting                                  |
| `npm run format`       | Format with Prettier (imports sorted automatically)          |
| `npm run format:check` | Check formatting (as CI does)                                |
| `npm test`             | Run the Vitest tests (`npm run test:watch` to watch)         |

`npm run test:integration` runs the connector tests in `test/integration/` against real servers (needs Docker).

## Project Structure

```
src/
  server.ts              # entry point: process signals, unhandled errors, graceful shutdown
  app.ts                 # express app: middleware, route loading, error handling, http/https
  config.ts              # core configuration from environment variables (zod)
  core/                  # always present: framework plumbing
    errors.ts            # HttpException and status codes
    logger.ts            # pino, JSON lines with the request context
    log-file.ts          # daily log files and the log time zone
    config-file.ts       # optional config.json, copied into the environment at startup
    health-check.ts      # periodic check used by connectors for readiness
    request-context.ts   # AsyncLocalStorage: requestId, traceId
    lifecycle.ts         # Connector interface, init/close, statuses, monitor
    routes.ts            # route auto-loader
    middleware/          # request-logger, error, not-found
    types/express.d.ts   # Express Request typings
  connectors/            # optional, one folder per connector (code, env schema, tests)
    index.ts             # registry: started before listening, closed on shutdown
    hazelcast/
    kafka/
    mssql/
    redis/
  http/                  # optional outbound HTTP: HttpClient, ServiceRequester
  modules/
    health/              # example module
      health.routes.ts
      health.controller.ts
      health.test.ts
    welcome/             # GET / on the API base path
test/                    # cross-cutting tests and test helpers (support/)
```

Code in one folder imports another through Node's
[subpath imports](https://nodejs.org/api/packages.html#subpath-imports) (e.g. `#config`, `#core/*`, `#connectors/*`,
defined under `imports` in `package.json`). With the `development` condition (used by `npm run dev`, the tests and the
type checker) they resolve to `src/*.ts`; otherwise to the compiled `dist/*.js`, so the build needs no path rewriting.

## Modules & Routing

Every file matching `ROUTES_GLOB` (default `modules/**/*.routes.{js,ts}`) is loaded automatically and its default export
(an Express `Router`) is mounted under `API_BASE_PATH` (default `/api/v1`). To add a module, create
`src/modules/<name>/<name>.routes.ts`, with its controller and tests (`<name>.test.ts`) next to it.

## Request Context & Logging

Every request runs inside a request context (Node's `AsyncLocalStorage`) holding a `requestId` (from `x-request-id`, or
generated) and a W3C `traceId` (from `traceparent`, or generated). Anything running during the request, however deep in
the call chain, can read it with `getRequestContext()` from `#core/request-context`, without passing ids around.

- Every log line written during the request gets `requestId` and `traceId` automatically. Logs are one JSON object per
  line: `{ level, time, requestId, traceId, ...fields }`; errors are serialized with their type, message and stack.
- The ids follow a request across services: `ServiceRequester` forwards `x-request-id` and `traceparent` downstream.
- `kafka.send()` adds the same headers to messages, and Kafka handlers run in a context rebuilt from them.
- Request/response headers and bodies are not logged, as they may carry credentials or personal data.
- Add request metadata once it is known with `setRequestContext()`, e.g. `setRequestContext({ userRef })` in an auth
  middleware: later logs in that request include it. New fields go in the `RequestContext` interface.
- Keep the context to request metadata (ids, tenant, user reference); pass business data as normal arguments.

Logs are written with [pino](https://getpino.io) (`import logger from '#core/logger'`):

- By default to one file per day, `LOG_DIR/app-YYYY-MM-DD.log`, with the errors also in `error-YYYY-MM-DD.log`.
  `LOG_OUTPUT` chooses `file`, `stdout` or `both` (`both` in development). Under Docker, set `LOG_OUTPUT=stdout` so the
  platform collects the logs, or mount `LOG_DIR` as a volume.
- Times and the daily files follow the machine's time zone, or `LOG_TIMEZONE` (e.g. `Asia/Kuala_Lumpur`). Times carry
  their offset: `2026-10-04T08:30:00.123+08:00`.
- `LOG_LEVEL` is `debug` in development and `info` otherwise. `LOG_RETENTION_DAYS` deletes older daily files (0 keeps
  them all).
- Files are written synchronously, so nothing is lost when the process exits, and several processes (e.g. pm2 cluster
  mode) can append to the same file.

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

Core settings are in `src/config.ts` (`import config from '#config'` gives typed values). Each connector reads its own
variables (`<NAME>_*`) next to its code in `src/connectors/<name>/`, so removing a connector removes its configuration.

Booleans accept `true`/`false`, `1`/`0` or `yes`/`no`; lists are comma-separated; unset or empty variables use the
default.

- **`config.json`** (optional, for hosts where a file is easier than environment variables, e.g. pm2 on a server): a
  flat JSON object named like the variables, see `config.example.json`. It is read from the working directory, or from
  the path in `CONFIG_FILE`, and copied into the environment before validation. A variable set in both the file and the
  environment (or `.env`) with different values stops the app, so neither silently wins: keep each variable in one
  place. `npm run dev` sets `NODE_ENV` itself, so leave it out of a file used for development. Never commit the file.

## Optional Connectors

All are disabled by default.

- **MSSQL** (`#connectors/mssql/mssql`): set `MSSQL_ENABLED=true` and `MSSQL_DATABASE`.
  `executeQuery<Row>(query, inputs, tables)` runs parameterised queries (`@name`); inputs named after a column of
  `tables` (tables or views, `schema.name`, or `name` where SQL Server finds it without a schema) are declared exactly
  like that column (length, precision, scale), and a value too long for its column is rejected.
  `executeSP(procedure, inputs, outputs)` runs stored procedures, typing the parameters from the procedure's definition.
  `{ datatype, typeLength, scale, value }` sets a type explicitly; other inputs are typed by the driver (a `Table` built
  with the driver is sent as a table-valued parameter). `transaction(async (tx) => { ... })` commits when the callback
  resolves and rolls back when it throws. `for await (const row of streamQuery<Row>(query, inputs, tables))` reads large
  results row by row without holding them in memory, and cancels the query when the loop is left early. A last
  `{ timeoutMs }` argument overrides the request timeout for one statement. The schema is loaded in the background once
  connected: statements that need it wait, the others do not; `refreshSchema()` reloads it after a migration. Parameter
  values are never logged. The server is pinged every `MSSQL_HEALTH_CHECK_INTERVAL_MS`, so the readiness check notices a
  server that went away even without traffic.
- **Kafka** (`#connectors/kafka/kafka`, Confluent's official client): set `KAFKA_ENABLED=true` and `KAFKA_BROKERS`.
  Register topic handlers with `kafka.subscribe(topic, handler)` when your module loads (a consumer runs only if
  handlers exist) and publish with `await kafka.send(topic, { key, value })`. A handler that throws sends the message to
  `<topic>.dlq` (`KAFKA_DEAD_LETTER_SUFFIX`, empty to retry instead). Set `KAFKA_SSL` and `KAFKA_SASL_MECHANISM`,
  `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD` for managed Kafka. A send fails after `KAFKA_SEND_TIMEOUT_MS` when the
  brokers do not take the message, and the brokers are checked every `KAFKA_HEALTH_CHECK_INTERVAL_MS` for the readiness
  check. Set `KAFKA_ADDRESS_FAMILY=v4` if the first connection to a `localhost` broker is slow (Docker on Windows).
- **Hazelcast** (`#connectors/hazelcast/hazelcast`): set `HAZELCAST_ENABLED=true` and `HAZELCAST_MEMBERS`. Implements
  `Cache` (`get`, `set` with a TTL in milliseconds, `delete`) over `HAZELCAST_MAP_NAME` with values stored as JSON text,
  and `map(name)` returns any distributed map with the client's own serialization. Other client options can be added in
  `hazelcastConfigFromEnv`. The client keeps reconnecting for as long as the cluster is away, and operations fail at
  once meanwhile. Entries expire with a resolution of about a second.
- **Redis** (`#connectors/redis/redis`, works with Valkey): set `REDIS_ENABLED=true` and `REDIS_URL`. Implements `Cache`
  with JSON values, a TTL in milliseconds and an optional `REDIS_KEY_PREFIX`; `redis.raw` is the node-redis client for
  other commands. Commands fail at once while the server is unreachable (no offline queue), and `Cache` commands fail
  after `REDIS_COMMAND_TIMEOUT_MS` when it does not answer, so a cache that is down does not hold requests.

## Outbound HTTP

Create one `ServiceRequester` (`#http/service-requester`) per downstream service and reuse it:

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

`HttpClient` (`#http/http-client`) provides the same retry and circuit breaker options without the service conventions.
Both are built on [cockatiel](https://github.com/connor4312/cockatiel) and axios.

## Deployment

The settings are environment variables in every environment (see Configuration). The files below are starting points:
complete them for your infrastructure.

- **Docker** (`Dockerfile`, `.dockerignore`): `docker build -t my-app .` compiles the app and builds an image with the
  production dependencies and `dist/` only, on a [distroless](https://github.com/GoogleContainerTools/distroless) base:
  Node.js without a shell or npm, running as an unprivileged user with `NODE_ENV=production` and `LOG_OUTPUT=stdout`.
  Pass the settings when starting it, e.g. `docker run -p 3000:3000 --env-file .env my-app`. To keep log files, set
  `LOG_OUTPUT=file` and mount a volume on `/app/logs`. `.dockerignore` lets only the files the build needs reach Docker,
  so `.env` and other local files are never in the image. `docker stop` shuts the app down gracefully. There is no shell
  to open in the container; to debug, build from the `:debug-nonroot` tag of the base image, which has one.
- **pm2** (`ecosystem.config.cjs`), for a Linux or Windows host: after `npm ci && npm run build`, start the app with
  `pm2 start ecosystem.config.cjs`. It runs `dist/server.js` with `NODE_ENV=production` and reads `.env` from the
  project folder when there is one. The app writes its own daily log files to `LOG_DIR`, so pm2's log files only hold
  what is printed before the logger starts (e.g. an invalid setting). `pm2 stop` and `pm2 reload` shut the app down
  gracefully, on Windows too (pm2 sends a message there instead of a signal). Set `instances` and `exec_mode: 'cluster'`
  to use several processes.
- **AWS ECS** (`ecs/task-definition.example.json`): a sample Fargate task definition for an image of this app. Its
  health check calls `/nodejs/bin/node`, where the distroless image has Node.js; use `node` with another base image. The
  settings go under `environment`, named like the variables in `.env.example`. Passwords and other secrets go under
  `secrets` as `{ "name": "<VARIABLE>", "valueFrom": "<Secrets Manager or Parameter Store ARN>" }`, never under
  `environment`. Logs go to stdout and from there to CloudWatch (`awslogs`). Replace the `<...>` placeholders, then
  register it with `aws ecs register-task-definition --cli-input-json file://ecs/task-definition.example.json`.

## Maintenance

- Requires Node.js 24 (current LTS, see `.nvmrc`). The project is ES modules (relative imports end in `.js`), compiled
  with TypeScript 7 in strict mode; unused imports and variables fail the type check.
- CI (`.github/workflows/ci.yml`) checks formatting, types, tests and the build on every push and pull request.
- [Renovate](https://docs.renovatebot.com) (`renovate.json`) opens monthly dependency update PRs: minor and patch
  updates grouped in one PR, each major update in its own PR. Install the Renovate GitHub app on the repository to
  enable it.

## License

[MIT](LICENSE)
