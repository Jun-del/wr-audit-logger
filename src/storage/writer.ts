import type { AuditLog, AuditLogEntry } from "../types/audit.js";
import type { AuditContext, NormalizedConfig } from "../types/config.js";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { mergeMetadata } from "../utils/metadata.js";
import { getAuditInsertColumns } from "./column-map.js";

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
        metadata: mergeMetadata(metadata, context?.metadata, log.metadata) ?? undefined,
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
    const columns = getAuditInsertColumns(this.config.auditColumnMap);

    // Build values for bulk insert
    const values = entries.map((entry) => {
      const row: Record<string, unknown> = {};
      for (const column of columns) {
        row[column.name] = column.getValue(entry);
      }
      return row;
    });

    // Use raw SQL for bulk insert with JSONB
    const insertColumns = sql.join(
      columns.map((column) => sql.identifier(column.name)),
      sql`, `,
    );
    const recordsetColumns = columns.map((column) => `"${column.name}" ${column.type}`).join(", ");

    await this.db.execute(sql`
      INSERT INTO ${sql.identifier(tableName)} (
        ${insertColumns}
      )
      SELECT
        ${insertColumns}
      FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS t(${sql.raw(recordsetColumns)})
    `);
  }
}
