# syntax=docker/dockerfile:1

# Compiles src/ to dist/ with the development dependencies
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# The image that runs: production dependencies and dist/ only
FROM node:24-slim
# Logs go to stdout for the platform to collect; set LOG_OUTPUT=file and mount LOG_DIR as a volume to keep files
ENV NODE_ENV=production LOG_OUTPUT=stdout
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
