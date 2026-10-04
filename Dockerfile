# syntax=docker/dockerfile:1

# Compiles src/ to dist/ with the development dependencies
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Production dependencies, without the source maps and type declarations that only development uses
FROM node:24-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && find node_modules -name '*.map' -delete -o -name '*.d.ts' -delete -o -name '*.d.mts' -delete -o -name '*.d.cts' -delete \
  && mkdir logs

# The image that runs: Node.js only (no shell, no npm), as the unprivileged user "nonroot" (uid 65532)
FROM gcr.io/distroless/nodejs24-debian12:nonroot
# Logs go to stdout for the platform to collect; set LOG_OUTPUT=file and mount a volume on /app/logs to keep files
ENV NODE_ENV=production LOG_OUTPUT=stdout
WORKDIR /app
COPY package.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies --chown=nonroot:nonroot /app/logs ./logs
COPY --from=build /app/dist ./dist
EXPOSE 3000
# The image's entrypoint is node
CMD ["dist/server.js"]
