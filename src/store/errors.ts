export class StoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreConfigError';
  }
}

export class StoreLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreLockedError';
  }
}

export class RetryableRefreshError extends Error {
  constructor(message = 'Timed out waiting for upstream token refresh') {
    super(message);
    this.name = 'RetryableRefreshError';
  }
}

export class LeaseLostError extends Error {
  constructor(message = 'Refresh lease expired or owned by another instance') {
    super(message);
    this.name = 'LeaseLostError';
  }
}

export class StoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreUnavailableError';
  }
}

export class CutoverFenceError extends Error {
  readonly kitCode = 'cutover_fence_error';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CutoverFenceError';
    Object.defineProperty(this, 'kitCode', { value: 'cutover_fence_error', enumerable: true });
  }
}

export class CutoverRefusedError extends Error {
  readonly kitCode = 'cutover_refused';
  readonly retryAfterSeconds: number;
  readonly cutoverState?: string;
  readonly epoch?: number;

  constructor(
    message: string = 'Cutover in progress; operation temporarily unavailable',
    options?: { cause?: unknown; retryAfterSeconds?: number; cutoverState?: string; epoch?: number },
  ) {
    super(message, options);
    this.name = 'CutoverRefusedError';
    Object.defineProperty(this, 'kitCode', { value: 'cutover_refused', enumerable: true });
    this.retryAfterSeconds = options?.retryAfterSeconds ?? 30;
    this.cutoverState = options?.cutoverState;
    this.epoch = options?.epoch;
  }
}

export function isCutoverFenceError(err: unknown): err is CutoverFenceError {
  return Boolean(
    err &&
      typeof err === 'object' &&
      ((err as any).kitCode === 'cutover_fence_error' || (err as any).name === 'CutoverFenceError'),
  );
}

export function isCutoverRefusedError(err: unknown): err is CutoverRefusedError {
  return Boolean(
    err &&
      typeof err === 'object' &&
      (err as any).kitCode === 'cutover_refused',
  );
}
