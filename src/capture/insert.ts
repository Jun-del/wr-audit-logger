import type { AuditLog } from "../types/audit.js";
import type { NormalizedConfig } from "../types/config.js";
import { extractPrimaryKey } from "../utils/primary-key.js";
import { filterFields } from "../utils/serializer.js";

/**
 * Create audit logs for INSERT operations
 */
export function createInsertAuditLogs(
  tableName: string,
  insertedRecords: Record<string, unknown>[],
  config: NormalizedConfig,
): AuditLog[] {
  return insertedRecords.map((record) => ({
    action: "INSERT" as const,
    tableName,
    recordId: extractPrimaryKey(record, tableName, config.primaryKeyMap),
    values: filterFields(record, tableName, config),
  }));
}
