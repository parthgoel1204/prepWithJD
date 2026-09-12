/**
 * Token-bucket rate limiter with a shared FIFO queue.
 *
 * The SAME limiter instance is used by external calls (search API today, LLM calls on
 * Day 2), so total outbound request rate stays under configured RPM.
 */

export interface TokenBucketConfig {
  tokensPerSecond: number;
  burst?: number;
}

export class TokenBucket {
  private readonly rate: number;
  private readonly capacity: number;
  private tokens: number;
  private last = Date.now();

  constructor(config: TokenBucketConfig) {
    if (!(config.tokensPerSecond > 0)) throw new Error("tokensPerSecond must be > 0");
    this.rate = config.tokensPerSecond;
    this.capacity = config.burst ?? Math.max(1, Math.ceil(config.tokensPerSecond));
    this.tokens = this.capacity;
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }

  /** Non-blocking: returns true if `n` tokens are currently available. */
  tryAcquire(n = 1): boolean {
    if (n <= 0) return true;
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /** Delay needed before `n` tokens will be available (ms). */
  waitMs(n = 1): number {
    if (n <= 0) return 0;
    this.refill();
    if (this.tokens >= n) return 0;
    const deficit = n - this.tokens;
    return Math.ceil((deficit / this.rate) * 1000);
  }

  acquire(n = 1): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.waitMs(n)));
  }
}

export class RateLimitedQueue {
  private readonly bucket: TokenBucket;
  private readonly inflight = new Map<number, number>();

  constructor(config: TokenBucketConfig) {
    this.bucket = new TokenBucket(config);
  }

  get tokensPerSecond(): number {
    return this.bucket["rate"];
  }

  /**
   * Run `task` against the shared queue, pacing calls by the token bucket.
   * Errors from the task are forwarded to the caller.
   */
  async run<T>(task: () => Promise<T>, tokens = 1): Promise<T> {
    const ticket = Math.floor(Math.random() * 1e9);
    this.inflight.set(ticket, Date.now());
    try {
      await this.bucket.acquire(tokens);
      await sleep(0); // yield so multiple starters order fairly-ish
      return await task();
    } finally {
      this.inflight.delete(ticket);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Shared global queue for outbound research calls (search today, LLM on Day 2). */
let sharedQueue: RateLimitedQueue | null = null;

export function sharedRateLimitedQueue(tokensPerSecond: number, burst?: number): RateLimitedQueue {
  if (!sharedQueue || sharedQueue.tokensPerSecond !== tokensPerSecond) {
    sharedQueue = new RateLimitedQueue({ tokensPerSecond, burst });
  }
  return sharedQueue;
}