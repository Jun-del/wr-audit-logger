import { bigserial, index, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * Audit logs table schema
 * Stores all database operation audit trails
 */
// TODO: Flexible structure, defined by the user given schema if provided, else default?
export const auditLogs = pgTable(
  "audit_logs",
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
    oldValues: jsonb("old_values"),
    newValues: jsonb("new_values"),
    changedFields: text("changed_fields").array(),

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
 * SQL migration to create the audit_logs table
 * Run this to set up the database
 */
export const createAuditTableSQL = `
-- Prevent concurrent test runs from racing on schema creation
SELECT pg_advisory_xact_lock(913742, 540129);

CREATE SEQUENCE IF NOT EXISTS audit_logs_id_seq;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT PRIMARY KEY DEFAULT nextval('audit_logs_id_seq'),
  
  user_id VARCHAR(255),
  ip_address VARCHAR(45),
  user_agent TEXT,
  
  action VARCHAR(255) NOT NULL,
  table_name VARCHAR(255) NOT NULL,
  record_id VARCHAR(255) NOT NULL,
  
  old_values JSONB,
  new_values JSONB,
  changed_fields TEXT[],
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  metadata JSONB,
  transaction_id VARCHAR(255),
  
  deleted_at TIMESTAMPTZ
);

ALTER SEQUENCE audit_logs_id_seq OWNED BY audit_logs.id;

-- Ensure custom actions are allowed when table already exists
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_action_check;
ALTER TABLE audit_logs ALTER COLUMN action TYPE VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_audit_logs_table_record ON audit_logs(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_table_created ON audit_logs(table_name, created_at DESC);

COMMENT ON TABLE audit_logs IS 'Audit trail for all database operations';
`;
