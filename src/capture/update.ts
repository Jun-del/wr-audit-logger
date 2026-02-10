import type { AuditLog } from "../types/audit.js";
import type { NormalizedConfig } from "../types/config.js";
import { extractPrimaryKey } from "../utils/primary-key.js";
import { filterFields, getChangedValues } from "../utils/serializer.js";

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

  if (config.updateValuesMode === "full" || beforeRecords.length === 0) {
    // Full row mode or fallback when before state isn't available
    for (const after of afterRecords) {
      if (!after) continue;

      const values = filterFields(after, tableName, config);
      logs.push({
        action: "UPDATE" as const,
        tableName,
        recordId: extractPrimaryKey(after, tableName, config.primaryKeyMap),
        values,
      });
    }
    return logs;
  }

  const beforeById = new Map<string, Record<string, unknown>>();
  for (const before of beforeRecords) {
    if (!before) continue;
    beforeById.set(extractPrimaryKey(before, tableName, config.primaryKeyMap), before);
  }

  // Match before and after records by primary key
  for (let i = 0; i < afterRecords.length; i++) {
    const after = afterRecords[i];
    if (!after) continue;

    const before = beforeById.get(extractPrimaryKey(after, tableName, config.primaryKeyMap));
    if (!before) {
      const values = filterFields(after, tableName, config);
      logs.push({
        action: "UPDATE" as const,
        tableName,
        recordId: extractPrimaryKey(after, tableName, config.primaryKeyMap),
        values,
      });
      continue;
    }

    const beforeValues = filterFields(before, tableName, config);
    const afterValues = filterFields(after, tableName, config);
    const changedValues = getChangedValues(beforeValues, afterValues);

    // Only create audit log if something actually changed
    if (changedValues && Object.keys(changedValues).length > 0) {
      logs.push({
        action: "UPDATE" as const,
        tableName,
        recordId: extractPrimaryKey(after, tableName, config.primaryKeyMap),
        values: changedValues,
      });
    }
  }

  return logs;
}
