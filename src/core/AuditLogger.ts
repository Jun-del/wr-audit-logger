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

  constructor(
    private db: PostgresJsDatabase<any>,
    config: AuditConfig,
  ) {
    this.config = this.normalizeConfig(config);
    this.writer = new AuditWriter(db, this.config);
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
    };
  }

  /**
   * Check if a table should be audited
   */
  private shouldAuditInternal(tableName: string): boolean {
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
   * Create a wrapped database instance with audit logging
   * This is now the automatic interceptor implementation
   */
  createAuditedDb(): PostgresJsDatabase<any> {
    return createInterceptedDb(this.db, this);
  }

  /**
   * Internal method to check if table should be audited
   * Exposed for use by interceptor
   */
  shouldAudit(tableName: string): boolean {
    return this.shouldAuditInternal(tableName);
  }

  /**
   * Manually log an INSERT operation
   * Use this in your insert handlers
   */
  async logInsert(
    tableName: string,
    insertedRecords: Record<string, unknown> | Record<string, unknown>[],
  ): Promise<void> {
    if (!this.shouldAuditInternal(tableName)) return;

    const records = Array.isArray(insertedRecords) ? insertedRecords : [insertedRecords];
    const logs = createInsertAuditLogs(tableName, records, this.config);

    await this.writer.writeAuditLogs(logs, this.contextManager.getContext());
  }

  /**
   * Manually log an UPDATE operation
   * You need to provide both before and after states
   */
  async logUpdate(
    tableName: string,
    beforeRecords: Record<string, unknown> | Record<string, unknown>[],
    afterRecords: Record<string, unknown> | Record<string, unknown>[],
  ): Promise<void> {
    if (!this.shouldAuditInternal(tableName)) return;

    const before = Array.isArray(beforeRecords) ? beforeRecords : [beforeRecords];
    const after = Array.isArray(afterRecords) ? afterRecords : [afterRecords];
    const logs = createUpdateAuditLogs(tableName, before, after, this.config);

    await this.writer.writeAuditLogs(logs, this.contextManager.getContext());
  }

  /**
   * Manually log a DELETE operation
   */
  async logDelete(
    tableName: string,
    deletedRecords: Record<string, unknown> | Record<string, unknown>[],
  ): Promise<void> {
    if (!this.shouldAuditInternal(tableName)) return;

    const records = Array.isArray(deletedRecords) ? deletedRecords : [deletedRecords];
    const logs = createDeleteAuditLogs(tableName, records, this.config);

    await this.writer.writeAuditLogs(logs, this.contextManager.getContext());
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
}
