/**
 * Extract primary key from a record
 * Handles various PK formats: single, composite, UUID, etc.
 */
export function extractPrimaryKey(record: Record<string, unknown>, tableName: string): string {
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

  // Last resort: use entire record as JSON (for composite keys or no PK)
  // This is not ideal but ensures we can always generate a record identifier
  return JSON.stringify(record);
}

/**
 * Extract primary key from multiple records
 */
export function extractPrimaryKeys(
  records: Record<string, unknown>[],
  tableName: string,
): string[] {
  return records.map((record) => extractPrimaryKey(record, tableName));
}
