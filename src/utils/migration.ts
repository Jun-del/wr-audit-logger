import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createAuditTableSQL, createAuditTableSQLFor } from "../storage/schema.js";
import type { AuditColumnMap } from "../types/config.js";
import { assertSafeIdentifier } from "./identifier.js";

/**
 * node-postgres returns `{ rows }`; postgres-js and most other drivers return the rows array.
 */
function resultRows(result: unknown): Record<string, any>[] {
  if (Array.isArray(result)) return result;
  return (result as { rows?: Record<string, any>[] } | null)?.rows ?? [];
}

/**
 * Initialize the audit logging system
 * Creates the audit_logs table if it doesn't exist
 */
export async function initializeAuditLogging(
  db: PostgresJsDatabase<any>,
  options?: { tableName?: string; columnMap?: Partial<AuditColumnMap> },
): Promise<void> {
  const sql = options?.tableName
    ? createAuditTableSQLFor(options.tableName, { columnMap: options.columnMap })
    : createAuditTableSQL;
  await db.execute(sql);
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

    return resultRows(result)[0]?.exists === true;
  } catch {
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
      FROM "${tableName}"
    ),
    actions AS (
      SELECT jsonb_object_agg("${columns.action}", action_count) AS logs_by_action
      FROM (
        SELECT "${columns.action}", COUNT(*)::int AS action_count
        FROM "${tableName}"
        GROUP BY "${columns.action}"
      ) a
    ),
    tables AS (
      SELECT jsonb_object_agg("${columns.tableName}", table_count) AS logs_by_table
      FROM (
        SELECT "${columns.tableName}", COUNT(*)::int AS table_count
        FROM "${tableName}"
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

  const row = resultRows(stats)[0];

  return {
    totalLogs: row?.total_logs || 0,
    logsByAction: row?.logs_by_action || {},
    logsByTable: row?.logs_by_table || {},
    oldestLog: row?.oldest_log ? new Date(row.oldest_log) : null,
    newestLog: row?.newest_log ? new Date(row.newest_log) : null,
  };
}
