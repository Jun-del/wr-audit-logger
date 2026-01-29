import type { AuditLog } from "../types/audit.js";
import type { AuditConfig, AuditContext, NormalizedConfig } from "../types/config.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDeleteAuditLogs } from "../capture/delete.js";
import { createInsertAuditLogs } from "../capture/insert.js";
import { createUpdateAuditLogs } from "../capture/update.js";
import { AuditWriter } from "../storage/writer.js";
import { AuditContextManager } from "./context.js";
import { createInterceptedDb } from "./interceptor.js";

/**
 * Main audit logger class
 * Wraps a Drizzle database instance to provide automatic audit logging
 */
export class AuditLogger {
  private config: NormalizedConfig;
  private contextManager = new AuditContextManager();
  private writer: AuditWriter;
  private customWriter?: (logs: any[], context: AuditContext | undefined) => Promise<void> | void;

  constructor(
    private db: PostgresJsDatabase<any>,
    config: AuditConfig,
  ) {
    this.config = this.normalizeConfig(config);
    this.writer = new AuditWriter(db, this.config);
    this.customWriter = config.customWriter;
  }

  /**
   * Normalize configuration with defaults
   */
  private normalizeConfig(config: AuditConfig): NormalizedConfig {
    return {
      tables: config.tables,
      fields: config.fields || {},
      excludeFields: config.excludeFields || ["password", "token", "secret", "apiKey"],
      auditTable: config.auditTable || "audit_logs",
      strictMode: config.strictMode ?? false,
      getUserId: config.getUserId || (() => undefined),
      getMetadata: config.getMetadata || (() => ({})),
      captureOldValues: config.captureOldValues ?? false,
      customWriter: config.customWriter,
    };
  }

  /**
   * Create a wrapped database instance with audit logging
   */
  createAuditedDb(): PostgresJsDatabase<any> {
    return createInterceptedDb(this.db, this);
  }

  /**
   * Check if a table should be audited
   * Exposed for use by interceptor
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
   */
  shouldCaptureOldValues(): boolean {
    return this.config.captureOldValues;
  }

  /**
   * Manually log an INSERT operation
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
   */
  private async writeAuditLogs(logs: any[]): Promise<void> {
    if (logs.length === 0) return;

    const context = this.contextManager.getContext();

    try {
      if (this.customWriter) {
        // Use custom writer
        await this.customWriter(logs, context);
      } else {
        // Use default writer
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
   */
  setContext(context: Partial<AuditContext>): void {
    this.contextManager.mergeContext(context);
  }

  /**
   * Run a function with specific audit context
   */
  withContext<T>(context: AuditContext, fn: () => T): T {
    return this.contextManager.runWithContext(context, fn);
  }

  /**
   * Get current audit context
   */
  getContext(): AuditContext | undefined {
    return this.contextManager.getContext();
  }

  /**
   * Generic manual logging for any operation (READ, custom actions, etc.)
   *
   * @example
   * // Log a READ operation
   * await auditLogger.log({
   *   action: 'READ',
   *   tableName: 'sensitive_documents',
   *   recordId: documentId,
   *   newValues: { accessedFields: ['ssn', 'salary'] },
   *   metadata: { reason: 'compliance_audit' }
   * });
   *
   * @example
   * // Log a custom action
   * await auditLogger.log({
   *   action: 'EXPORT',
   *   tableName: 'customer_data',
   *   recordId: customerId,
   *   metadata: { format: 'CSV', rowCount: 1500 }
   * });
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
}
