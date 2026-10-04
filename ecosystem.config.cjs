// pm2 process file: `pm2 start ecosystem.config.cjs` after `npm ci && npm run build` (see Deployment in the README).
// CommonJS (.cjs) because pm2 loads it with require() and the project is ES modules.
module.exports = {
  apps: [
    {
      name: 'modular-express-ts',
      script: 'dist/server.js',
      // Settings files and LOG_DIR resolve against the project folder, wherever pm2 is started from
      cwd: __dirname,
      // Reads .env from the project folder when there is one, like `npm start`
      node_args: '--env-file-if-exists=.env',
      env: { NODE_ENV: 'production' },
      // 'cluster' with `instances: 'max'` runs one process per CPU; they can share the daily log files
      exec_mode: 'fork',
      instances: 1,
      // Above SHUTDOWN_TIMEOUT_MS (10s), so a graceful shutdown can finish before pm2 kills the process
      kill_timeout: 12_000,
      // Windows has no signals, so pm2 asks for the shutdown with a message, handled in src/server.ts
      shutdown_with_message: true,
    },
  ],
};
