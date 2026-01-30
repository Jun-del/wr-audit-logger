import type { AuditLog, AuditLogEntry } from "../types/audit.js";
import type { AuditContext } from "../types/config.js";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { safeSerialize } from "../utils/serializer.js";

interface QueuedLog {
  log: AuditLog;
  context: AuditContext | undefined;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Batched audit log writer with async queue
 * Collects audit logs and writes them in batches for better performance
 */
export class BatchAuditWriter {
  private static instances = new Set<BatchAuditWriter>();
  private static listenersAttached = false;
  private static handleBeforeExit = (): void => {
    BatchAuditWriter.shutdownAll();
  };
  private static handleSigterm = (): void => {
    BatchAuditWriter.shutdownAll();
  };
  private static handleSigint = (): void => {
    BatchAuditWriter.shutdownAll();
  };

  private static shutdownAll(): void {
    for (const instance of Array.from(BatchAuditWriter.instances)) {
      instance.shutdown().catch((error) => {
        console.error("Failed to shutdown batch audit writer:", error);
      });
    }
  }

  private static registerInstance(instance: BatchAuditWriter): void {
    BatchAuditWriter.instances.add(instance);

    if (!BatchAuditWriter.listenersAttached && typeof process !== "undefined") {
      process.on("beforeExit", BatchAuditWriter.handleBeforeExit);
      process.on("SIGTERM", BatchAuditWriter.handleSigterm);
      process.on("SIGINT", BatchAuditWriter.handleSigint);
      BatchAuditWriter.listenersAttached = true;
    }
  }

  private static unregisterInstance(instance: BatchAuditWriter): void {
    BatchAuditWriter.instances.delete(instance);

    if (
      BatchAuditWriter.listenersAttached &&
      BatchAuditWriter.instances.size === 0 &&
      typeof process !== "undefined"
    ) {
      process.off("beforeExit", BatchAuditWriter.handleBeforeExit);
      process.off("SIGTERM", BatchAuditWriter.handleSigterm);
      process.off("SIGINT", BatchAuditWriter.handleSigint);
      BatchAuditWriter.listenersAttached = false;
    }
  }

  private queue: QueuedLog[] = [];
  private flushTimeout: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private activeWritePromise: Promise<void> | null = null;

  constructor(
    private db: PostgresJsDatabase<any>,
    private config: {
      auditTable: string;
      batchSize: number;
      flushInterval: number;
      strictMode: boolean;
      waitForWrite: boolean;
      getUserId: () => string | undefined | Promise<string | undefined>;
      getMetadata: () => Record<string, unknown> | Promise<Record<string, unknown>>;
    },
  ) {
    // Start flush timer
    this.scheduleFlush();

    // Handle graceful shutdown for all instances with shared listeners
    BatchAuditWriter.registerInstance(this);
  }

  /**
   * Add audit logs to the queue (non-blocking)
   */
  async queueAuditLogs(logs: AuditLog[], context: AuditContext | undefined): Promise<void> {
    if (this.isShuttingDown) {
      throw new Error("BatchAuditWriter is shutting down");
    }

    if (logs.length === 0) return;

    // Resolve user ID and metadata once for the entire batch
    const userId = await this.config.getUserId();
    const metadata = await this.config.getMetadata();

    // Create promises for each log
    const promises = logs.map((log) => {
      return new Promise<void>((resolve, reject) => {
        this.queue.push({
          log: {
            ...log,
            metadata: { ...metadata, ...context?.metadata, ...log.metadata },
          },
          context: {
            ...context,
            userId: userId || context?.userId,
          },
          resolve,
          reject,
        });
      });
    });

    // Trigger flush if queue is full
    if (this.queue.length >= this.config.batchSize) {
      // Don't await here - flush happens async
      this.flush().catch((error) => {
        if (this.config.strictMode) {
          console.error("Failed to flush audit logs:", error);
        }
      });
    }

    const shouldAwait = this.config.waitForWrite || this.config.strictMode;

    if (!shouldAwait) {
      // Prevent unhandled rejections when callers don't await writes.
      promises.forEach((promise) => {
        promise.catch(() => {});
      });
    }

    // In strict mode or waitForWrite, wait for all logs to be written
    if (shouldAwait) {
      await this.flush();
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
   * Flush all queued logs to database
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
    this.activeWritePromise = this.writeToDatabase(itemsToWrite).finally(() => {
      this.activeWritePromise = null;
    });

    return this.activeWritePromise;
  }

  /**
   * Write batch to database
   */
  private async writeToDatabase(items: QueuedLog[]): Promise<void> {
    if (items.length === 0) return;

    try {
      // Convert to entries
      const entries: AuditLogEntry[] = items.map((item) => ({
        ...item.log,
        userId: item.context?.userId,
        ipAddress: item.context?.ipAddress,
        userAgent: item.context?.userAgent,
        metadata: item.log.metadata,
        transactionId: item.context?.transactionId,
      }));

      // Build values for bulk insert
      const values = entries.map((entry) => ({
        user_id: entry.userId || null,
        ip_address: entry.ipAddress || null,
        user_agent: entry.userAgent || null,
        action: entry.action,
        table_name: entry.tableName,
        record_id: entry.recordId,
        old_values: entry.oldValues ? safeSerialize(entry.oldValues) : null,
        new_values: entry.newValues ? safeSerialize(entry.newValues) : null,
        changed_fields: entry.changedFields || null,
        metadata: entry.metadata ? safeSerialize(entry.metadata) : null,
        transaction_id: entry.transactionId || null,
      }));

      // Use raw SQL for bulk insert with JSONB
      await this.db.execute(sql`
        INSERT INTO ${sql.identifier(this.config.auditTable)} (
          user_id, ip_address, user_agent, action, table_name, record_id,
          old_values, new_values, changed_fields, metadata, transaction_id
        )
        SELECT
          user_id, ip_address, user_agent, action, table_name, record_id,
          old_values, new_values, changed_fields, metadata, transaction_id
        FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS t(
          user_id VARCHAR,
          ip_address VARCHAR,
          user_agent TEXT,
          action VARCHAR,
          table_name VARCHAR,
          record_id VARCHAR,
          old_values JSONB,
          new_values JSONB,
          changed_fields TEXT[],
          metadata JSONB,
          transaction_id VARCHAR
        )
      `);

      // Resolve all promises
      items.forEach((item) => item.resolve());
    } catch (error) {
      // Reject all promises
      items.forEach((item) => item.reject(error as Error));
      throw error;
    }
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

    BatchAuditWriter.unregisterInstance(this);
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
