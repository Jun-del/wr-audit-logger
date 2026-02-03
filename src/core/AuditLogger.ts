import type { BatchAuditWriterStats } from "../storage/batch-writer.js";
import type { BatchedCustomWriterStats } from "../storage/batched-custom-writer.js";
import type { AuditLog } from "../types/audit.js";
import type { AuditConfig, AuditContext, NormalizedConfig } from "../types/config.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDeleteAuditLogs } from "../capture/delete.js";
import { createInsertAuditLogs } from "../capture/insert.js";
import { createUpdateAuditLogs } from "../capture/update.js";
import { BatchAuditWriter } from "../storage/batch-writer.js";
import { BatchedCustomWriter } from "../storage/batched-custom-writer.js";
import { AuditWriter } from "../storage/writer.js";
import { AuditContextManager } from "./context.js";
import { createInterceptedDb } from "./interceptor.js";

/**
 * Main audit logger class
 * Wraps a Drizzle database instance to provide automatic audit logging
 *
 * @example
 * ```typescript
 * const auditLogger = new AuditLogger(db, {
 *   tables: ['users', 'posts'],
 *   excludeFields: ['password'],
 *   getUserId: () => getCurrentUser()?.id
 * });
 *
 * const auditedDb = auditLogger.createAuditedDb();
 * await auditedDb.insert(users).values({ ... });
 * ```
 */
export class AuditLogger<TSchema extends Record<string, unknown> = any> {
  private config: NormalizedConfig;
  private contextManager = new AuditContextManager();
  private writer: AuditWriter | null = null;
  private batchWriter: BatchAuditWriter | null = null;
  private batchedCustomWriter: BatchedCustomWriter | null = null;
  private customWriter?: AuditConfig["customWriter"];

  /**
   * Creates a new AuditLogger instance
   *
   * @param db - Drizzle database instance to wrap
   * @param config - Audit configuration options
   * @throws {Error} If config validation fails (e.g., invalid batch size)
   *
   * @example
   * ```typescript
   * const logger = new AuditLogger(db, {
   *   tables: ['users'],
   *   batch: { batchSize: 100, flushInterval: 1000 }
   * });
   * ```
   */
  constructor(
    private db: PostgresJsDatabase<TSchema>,
    config: AuditConfig,
  ) {
    this.config = this.normalizeConfig(config);
    this.validateConfig(this.config);
    this.customWriter = config.customWriter;

    // Initialize appropriate writer
    if (this.config.batch && config.customWriter) {
      // Use batched custom writer
      this.batchedCustomWriter = new BatchedCustomWriter(config.customWriter, {
        batchSize: this.config.batch.batchSize,
        flushInterval: this.config.batch.flushInterval,
        strictMode: this.config.strictMode,
        waitForWrite: this.config.batch.waitForWrite,
      });
    } else if (this.config.batch) {
      // Use batch writer (standard)
      this.batchWriter = new BatchAuditWriter(db, {
        auditTable: this.config.auditTable,
        batchSize: this.config.batch.batchSize,
        flushInterval: this.config.batch.flushInterval,
        strictMode: this.config.strictMode,
        getUserId: this.config.getUserId,
        getMetadata: this.config.getMetadata,
        waitForWrite: this.config.batch.waitForWrite,
      });
    } else {
      // Use immediate writer
      this.writer = new AuditWriter(db, this.config);
    }
  }

  /**
   * Validate configuration values
   * @private
   * @throws {Error} If configuration is invalid
   */
  private validateConfig(config: NormalizedConfig): void {
    if (config.batch) {
      if (config.batch.batchSize <= 0) {
        throw new Error("batchSize must be greater than 0");
      }
      if (config.batch.flushInterval <= 0) {
        throw new Error("flushInterval must be greater than 0");
      }
    }

    if (config.tables !== "*" && config.tables.length === 0) {
      throw new Error("tables array cannot be empty. Use '*' for all tables.");
    }
  }

  /**
   * Normalize configuration with defaults
   * @private
   */
  private normalizeConfig(config: AuditConfig): NormalizedConfig {
    const batchConfig = config.batch
      ? {
          batchSize: config.batch.batchSize ?? 100,
          flushInterval: config.batch.flushInterval ?? 1000,
          waitForWrite: config.batch.waitForWrite ?? false,
        }
      : null;

    return {
      tables: config.tables,
      fields: config.fields || {},
      excludeFields: config.excludeFields || ["password", "token", "secret", "apiKey"],
      auditTable: config.auditTable || "audit_logs",
      strictMode: config.strictMode ?? false,
      getUserId: config.getUserId || (() => undefined),
      getMetadata: config.getMetadata || (() => ({})),
      captureOldValues: config.captureOldValues ?? false,
      batch: batchConfig,
      customWriter: config.customWriter,
    };
  }

  /**
   * Create a wrapped database instance with automatic audit logging
   *
   * @returns Database instance that automatically logs all INSERT/UPDATE/DELETE operations
   *
   * @example
   * ```typescript
   * const auditedDb = logger.createAuditedDb();
   * await auditedDb.insert(users).values({ email: 'user@example.com' });
   * // Audit log created automatically
   * ```
   */
  createAuditedDb(): PostgresJsDatabase<TSchema> {
    return createInterceptedDb(this.db, this);
  }

  /**
   * Check if a table should be audited
   * Exposed for use by interceptor
   *
   * @param tableName - Name of the table to check
   * @returns True if the table should be audited
   *
   * @example
   * ```typescript
   * if (logger.shouldAudit('users')) {
   *   // Table is being audited
   * }
   * ```
   */
  shouldAudit(tableName: string): boolean {
    // Never audit the audit table itself
    if (tableName === this.config.auditTable) {
      return false;
    }

    if (this.config.tables === "*") {
      return true;
    }

    return this.config.tables.includes(tableName);
  }

  /**
   * Check if old values should be captured for UPDATE operations
   * Exposed for use by interceptor
   *
   * @returns True if old values should be captured
   *
   * @example
   * ```typescript
   * if (logger.shouldCaptureOldValues()) {
   *   // Will run SELECT before UPDATE to get old values
   * }
   * ```
   */
  shouldCaptureOldValues(): boolean {
    return this.config.captureOldValues;
  }

  /**
   * Manually log an INSERT operation
   *
   * @param tableName - Name of the table
   * @param insertedRecords - Record(s) that were inserted
   *
   * @example
   * ```typescript
   * await logger.logInsert('users', { id: 1, email: 'user@example.com' });
   * ```
   */
  async logInsert(
    tableName: string,
    insertedRecords: Record<string, unknown> | Record<string, unknown>[],
  ): Promise<void> {
    if (!this.shouldAudit(tableName)) return;

    const records = Array.isArray(insertedRecords) ? insertedRecords : [insertedRecords];
    const logs = createInsertAuditLogs(tableName, records, this.config);

    await this.writeAuditLogs(logs);
  }

  /**
   * Manually log an UPDATE operation
   *
   * @param tableName - Name of the table
   * @param beforeRecords - Record(s) before the update
   * @param afterRecords - Record(s) after the update
   *
   * @example
   * ```typescript
   * await logger.logUpdate('users',
   *   { id: 1, name: 'Old' },
   *   { id: 1, name: 'New' }
   * );
   * ```
   */
  async logUpdate(
    tableName: string,
    beforeRecords: Record<string, unknown> | Record<string, unknown>[],
    afterRecords: Record<string, unknown> | Record<string, unknown>[],
  ): Promise<void> {
    if (!this.shouldAudit(tableName)) return;

    const before = Array.isArray(beforeRecords) ? beforeRecords : [beforeRecords];
    const after = Array.isArray(afterRecords) ? afterRecords : [afterRecords];
    const logs = createUpdateAuditLogs(tableName, before, after, this.config);

    await this.writeAuditLogs(logs);
  }

  /**
   * Manually log a DELETE operation
   *
   * @param tableName - Name of the table
   * @param deletedRecords - Record(s) that were deleted
   *
   * @example
   * ```typescript
   * await logger.logDelete('users', { id: 1, email: 'deleted@example.com' });
   * ```
   */
  async logDelete(
    tableName: string,
    deletedRecords: Record<string, unknown> | Record<string, unknown>[],
  ): Promise<void> {
    if (!this.shouldAudit(tableName)) return;

    const records = Array.isArray(deletedRecords) ? deletedRecords : [deletedRecords];
    const logs = createDeleteAuditLogs(tableName, records, this.config);

    await this.writeAuditLogs(logs);
  }

  /**
   * Internal method to write audit logs (uses custom writer if provided)
   * @private
   */
  private async writeAuditLogs(logs: any[]): Promise<void> {
    if (logs.length === 0) return;

    const context = this.contextManager.getContext();

    try {
      if (this.batchedCustomWriter) {
        // Use batched custom writer
        const writePromise = this.batchedCustomWriter.queueAuditLogs(logs, context);

        // Wait for write if configured
        if (this.config.batch?.waitForWrite || this.config.strictMode) {
          await writePromise;
        } else {
          writePromise.catch((error) => {
            console.error("Failed to write audit logs:", error);
          });
        }
      } else if (this.customWriter) {
        // Use custom writer (immediate - no batching)
        await this.customWriter(logs, context);
      } else if (this.batchWriter) {
        // Use batch writer (standard)
        const writePromise = this.batchWriter.queueAuditLogs(logs, context);

        // Wait for write if configured
        if (this.config.batch?.waitForWrite || this.config.strictMode) {
          await writePromise;
        } else {
          writePromise.catch((error) => {
            console.error("Failed to write audit logs:", error);
          });
        }
      } else if (this.writer) {
        // Use immediate writer (standard)
        await this.writer.writeAuditLogs(logs, context);
      }
    } catch (error) {
      if (this.config.strictMode) {
        throw error;
      }
      console.error("Failed to write audit logs:", error);
    }
  }

  /**
   * Set audit context for current async scope
   *
   * @param context - Partial context to merge with existing context
   *
   * @example
   * ```typescript
   * logger.setContext({
   *   userId: 'user-123',
   *   ipAddress: req.ip,
   *   userAgent: req.headers['user-agent']
   * });
   * ```
   */
  setContext(context: Partial<AuditContext>): void {
    this.contextManager.mergeContext(context);
  }

  /**
   * Run a function with specific audit context
   *
   * @param context - Context to use for the operation
   * @param fn - Function to execute with the context
   * @returns Result of the function
   *
   * @example
   * ```typescript
   * await logger.withContext(
   *   { userId: 'admin', metadata: { reason: 'bulk_import' } },
   *   async () => {
   *     await db.insert(users).values([...]);
   *   }
   * );
   * ```
   */
  withContext<T>(context: AuditContext, fn: () => T): T {
    return this.contextManager.runWithContext(context, fn);
  }

  /**
   * Get current audit context
   *
   * @returns Current audit context or undefined if not set
   *
   * @example
   * ```typescript
   * const context = logger.getContext();
   * console.log('Current user:', context?.userId);
   * ```
   */
  getContext(): AuditContext | undefined {
    return this.contextManager.getContext();
  }

  /**
   * Generic manual logging for any operation (READ, custom actions, etc.)
   *
   * @param entry - Audit log entry details
   * @param entry.action - Action type (e.g., 'READ', 'EXPORT')
   * @param entry.tableName - Table name
   * @param entry.recordId - Record identifier
   * @param entry.oldValues - Optional old values
   * @param entry.newValues - Optional new values
   * @param entry.metadata - Optional metadata
   *
   * @example
   * ```typescript
   * // Log a READ operation
   * await logger.log({
   *   action: 'READ',
   *   tableName: 'sensitive_documents',
   *   recordId: documentId,
   *   newValues: { accessedFields: ['ssn', 'salary'] },
   *   metadata: { reason: 'compliance_audit' }
   * });
   *
   * // Log a custom action
   * await logger.log({
   *   action: 'EXPORT',
   *   tableName: 'customer_data',
   *   recordId: customerId,
   *   metadata: { format: 'CSV', rowCount: 1500 }
   * });
   * ```
   */
  async log(entry: {
    action: string;
    tableName: string;
    recordId: string;
    oldValues?: Record<string, unknown>;
    newValues?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.shouldAudit(entry.tableName)) return;

    const log: AuditLog = {
      action: entry.action,
      tableName: entry.tableName,
      recordId: entry.recordId,
      oldValues: entry.oldValues,
      newValues: entry.newValues,
      changedFields:
        entry.oldValues && entry.newValues
          ? Object.keys(entry.newValues).filter(
              (key) =>
                JSON.stringify(entry.oldValues![key]) !== JSON.stringify(entry.newValues![key]),
            )
          : undefined,
      metadata: entry.metadata,
    };

    await this.writeAuditLogs([log]);
  }

  /**
   * Manually flush pending batch logs (only works with batch mode)
   *
   * @returns Promise that resolves when flush is complete
   *
   * @example
   * ```typescript
   * // Insert many records
   * for (const record of records) {
   *   await db.insert(users).values(record);
   * }
   *
   * // Ensure all logs are written before continuing
   * await logger.flush();
   * ```
   */
  async flush(): Promise<void> {
    if (this.batchWriter) {
      await this.batchWriter.flush();
    }
    if (this.batchedCustomWriter) {
      await this.batchedCustomWriter.flush();
    }
  }

  /**
   * Gracefully shutdown the audit logger
   * Flushes all pending logs before shutting down
   *
   * @returns Promise that resolves when shutdown is complete
   *
   * @example
   * ```typescript
   * // On application shutdown
   * process.on('SIGTERM', async () => {
   *   await logger.shutdown();
   *   process.exit(0);
   * });
   * ```
   */
  async shutdown(): Promise<void> {
    if (this.batchWriter) {
      await this.batchWriter.shutdown();
    }
    if (this.batchedCustomWriter) {
      await this.batchedCustomWriter.shutdown();
    }
  }

  /**
   * Get batch writer stats (only available in batch mode)
   *
   * @returns Writer statistics or undefined if not in batch mode
   *
   * @example
   * ```typescript
   * const stats = logger.getStats();
   * if (stats) {
   *   console.log('Queue size:', stats.queueSize);
   *   console.log('Is writing:', stats.isWriting);
   * }
   * ```
   */
  getStats(): BatchAuditWriterStats | BatchedCustomWriterStats | undefined {
    if (this.batchWriter) {
      return this.batchWriter.getStats();
    }
    if (this.batchedCustomWriter) {
      return this.batchedCustomWriter.getStats();
    }
    return undefined;
  }
}
