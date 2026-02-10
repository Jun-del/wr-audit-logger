import type { AuditLog } from "../types/audit.js";
import type { NormalizedConfig } from "../types/config.js";
import { extractPrimaryKey } from "../utils/primary-key.js";
import { filterFields } from "../utils/serializer.js";

/**
 * Create audit logs for DELETE operations
 */
export function createDeleteAuditLogs(
  tableName: string,
  deletedRecords: Record<string, unknown>[],
  config: NormalizedConfig,
): AuditLog[] {
  return deletedRecords.map((record) => ({
    action: "DELETE" as const,
    tableName,
    recordId: extractPrimaryKey(record, tableName, config.primaryKeyMap),
    values: filterFields(record, tableName, config),
  }));
}
