# nodejs-boilerplate

Express + TypeScript API boilerplate with auto-loaded modules, structured logging, a consistent response envelope and
optional MSSQL, Kafka and Hazelcast connectors.

## Quick Start

```sh
npm i
npm run dev        # nodemon + ts-node, NODE_ENV=development
curl localhost:3000/api/v1/health
```

## Scripts

| Script              | Description                                                |
| ------------------- | ---------------------------------------------------------- |
| `npm run dev`       | Start in watch mode (nodemon + ts-node)                    |
| `npm run debug`     | Same as `dev` with the Node inspector enabled              |
| `npm run build`     | Clean `dist/`, compile with `tsc` and rewrite path aliases |
| `npm start`         | Run the compiled app from `dist/`                          |
| `npm run typecheck` | Type-check without emitting                                |
| `npm run format`    | Format with Prettier (imports organised automatically)     |
| `npm test`          | Run Jest tests from `test/`                                |

## Project Structure

```
src/
  server.ts            # entry point: process signals, unhandled errors, graceful shutdown
  app.ts               # express app: middleware, route loading, error handling, http/https
  config/              # `config` package files, selected by NODE_ENV
  global/
    libs/              # connector singletons: Mssql, Kafka, Hazelcast
    middleware/        # requestLogger, error, notFound, base route + Express Request typings
    types/             # shared types
    utils/             # logger, HttpException, HttpClient, CircuitBreaker, ServiceRequester, ...
  modules/
    health/            # example module
      routerV1.ts
      controller.ts
test/                  # Jest tests
```

## Modules & Routing

Every file matching `routerExp` (default `modules/**/routerV1.{js,ts}`) is loaded automatically and mounted under
`baseUrl` (default `/api/v1`). To add a module, create `src/modules/<name>/routerV1.ts` exporting an Express `Router`.

## Responses & Errors

- Each request gets a `ref` taken from the `x-request-id` header (or a generated UUID), echoed back in the response
  header.
- Object responses sent with `res.send()` get a `_metadata` block (request/response time, processing time) and a default
  `status` of `<statusPrefix>1000` (e.g. `APP1000`).
- Throw or `next()` an `HttpException` (e.g. `HttpException.notFound()`) to return `{ status, message, ...data }` with
  the matching HTTP code. Unknown errors become a 500, invalid JSON bodies a 400.
- Status codes follow `<statusPrefix><version><3-digit code>`; see `formatStatus` in
  `src/global/utils/HttpException.ts`.

## Configuration

Uses [`config`](https://github.com/node-config/node-config): `default.json` is always loaded, then `<NODE_ENV>.json`
overrides it. Secrets must not go in these files, supply them through environment variables mapped in
`custom-environment-variables.json` (`DB_USER`, `DB_PASSWORD`, `DB_SERVER`, `DB_NAME`, `APP_NAME`).

| Env var    | Description                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------- |
| `NODE_ENV` | Selects the config file (`development`, `production`, `test`, ...)                          |
| `PORT`     | Overrides the `PORT` config value                                                           |
| `SSL`      | `true`/`1` serves HTTPS using the `ssl.key` / `ssl.cert` config paths (relative to `dist/`) |

## Optional Connectors

All are disabled by default.

- **MSSQL** (`@libs/Mssql`): connects on first import using the `db` config; tables' column types are loaded so query
  inputs are typed automatically.
- **Kafka** (`@utils/kafka`): set `kafka.enabled` to `true`; `kafka.consumerEnabled` also starts a consumer on
  `kafka.topicName`.
- **Hazelcast** (`@utils/hazelcast`): set `hazelcast.enabled` to `true`; `hazelcast.client` is passed to the Hazelcast
  client as-is.

For outbound HTTP calls use `ServiceRequester` (logging and timing), built on `HttpClient` with an optional
`CircuitBreaker`.
