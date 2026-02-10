/**
 * Extract primary key from a record
 * Handles various PK formats: single, composite, UUID, etc.
 */
export function extractPrimaryKey(
  record: Record<string, unknown>,
  tableName: string,
  primaryKeyMap?: Record<string, string | string[]>,
): string {
  const configuredKey = primaryKeyMap?.[tableName];
  if (configuredKey) {
    const configured = extractConfiguredPrimaryKey(record, configuredKey);
    if (configured != null) return configured;
  }

  // Try common primary key field names
  const commonPkFields = ["id", `${tableName}_id`, "uuid", "pk"];

  for (const field of commonPkFields) {
    if (field in record && record[field] != null) {
      return String(record[field]);
    }
  }

  // If no standard PK found, look for any field ending in 'id' or 'Id'
  const idField = Object.keys(record).find(
    (key) => key.toLowerCase().endsWith("id") && record[key] != null,
  );

  if (idField) {
    return String(record[idField]);
  }

  // Last resort - safe JSON stringify with BigInt and circular reference handling
  return safeStringifyForPK(record);
}

/**
 * Extract primary key from multiple records
 */
export function extractPrimaryKeys(
  records: Record<string, unknown>[],
  tableName: string,
  primaryKeyMap?: Record<string, string | string[]>,
): string[] {
  return records.map((record) => extractPrimaryKey(record, tableName, primaryKeyMap));
}

function extractConfiguredPrimaryKey(
  record: Record<string, unknown>,
  key: string | string[],
): string | null {
  const keys = Array.isArray(key) ? key : [key];
  const resolved: Record<string, unknown> = {};

  for (const field of keys) {
    const value = record[field];
    if (value == null) return null;
    resolved[field] = value;
  }

  if (keys.length === 1 && keys[0]) {
    return String(resolved[keys[0]]);
  }

  return safeStringifyForPK(resolved);
}

/**
 * Safe stringify for primary key generation
 * Handles BigInt, Date, and circular references
 */
function safeStringifyForPK(record: Record<string, unknown>): string {
  const seen = new WeakSet<object>();

  try {
    return JSON.stringify(record, (key, value) => {
      // Handle BigInt
      if (typeof value === "bigint") {
        return value.toString();
      }

      // Handle Date
      if (value instanceof Date) {
        return value.toISOString();
      }

      // Handle circular references
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
      }

      return value;
    });
  } catch (error) {
    // Final fallback: create a stable hash-like string from object keys
    const keys = Object.keys(record).sort();
    return `composite_key_${keys.join("_")}_${keys.length}`;
  }
}
