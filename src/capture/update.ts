import { isDeepStrictEqual } from "node:util";
import type { AuditLog } from "../types/audit.js";
import type { NormalizedConfig } from "../types/config.js";
import { extractPrimaryKey } from "../utils/primary-key.js";
import { filterFields, getChangedValues, isFieldTracked } from "../utils/serializer.js";

/** Stored in place of an excluded field's value when that field changed */
export const REDACTED = "[REDACTED]";

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
        recordId: extractPrimaryKey(after, tableName, config.tables),
        values,
      });
    }
    return logs;
  }

  const beforeById = new Map<string, Record<string, unknown>>();
  for (const before of beforeRecords) {
    if (!before) continue;
    beforeById.set(extractPrimaryKey(before, tableName, config.tables), before);
  }

  // Match before and after records by primary key
  for (let i = 0; i < afterRecords.length; i++) {
    const after = afterRecords[i];
    if (!after) continue;

    const before = beforeById.get(extractPrimaryKey(after, tableName, config.tables));
    if (!before) {
      const values = filterFields(after, tableName, config);
      logs.push({
        action: "UPDATE" as const,
        tableName,
        recordId: extractPrimaryKey(after, tableName, config.tables),
        values,
      });
      continue;
    }

    const beforeValues = filterFields(before, tableName, config);
    const afterValues = filterFields(after, tableName, config);
    const changedValues = getChangedValues(beforeValues, afterValues) ?? {};

    // Excluded values are never stored, but a change to one (e.g. a password reset) still is
    for (const field of config.excludeFields) {
      if (
        field in after &&
        isFieldTracked(field, tableName, config) &&
        !isDeepStrictEqual(before[field], after[field])
      ) {
        changedValues[field] = REDACTED;
      }
    }

    // Only create audit log if something actually changed
    if (Object.keys(changedValues).length > 0) {
      logs.push({
        action: "UPDATE" as const,
        tableName,
        recordId: extractPrimaryKey(after, tableName, config.tables),
        values: changedValues,
      });
    }
  }

  return logs;
}
