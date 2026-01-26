import type { AuditLog } from "../types/audit.js";
import type { NormalizedConfig } from "../types/config.js";
import { extractPrimaryKey } from "../utils/primary-key.js";
import { filterFields, getChangedFields } from "../utils/serializer.js";

/**
 * Create audit logs for UPDATE operations
 */
export function createUpdateAuditLogs(
  tableName: string,
  beforeRecords: Record<string, unknown>[],
  afterRecords: Record<string, unknown>[],
  config: NormalizedConfig,
): AuditLog[] {
  const logs: AuditLog[] = [];

  // Match before and after records by primary key
  for (let i = 0; i < afterRecords.length; i++) {
    const after = afterRecords[i];
    const before = beforeRecords[i]; // Assumes same order; improve with PK matching

    if (!before || !after) continue;

    const oldValues = filterFields(before, tableName, config);
    const newValues = filterFields(after, tableName, config);
    const changedFields = getChangedFields(oldValues, newValues);

    // Only create audit log if something actually changed
    if (changedFields.length > 0) {
      logs.push({
        action: "UPDATE" as const,
        tableName,
        recordId: extractPrimaryKey(after, tableName),
        oldValues,
        newValues,
        changedFields,
      });
    }
  }

  return logs;
}
