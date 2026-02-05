import type { AuditColumnMap } from "../types/config.js";
// TODO: Replace all postgres-js imports with either generic db or driver-agnostic
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createAuditTableSQL, createAuditTableSQLFor } from "../storage/schema.js";

/**
 * Initialize the audit logging system
 * Creates the audit_logs table if it doesn't exist
 */
export async function initializeAuditLogging(
  db: PostgresJsDatabase<any>,
  options?: { tableName?: string; columnMap?: Partial<AuditColumnMap> },
): Promise<void> {
  try {
    const sql = options?.tableName
      ? createAuditTableSQLFor(options.tableName, { columnMap: options.columnMap })
      : createAuditTableSQL;
    await db.execute(sql);
    console.log("✓ Audit logging initialized successfully");
  } catch (error) {
    console.error("Failed to initialize audit logging:", error);
    throw error;
  }
}

/**
 * Check if audit logging is properly set up
 */
export async function checkAuditSetup(
  db: PostgresJsDatabase<any>,
  options?: { tableName?: string },
): Promise<boolean> {
  try {
    const tableName = options?.tableName ?? "audit_logs";
    assertSafeIdentifier(tableName);
    const result = await db.execute(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = '${tableName}'
      )
    `);

    return result.rows[0]?.exists === true;
  } catch (error) {
    return false;
  }
}

/**
 * Get audit log statistics
 */
export async function getAuditStats(
  db: PostgresJsDatabase<any>,
  options?: { tableName?: string; columnMap?: Partial<AuditColumnMap> },
): Promise<{
  totalLogs: number;
  logsByAction: Record<string, number>;
  logsByTable: Record<string, number>;
  oldestLog: Date | null;
  newestLog: Date | null;
}> {
  const tableName = options?.tableName ?? "audit_logs";
  assertSafeIdentifier(tableName);
  const columns = {
    action: options?.columnMap?.action ?? "action",
    tableName: options?.columnMap?.tableName ?? "table_name",
    createdAt: options?.columnMap?.createdAt ?? "created_at",
  };
  Object.values(columns).forEach(assertSafeIdentifier);

  const stats = await db.execute(`
    WITH base AS (
      SELECT
        COUNT(*)::int AS total_logs,
        MIN("${columns.createdAt}") AS oldest_log,
        MAX("${columns.createdAt}") AS newest_log
      FROM ${tableName}
    ),
    actions AS (
      SELECT jsonb_object_agg("${columns.action}", action_count) AS logs_by_action
      FROM (
        SELECT "${columns.action}", COUNT(*)::int AS action_count
        FROM ${tableName}
        GROUP BY "${columns.action}"
      ) a
    ),
    tables AS (
      SELECT jsonb_object_agg("${columns.tableName}", table_count) AS logs_by_table
      FROM (
        SELECT "${columns.tableName}", COUNT(*)::int AS table_count
        FROM ${tableName}
        GROUP BY "${columns.tableName}"
      ) t
    )
    SELECT
      base.total_logs,
      base.oldest_log,
      base.newest_log,
      actions.logs_by_action,
      tables.logs_by_table
    FROM base, actions, tables
  `);

  const row = stats.rows[0];

  return {
    totalLogs: row?.total_logs || 0,
    logsByAction: row?.logs_by_action || {},
    logsByTable: row?.logs_by_table || {},
    oldestLog: row?.oldest_log ? new Date(row.oldest_log) : null,
    newestLog: row?.newest_log ? new Date(row.newest_log) : null,
  };
}
function assertSafeIdentifier(name: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
}
