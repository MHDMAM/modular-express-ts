/**
 * Calls `check` regularly and remembers whether the last call succeeded, for connectors whose client does not notice
 * (or does not report) that its server went away. `check` receives the time it may take.
 */
export class HealthCheck {
  private timer?: NodeJS.Timeout;
  private passing = true;

  constructor(private readonly check: (timeoutMs: number) => Promise<unknown>) {}

  /** False once a check failed, until one succeeds again. Failures are not logged: the connector monitor reports them. */
  get healthy(): boolean {
    return this.passing;
  }

  /** (Re)starts the checks, healthy until one fails. An interval of 0 or less disables them. */
  start(intervalMs = 0): void {
    this.stop();
    this.passing = true;
    if (intervalMs <= 0) return;
    let checking = false;
    const timer = setInterval(async () => {
      // A check still running (a slow server) is not doubled
      if (checking) return;
      checking = true;
      const passed = await Promise.resolve()
        .then(() => this.check(Math.min(intervalMs, 5_000)))
        .then(
          () => true,
          () => false,
        );
      checking = false;
      // Ignored when stopped or restarted meanwhile
      if (this.timer === timer) this.passing = passed;
    }, intervalMs);
    // Does not keep the process alive
    this.timer = timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
