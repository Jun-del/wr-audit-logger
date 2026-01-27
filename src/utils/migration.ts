// TODO: Replace all postgres-js imports with either generic db or driver-agnostic
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createAuditTableSQL } from "../storage/schema.js";

/**
 * Initialize the audit logging system
 * Creates the audit_logs table if it doesn't exist
 */
export async function initializeAuditLogging(db: PostgresJsDatabase<any>): Promise<void> {
  try {
    await db.execute(createAuditTableSQL);
    console.log("✓ Audit logging initialized successfully");
  } catch (error) {
    console.error("Failed to initialize audit logging:", error);
    throw error;
  }
}

/**
 * Check if audit logging is properly set up
 */
export async function checkAuditSetup(db: PostgresJsDatabase<any>): Promise<boolean> {
  try {
    const result = await db.execute(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'audit_logs'
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
export async function getAuditStats(db: PostgresJsDatabase<any>): Promise<{
  totalLogs: number;
  logsByAction: Record<string, number>;
  logsByTable: Record<string, number>;
  oldestLog: Date | null;
  newestLog: Date | null;
}> {
  const stats = await db.execute(`
    SELECT 
      COUNT(*)::int as total_logs,
      MIN(created_at) as oldest_log,
      MAX(created_at) as newest_log,
      jsonb_object_agg(
        action, 
        action_count
      ) as logs_by_action,
      jsonb_object_agg(
        table_name, 
        table_count
      ) as logs_by_table
    FROM (
      SELECT 
        action,
        COUNT(*)::int as action_count,
        table_name,
        COUNT(*)::int as table_count,
        created_at
      FROM audit_logs
      GROUP BY action, table_name, created_at
    ) subquery
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
