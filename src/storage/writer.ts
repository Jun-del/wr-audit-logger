import type { AuditLog, AuditLogEntry } from "../types/audit.js";
import type { AuditContext, NormalizedConfig } from "../types/config.js";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { safeSerialize } from "../utils/serializer.js";

/**
 * Writes audit logs to the database
 */
export class AuditWriter {
  constructor(
    private db: PostgresJsDatabase<any>,
    private config: NormalizedConfig,
  ) {}

  /**
   * Write audit logs to the database
   */
  async writeAuditLogs(logs: AuditLog[], context: AuditContext | undefined): Promise<void> {
    if (logs.length === 0) return;

    try {
      const userId = await this.config.getUserId();
      const metadata = await this.config.getMetadata();

      const entries: AuditLogEntry[] = logs.map((log) => ({
        ...log,
        userId: userId || context?.userId,
        ipAddress: context?.ipAddress,
        userAgent: context?.userAgent,
        metadata: { ...metadata, ...context?.metadata, ...log.metadata },
        transactionId: context?.transactionId,
      }));

      await this.insertAuditLogs(entries);
    } catch (error) {
      if (this.config.strictMode) {
        throw error;
      }
      // Log error but don't fail the operation
      console.error("Failed to write audit logs:", error);
    }
  }

  /**
   * Insert audit log entries into the database
   */
  private async insertAuditLogs(entries: AuditLogEntry[]): Promise<void> {
    const tableName = this.config.auditTable;

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
      INSERT INTO ${sql.identifier(tableName)} (
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
  }
}
