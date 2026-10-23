import type { ErrorCode, Failure, Snapshot } from '@todo/contracts';

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly snapshot?: Snapshot,
    readonly details?: Failure['details'],
  ) {
    super(message);
  }
}
