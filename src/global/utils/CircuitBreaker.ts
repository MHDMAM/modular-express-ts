import { SuccessPromiseObj } from '@lTypes/interfaces';
import logger from '@utils/logger';

export default class CircuitBreaker {
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private failureCount = 0;
  private readonly failureThreshold: number;
  private readonly recoveryTimeout: number;
  private readonly testRequests: number;
  private readonly fallback: () => Promise<any>;

  constructor(
    failureThreshold: number,
    recoveryTimeout: number,
    testRequests: number = 5,
    fallback: () => Promise<any> = async () => ({ success: false, reason: 'Service unavailable' }),
  ) {
    this.failureThreshold = failureThreshold;
    this.recoveryTimeout = recoveryTimeout;
    this.testRequests = testRequests;
    this.fallback = fallback;
  }

  // Type guard to check if result is successPromiseObj
  private isSuccessPromiseObj(result: any): result is SuccessPromiseObj {
    return typeof result === 'object' && 'success' in result;
  }

  public async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      logger.debug('CircuitBreaker -call- State is OPEN .... Calling this.fallback()');
      return this.fallback();
    }

    if (this.state === 'HALF_OPEN') {
      logger.debug('CircuitBreaker -call- State is HALF_OPEN .... Testing the service.');
      return this.testService(fn); // Trigger testService when in HALF_OPEN state
    }

    try {
      logger.debug('CircuitBreaker -call- State is CLOSED .... Calling fn');
      const result = await fn();

      this.failureCount = 0;
      this.state = 'CLOSED';
      logger.debug('CircuitBreaker -call- State updated to CLOSED');

      if (this.isSuccessPromiseObj(result) && !result.success) {
        logger.debug('CircuitBreaker -call- Failed...', result);
        this.failureCount++;
        if (this.failureCount >= this.failureThreshold) {
          logger.debug('CircuitBreaker -call- Failure threshold reached. Opening circuit.');
          this.state = 'OPEN';
          setTimeout(() => (this.state = 'HALF_OPEN'), this.recoveryTimeout);
        }
        return this.fallback();
      }

      return result;
    } catch (error) {
      logger.debug('CircuitBreaker -call- Error occurred...', error);
      this.failureCount++;
      if (this.failureCount >= this.failureThreshold) {
        logger.debug('CircuitBreaker -call- Failure threshold reached. Opening circuit.');
        this.state = 'OPEN';
        setTimeout(() => (this.state = 'HALF_OPEN'), this.recoveryTimeout);
        return this.fallback();
      }
      throw error; // Re-throw to let the caller handle the error
    }
  }

  public async testService<T>(fn: () => Promise<T>): Promise<T> {
    logger.debug('CircuitBreaker -testService- Checking state...');

    if (this.state === 'HALF_OPEN' && this.testRequests >= this.failureThreshold) {
      try {
        logger.debug('CircuitBreaker -testService- Testing service with fn...');

        // Test the service by calling fn()
        const result = await fn();

        // If the function succeeds, reset the state to CLOSED
        this.state = 'CLOSED';
        logger.debug('CircuitBreaker -testService- Service test succeeded. Circuit state set to CLOSED.');
        return result;
      } catch (error) {
        // If it fails, set the state back to OPEN
        this.state = 'OPEN';
        logger.debug('CircuitBreaker -testService- Service test failed. Circuit state set to OPEN.');
        throw error;
      }
    }

    logger.debug('CircuitBreaker -testService- Test requests < failure threshold, calling fallback.');
    return this.fallback();
  }
}
