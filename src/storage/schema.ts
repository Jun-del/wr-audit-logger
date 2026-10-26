import { bigserial, index, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import type { AuditColumnMap } from "../types/config.js";
import { assertSafeIdentifier } from "../utils/identifier.js";
import { DEFAULT_AUDIT_COLUMN_MAP } from "./column-map.js";

/**
 * Audit logs table schema
 * Stores all database operation audit trails
 */
const DEFAULT_TABLE_NAME = "audit_logs";

function normalizeColumnMap(map?: Partial<AuditColumnMap>): AuditColumnMap {
  // oxlint-disable-next-line unicorn/no-useless-fallback-in-spread
  const merged = { ...DEFAULT_AUDIT_COLUMN_MAP, ...(map || {}) };
  const seen = new Set<string>();
  for (const name of Object.values(merged)) {
    assertSafeIdentifier(name);
    if (seen.has(name)) {
      throw new Error(`Duplicate column name in columnMap: ${name}`);
    }
    seen.add(name);
  }
  return merged;
}

export const auditLogs = pgTable(
  DEFAULT_TABLE_NAME,
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),

    // Who performed the action
    userId: varchar("user_id", { length: 255 }),
    ipAddress: varchar("ip_address", { length: 45 }), // IPv6 compatible
    userAgent: text("user_agent"),

    // What action was performed
    action: varchar("action", { length: 255 }).notNull(),
    tableName: varchar("table_name", { length: 255 }).notNull(),
    recordId: varchar("record_id", { length: 255 }).notNull(),

    // Data changes
    values: jsonb("values"),

    // When it happened
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    // Additional context
    metadata: jsonb("metadata"),
    transactionId: varchar("transaction_id", { length: 255 }),

    // Soft delete for retention
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // Indexes for common query patterns
    index("idx_audit_logs_table_record").on(table.tableName, table.recordId),
    index("idx_audit_logs_user_id").on(table.userId),
    index("idx_audit_logs_created_at").on(table.createdAt.desc()),
    index("idx_audit_logs_action").on(table.action),
    index("idx_audit_logs_table_created").on(table.tableName, table.createdAt.desc()),
  ],
);

/**
 * SQL migration to create the audit_logs table (default name)
 * Run this to set up the database
 */
function buildCreateAuditTableSQL(tableName: string, columnMap?: Partial<AuditColumnMap>): string {
  assertSafeIdentifier(tableName);
  const columns = normalizeColumnMap(columnMap);

  const table = `"${tableName}"`;
  const sequence = `"${tableName}_${columns.id}_seq"`;
  const indexName = (suffix: string) => `"idx_${tableName}_${suffix}"`;

  return `
-- Serialize concurrent initializations (e.g. several app instances starting at once)
SELECT pg_advisory_xact_lock(913742, 540129);

CREATE SEQUENCE IF NOT EXISTS ${sequence};

CREATE TABLE IF NOT EXISTS ${table} (
  "${columns.id}" BIGINT PRIMARY KEY DEFAULT nextval('${sequence}'),
  
  "${columns.userId}" VARCHAR(255),
  "${columns.ipAddress}" VARCHAR(45),
  "${columns.userAgent}" TEXT,
  
  "${columns.action}" VARCHAR(255) NOT NULL,
  "${columns.tableName}" VARCHAR(255) NOT NULL,
  "${columns.recordId}" VARCHAR(255) NOT NULL,
  
  "${columns.values}" JSONB,
  
  "${columns.createdAt}" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  "${columns.metadata}" JSONB,
  "${columns.transactionId}" VARCHAR(255),
  
  "${columns.deletedAt}" TIMESTAMPTZ
);

-- Only runs DDL when needed: it locks the table, and this may run on every app start.
-- The constraint/column checks upgrade tables created by older versions.
DO $audit_upgrade$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_depend
    WHERE objid = '${sequence}'::regclass AND refobjid = '${table}'::regclass AND deptype = 'a'
  ) THEN
    ALTER SEQUENCE ${sequence} OWNED BY ${table}."${columns.id}";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '${table}'::regclass AND conname = '${tableName}_action_check'
  ) THEN
    ALTER TABLE ${table} DROP CONSTRAINT "${tableName}_action_check";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = '${table}'::regclass
      AND attname = '${columns.action}'
      AND format_type(atttypid, atttypmod) <> 'character varying(255)'
  ) THEN
    ALTER TABLE ${table} ALTER COLUMN "${columns.action}" TYPE VARCHAR(255);
  END IF;

  -- CREATE INDEX IF NOT EXISTS still locks the table before it checks the name
  IF to_regclass('${indexName("table_record")}') IS NULL THEN
    CREATE INDEX ${indexName("table_record")} ON ${table}("${columns.tableName}", "${columns.recordId}");
  END IF;
  IF to_regclass('${indexName("user_id")}') IS NULL THEN
    CREATE INDEX ${indexName("user_id")} ON ${table}("${columns.userId}") WHERE "${columns.userId}" IS NOT NULL;
  END IF;
  IF to_regclass('${indexName("created_at")}') IS NULL THEN
    CREATE INDEX ${indexName("created_at")} ON ${table}("${columns.createdAt}" DESC);
  END IF;
  IF to_regclass('${indexName("action")}') IS NULL THEN
    CREATE INDEX ${indexName("action")} ON ${table}("${columns.action}");
  END IF;
  IF to_regclass('${indexName("table_created")}') IS NULL THEN
    CREATE INDEX ${indexName("table_created")} ON ${table}("${columns.tableName}", "${columns.createdAt}" DESC);
  END IF;
END
$audit_upgrade$;

COMMENT ON TABLE ${table} IS 'Audit trail for all database operations';
`;
}

/**
 * SQL migration to create the audit_logs table (default name)
 * Run this to set up the database
 */
export const createAuditTableSQL = buildCreateAuditTableSQL(DEFAULT_TABLE_NAME);

/**
 * SQL migration for a custom audit table name
 */
export function createAuditTableSQLFor(
  tableName = DEFAULT_TABLE_NAME,
  options?: { columnMap?: Partial<AuditColumnMap> },
): string {
  return buildCreateAuditTableSQL(tableName, options?.columnMap);
}

export function createAuditLogsTable(
  tableName = DEFAULT_TABLE_NAME,
  extraColumns?: Record<string, any>,
) {
  return pgTable(
    tableName,
    {
      id: bigserial("id", { mode: "number" }).primaryKey(),
      userId: varchar("user_id", { length: 255 }),
      ipAddress: varchar("ip_address", { length: 45 }),
      userAgent: text("user_agent"),
      action: varchar("action", { length: 255 }).notNull(),
      tableName: varchar("table_name", { length: 255 }).notNull(),
      recordId: varchar("record_id", { length: 255 }).notNull(),
      values: jsonb("values"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      metadata: jsonb("metadata"),
      transactionId: varchar("transaction_id", { length: 255 }),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
      ...extraColumns,
    },
    (table) => [
      index(`idx_${tableName}_table_record`).on(table.tableName, table.recordId),
      index(`idx_${tableName}_user_id`).on(table.userId),
      index(`idx_${tableName}_created_at`).on(table.createdAt.desc()),
      index(`idx_${tableName}_action`).on(table.action),
      index(`idx_${tableName}_table_created`).on(table.tableName, table.createdAt.desc()),
    ],
  );
}
