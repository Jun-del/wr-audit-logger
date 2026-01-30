import type { AuditLog } from "../types/audit.js";
import type { AuditContext } from "../types/config.js";

interface QueuedLog {
  log: AuditLog;
  context: AuditContext | undefined;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Batched wrapper for custom writer functions
 * Allows custom writers to benefit from batching
 */
export class BatchedCustomWriter {
  private queue: QueuedLog[] = [];
  private flushTimeout: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private activeWritePromise: Promise<void> | null = null;

  constructor(
    private customWriter: (
      logs: Array<{
        action: string;
        tableName: string;
        recordId: string;
        oldValues?: Record<string, unknown>;
        newValues?: Record<string, unknown>;
        changedFields?: string[];
        metadata?: Record<string, unknown>;
      }>,
      context: AuditContext | undefined,
    ) => Promise<void> | void,
    private config: {
      batchSize: number;
      flushInterval: number;
      strictMode: boolean;
      waitForWrite: boolean;
    },
  ) {
    // Start flush timer
    this.scheduleFlush();

    // Handle graceful shutdown
    if (typeof process !== "undefined") {
      process.on("beforeExit", () => this.shutdown());
      process.on("SIGTERM", () => this.shutdown());
      process.on("SIGINT", () => this.shutdown());
    }
  }

  /**
   * Add audit logs to the queue (non-blocking)
   */
  async queueAuditLogs(logs: AuditLog[], context: AuditContext | undefined): Promise<void> {
    if (this.isShuttingDown) {
      throw new Error("BatchedCustomWriter is shutting down");
    }

    if (logs.length === 0) return;

    // Create promises for each log
    const promises = logs.map((log) => {
      return new Promise<void>((resolve, reject) => {
        this.queue.push({
          log,
          context,
          resolve,
          reject,
        });
      });
    });

    const shouldFlushNow = this.queue.length >= this.config.batchSize;

    // Trigger flush if queue is full
    if (shouldFlushNow) {
      if (this.config.strictMode || this.config.waitForWrite) {
        await this.flush();
      } else {
        // Don't await here - flush happens async
        this.flush().catch((error) => {
          if (this.config.strictMode) {
            console.error("Failed to flush audit logs:", error);
          }
        });
      }
    }

    const shouldAwaitPromises =
      this.config.strictMode || (this.config.waitForWrite && shouldFlushNow);

    if (!shouldAwaitPromises) {
      // Prevent unhandled rejections when callers don't await writes.
      promises.forEach((promise) => {
        promise.catch(() => {});
      });
    }

    if (shouldAwaitPromises) {
      await Promise.all(promises);
    }
  }

  /**
   * Schedule periodic flush
   */
  private scheduleFlush(): void {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
    }

    this.flushTimeout = setTimeout(() => {
      this.flush()
        .catch((error) => {
          if (this.config.strictMode) {
            console.error("Scheduled flush failed:", error);
          }
        })
        .finally(() => {
          if (!this.isShuttingDown) {
            this.scheduleFlush();
          }
        });
    }, this.config.flushInterval);
  }

  /**
   * Flush all queued logs
   */
  async flush(): Promise<void> {
    // If already writing, wait for that to complete
    if (this.activeWritePromise) {
      return this.activeWritePromise;
    }

    if (this.queue.length === 0) {
      return;
    }

    // Take all queued items
    const itemsToWrite = this.queue.splice(0);

    // Create write promise
    this.activeWritePromise = this.writeToCustomWriter(itemsToWrite).finally(() => {
      this.activeWritePromise = null;
    });

    return this.activeWritePromise;
  }

  /**
   * Write batch to custom writer
   */
  private async writeToCustomWriter(items: QueuedLog[]): Promise<void> {
    if (items.length === 0) return;

    try {
      // Group by context to maintain batching per context
      // (Most custom writers will want logs from same context together)
      const groups = new Map<string, QueuedLog[]>();

      for (const item of items) {
        const contextKey = this.getContextKey(item.context);
        if (!groups.has(contextKey)) {
          groups.set(contextKey, []);
        }
        groups.get(contextKey)!.push(item);
      }

      // Write each context group
      for (const [_, groupItems] of groups) {
        const logs = groupItems.map((item) => item.log);
        const context = groupItems[0]?.context;

        try {
          await this.customWriter(logs, context);

          // Resolve all promises in this group
          groupItems.forEach((item) => item.resolve());
        } catch (error) {
          // Reject all promises in this group
          groupItems.forEach((item) => item.reject(error as Error));
          throw error;
        }
      }
    } catch (error) {
      // If we couldn't group properly, reject all
      items.forEach((item) => item.reject(error as Error));
      throw error;
    }
  }

  /**
   * Generate context key for grouping
   */
  private getContextKey(context: AuditContext | undefined): string {
    if (!context) return "no-context";
    return JSON.stringify({
      userId: context.userId,
      transactionId: context.transactionId,
      // Other context fields that should group together
    });
  }

  /**
   * Graceful shutdown - flush all pending logs
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;

    this.isShuttingDown = true;

    // Clear timer
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    // Wait for active write to complete
    if (this.activeWritePromise) {
      await this.activeWritePromise;
    }

    // Flush remaining items
    if (this.queue.length > 0) {
      await this.flush();
    }
  }

  /**
   * Get current queue size (for monitoring)
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Get writer stats (for monitoring)
   */
  getStats(): {
    queueSize: number;
    isWriting: boolean;
    isShuttingDown: boolean;
  } {
    return {
      queueSize: this.queue.length,
      isWriting: this.activeWritePromise !== null,
      isShuttingDown: this.isShuttingDown,
    };
  }
}
