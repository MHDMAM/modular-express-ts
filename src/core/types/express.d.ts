import { UUID } from 'crypto';

// Extending the Express Request type globally in TypeScript
declare global {
  interface BigInt {
    toJSON(): number;
    toString(): string;
  }

  namespace Express {
    export interface Request {
      benchmark: bigint;
      ref: UUID | string;
      requestTime?: number;
      responseTime?: number;
    }
  }
}
