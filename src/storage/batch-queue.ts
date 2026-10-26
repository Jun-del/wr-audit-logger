import type { BatchWriterStats } from "../types/config.js";

interface PendingWrite<T> {
  items: T[];
  resolve: () => void;
  reject: (error: unknown) => void;
}

export interface BatchQueueOptions {
  batchSize: number;
  maxQueueSize: number;
  flushInterval: number;
  logError: (message: string, error: unknown) => void;
}

/**
 * Collects items and hands them to `write` in batches: once `batchSize` items are queued,
 * every `flushInterval` ms, on `flush()`/`shutdown()`, and when the process is about to exit.
 *
 * The timer is unref'd and no signal handlers are installed, so the queue never keeps the
 * process alive or changes how it exits. Call `shutdown()` from your own SIGTERM handler.
 */
export class BatchQueue<T> {
  private static active = new Set<BatchQueue<any>>();
  private static flushAllBeforeExit = (): void => {
    for (const queue of BatchQueue.active) {
      queue.flush().catch((error) => {
        queue.options.logError("[AUDIT] Flush before exit failed:", error);
      });
    }
  };

  private pending: PendingWrite<T>[] = [];
  private queuedCount = 0;
  private activeWrite: Promise<void> | null = null;
  private isShuttingDown = false;
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private write: (items: T[]) => Promise<void>,
    private options: BatchQueueOptions,
  ) {
    this.timer = setInterval(() => {
      this.flush().catch((error) => {
        options.logError("[AUDIT] Scheduled flush failed:", error);
      });
    }, options.flushInterval);
    (this.timer as { unref?: () => void }).unref?.();

    if (BatchQueue.active.size === 0 && typeof process?.on === "function") {
      process.on("beforeExit", BatchQueue.flushAllBeforeExit);
    }
    BatchQueue.active.add(this);
  }

  /**
   * Queue items. The returned promise settles once they have been written (or failed to).
   * `flushNow` writes immediately instead of waiting for the batch to fill.
   */
  enqueue(items: T[], flushNow = false): Promise<void> {
    if (this.isShuttingDown) {
      return Promise.reject(new Error("Audit batch queue is shutting down"));
    }
    if (items.length === 0) return Promise.resolve();
    if (this.queuedCount + items.length > this.options.maxQueueSize) {
      return Promise.reject(new Error("Audit batch queue capacity exceeded"));
    }

    const written = new Promise<void>((resolve, reject) => {
      this.pending.push({ items, resolve, reject });
    });
    this.queuedCount += items.length;

    if (flushNow || this.queuedCount >= this.options.batchSize) {
      this.flush().catch(() => {
        // Failures reach the caller through `written`
      });
    }

    return written;
  }

  /**
   * Write everything queued so far, including items queued while a write was in flight.
   */
  async flush(): Promise<void> {
    if (this.activeWrite) {
      await this.activeWrite.catch(() => {});
      return this.flush();
    }
    if (this.pending.length === 0) return;

    const batch = this.pending.splice(0);
    this.queuedCount = 0;
    this.activeWrite = this.writeBatch(batch).finally(() => {
      this.activeWrite = null;
    });
    return this.activeWrite;
  }

  /**
   * Stop the timer, reject new items, and write what is still queued.
   */
  async shutdown(): Promise<void> {
    if (!this.isShuttingDown) {
      this.isShuttingDown = true;
      clearInterval(this.timer);
      BatchQueue.active.delete(this);
      if (BatchQueue.active.size === 0 && typeof process?.off === "function") {
        process.off("beforeExit", BatchQueue.flushAllBeforeExit);
      }
    }
    await this.flush();
  }

  getStats(): BatchWriterStats {
    return {
      queueSize: this.queuedCount,
      isWriting: this.activeWrite !== null,
      isShuttingDown: this.isShuttingDown,
    };
  }

  private async writeBatch(batch: PendingWrite<T>[]): Promise<void> {
    try {
      await this.write(batch.flatMap((pending) => pending.items));
    } catch (error) {
      for (const pending of batch) pending.reject(error);
      throw error;
    }
    for (const pending of batch) pending.resolve();
  }
}
