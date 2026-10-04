import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HealthCheck } from './health-check.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('HealthCheck', () => {
  it('is healthy until a check fails, and again when one passes', async () => {
    const check = vi.fn(async (_timeoutMs: number) => undefined);
    const health = new HealthCheck(check);
    health.start(1_000);
    expect(health.healthy).toBe(true);

    check.mockRejectedValueOnce(new Error('gone'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(health.healthy).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(health.healthy).toBe(true);
    health.stop();
  });

  it('treats a check that throws synchronously as failed', async () => {
    const health = new HealthCheck(() => {
      throw new Error('not connected');
    });
    health.start(1_000);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(health.healthy).toBe(false);
    health.stop();
  });

  it('gives the check the interval as its time limit, at most 5 seconds', async () => {
    const check = vi.fn(async (_timeoutMs: number) => undefined);
    const health = new HealthCheck(check);

    health.start(200);
    await vi.advanceTimersByTimeAsync(200);
    health.start(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(check.mock.calls).toEqual([[200], [5_000]]);
    health.stop();
  });

  it('does not start another check while one is still running', async () => {
    let finish!: () => void;
    const check = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const health = new HealthCheck(check);
    health.start(100);

    await vi.advanceTimersByTimeAsync(500);
    expect(check).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(100);
    expect(check).toHaveBeenCalledTimes(2);
    health.stop();
  });

  it('does nothing with an interval of 0, and stops checking when stopped', async () => {
    const check = vi.fn(async (_timeoutMs: number) => undefined);
    const health = new HealthCheck(check);

    health.start(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(check).not.toHaveBeenCalled();
    expect(health.healthy).toBe(true);

    health.start(100);
    health.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(check).not.toHaveBeenCalled();
  });

  it('ignores the result of a check that finishes after a restart, and is healthy again', async () => {
    let fail!: (error: Error) => void;
    const check = vi.fn(() => new Promise<void>((_resolve, reject) => (fail = reject)));
    const health = new HealthCheck(check);
    health.start(100);
    await vi.advanceTimersByTimeAsync(100);

    health.start(100);
    fail(new Error('late'));
    await vi.advanceTimersByTimeAsync(0);

    expect(health.healthy).toBe(true);
    health.stop();
  });
});
