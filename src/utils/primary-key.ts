/**
 * Extract primary key from a record
 * Handles various PK formats: single, composite, UUID, etc.
 */
export function extractPrimaryKey(
  record: Record<string, unknown>,
  tableName: string,
  tableConfigMap: Record<string, { primaryKey: string | string[] }>,
): string {
  const configuredKey = tableConfigMap[tableName]?.primaryKey;
  if (!configuredKey) {
    throw new Error(`tables.${tableName}.primaryKey is required`);
  }

  const configured = extractConfiguredPrimaryKey(record, configuredKey);
  if (configured == null) {
    throw new Error(`record missing configured primaryKey field(s) for table: ${tableName}`);
  }
  return configured;
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

  if (keys.length === 1) {
    return String(resolved[keys[0]!]);
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
  } catch {
    // Final fallback: create a stable hash-like string from object keys
    const keys = Object.keys(record).sort();
    return `composite_key_${keys.join("_")}_${keys.length}`;
  }
}
