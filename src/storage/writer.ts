import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { AuditLogEntry } from "../types/audit.js";
import type { AuditColumnMap } from "../types/config.js";
import { getAuditInsertColumns } from "./column-map.js";

/**
 * Insert audit log entries into the audit table with a single statement.
 * `db` may be the root database or a transaction.
 */
export async function insertAuditLogs(
  db: PostgresJsDatabase<any>,
  auditTable: string,
  columnMap: AuditColumnMap,
  entries: AuditLogEntry[],
): Promise<void> {
  if (entries.length === 0) return;

  const columns = getAuditInsertColumns(columnMap);
  const values = entries.map((entry) => {
    const row: Record<string, unknown> = {};
    for (const column of columns) {
      row[column.name] = column.getValue(entry);
    }
    return row;
  });

  // Bulk insert through jsonb_to_recordset so the whole batch is one parameter
  const insertColumns = sql.join(
    columns.map((column) => sql.identifier(column.name)),
    sql`, `,
  );
  const recordsetColumns = columns.map((column) => `"${column.name}" ${column.type}`).join(", ");

  await db.execute(sql`
    INSERT INTO ${sql.identifier(auditTable)} (
      ${insertColumns}
    )
    SELECT
      ${insertColumns}
    FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS t(${sql.raw(recordsetColumns)})
  `);
}
