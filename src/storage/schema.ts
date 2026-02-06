import type { AuditColumnMap } from "../types/config.js";
import { bigserial, index, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * Audit logs table schema
 * Stores all database operation audit trails
 */
const DEFAULT_TABLE_NAME = "audit_logs";

const DEFAULT_COLUMN_MAP: AuditColumnMap = {
  id: "id",
  userId: "user_id",
  ipAddress: "ip_address",
  userAgent: "user_agent",
  action: "action",
  tableName: "table_name",
  recordId: "record_id",
  values: "values",
  createdAt: "created_at",
  metadata: "metadata",
  transactionId: "transaction_id",
  deletedAt: "deleted_at",
};

function assertSafeIdentifier(name: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
}

function normalizeColumnMap(map?: Partial<AuditColumnMap>): AuditColumnMap {
  // oxlint-disable-next-line unicorn/no-useless-fallback-in-spread
  const merged = { ...DEFAULT_COLUMN_MAP, ...(map || {}) };
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
  const indexPrefix = `idx_${tableName}`;
  const sequenceName = `${tableName}_${columns.id}_seq`;

  return `
-- Prevent concurrent test runs from racing on schema creation
SELECT pg_advisory_xact_lock(913742, 540129);

CREATE SEQUENCE IF NOT EXISTS ${sequenceName};

CREATE TABLE IF NOT EXISTS ${tableName} (
  "${columns.id}" BIGINT PRIMARY KEY DEFAULT nextval('${sequenceName}'),
  
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

ALTER SEQUENCE ${sequenceName} OWNED BY ${tableName}."${columns.id}";

-- Ensure custom actions are allowed when table already exists
ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${tableName}_action_check;
ALTER TABLE ${tableName} ALTER COLUMN "${columns.action}" TYPE VARCHAR(255);

CREATE INDEX IF NOT EXISTS ${indexPrefix}_table_record ON ${tableName}("${columns.tableName}", "${columns.recordId}");
CREATE INDEX IF NOT EXISTS ${indexPrefix}_user_id ON ${tableName}("${columns.userId}") WHERE "${columns.userId}" IS NOT NULL;
CREATE INDEX IF NOT EXISTS ${indexPrefix}_created_at ON ${tableName}("${columns.createdAt}" DESC);
CREATE INDEX IF NOT EXISTS ${indexPrefix}_action ON ${tableName}("${columns.action}");
CREATE INDEX IF NOT EXISTS ${indexPrefix}_table_created ON ${tableName}("${columns.tableName}", "${columns.createdAt}" DESC);

COMMENT ON TABLE ${tableName} IS 'Audit trail for all database operations';
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
