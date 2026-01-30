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

  if (!config.captureOldValues) {
    for (const after of afterRecords) {
      if (!after) continue;

      const newValues = filterFields(after, tableName, config);
      logs.push({
        action: "UPDATE" as const,
        tableName,
        recordId: extractPrimaryKey(after, tableName),
        oldValues: undefined,
        newValues,
        changedFields: undefined,
      });
    }
    return logs;
  }

  if (beforeRecords.length === 0) {
    // Fallback: log updates even when old values can't be captured.
    for (const after of afterRecords) {
      if (!after) continue;

      const newValues = filterFields(after, tableName, config);
      logs.push({
        action: "UPDATE" as const,
        tableName,
        recordId: extractPrimaryKey(after, tableName),
        oldValues: undefined,
        newValues,
        changedFields: undefined,
      });
    }
    return logs;
  }

  const beforeById = new Map<string, Record<string, unknown>>();
  for (const before of beforeRecords) {
    if (!before) continue;
    beforeById.set(extractPrimaryKey(before, tableName), before);
  }

  // Match before and after records by primary key
  for (let i = 0; i < afterRecords.length; i++) {
    const after = afterRecords[i];
    if (!after) continue;

    const before = beforeById.get(extractPrimaryKey(after, tableName));
    if (!before) {
      const newValues = filterFields(after, tableName, config);
      logs.push({
        action: "UPDATE" as const,
        tableName,
        recordId: extractPrimaryKey(after, tableName),
        oldValues: undefined,
        newValues,
        changedFields: undefined,
      });
      continue;
    }

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
