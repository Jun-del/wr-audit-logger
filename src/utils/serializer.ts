import { isDeepStrictEqual } from "node:util";
import type { NormalizedConfig } from "../types/config.js";

/**
 * Filter record fields based on configuration
 * Removes excluded fields and keeps only specified fields if configured
 */
export function filterFields(
  record: Record<string, unknown> | undefined | null,
  tableName: string,
  config: NormalizedConfig,
): Record<string, unknown> | undefined {
  if (!record) return undefined;

  const filtered = { ...record };

  // Remove globally excluded fields
  for (const field of config.excludeFields) {
    delete filtered[field];
  }

  // If specific fields are configured for this table, keep only those
  const fields = config.fields as Record<string, string[] | undefined>;
  if (fields[tableName]) {
    const allowedFields = fields[tableName];
    for (const key of Object.keys(filtered)) {
      if (!allowedFields.includes(key)) {
        delete filtered[key];
      }
    }
  }

  return filtered;
}

/**
 * Get list of fields that changed between two records
 */
export function getChangedFields(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): string[] {
  if (!before || !after) return [];

  const changed: string[] = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    if (!isDeepStrictEqual(before[key], after[key])) {
      changed.push(key);
    }
  }

  return changed;
}

/**
 * Get changed values (after) for keys that differ between before/after
 */
export function getChangedValues(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!before || !after) return undefined;

  const changed: Record<string, unknown> = {};
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    if (!isDeepStrictEqual(before[key], after[key])) {
      changed[key] = after[key];
    }
  }

  return changed;
}

/**
 * Safely serialize a value for storage
 * Handles dates, bigints, and other special types
 */
export function safeSerialize(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "object") {
    if (Array.isArray(value)) {
      return value.map(safeSerialize);
    }

    const serialized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      serialized[key] = safeSerialize(val);
    }
    return serialized;
  }

  return value;
}
