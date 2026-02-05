import type { AuditLogEntry } from "../types/audit.js";
import type { AuditColumnMap } from "../types/config.js";
import { safeSerialize } from "../utils/serializer.js";

export type AuditInsertColumn = {
  name: string;
  type: string;
  getValue: (entry: AuditLogEntry) => unknown;
};

export const DEFAULT_AUDIT_COLUMN_MAP: AuditColumnMap = {
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

export function getAuditInsertColumns(map?: Partial<AuditColumnMap>): AuditInsertColumn[] {
  // oxlint-disable-next-line unicorn/no-useless-fallback-in-spread
  const merged = { ...DEFAULT_AUDIT_COLUMN_MAP, ...(map || {}) };
  return [
    {
      name: merged.userId,
      type: "VARCHAR",
      getValue: (entry) => entry.userId || null,
    },
    {
      name: merged.ipAddress,
      type: "VARCHAR",
      getValue: (entry) => entry.ipAddress || null,
    },
    {
      name: merged.userAgent,
      type: "TEXT",
      getValue: (entry) => entry.userAgent || null,
    },
    {
      name: merged.action,
      type: "VARCHAR",
      getValue: (entry) => entry.action,
    },
    {
      name: merged.tableName,
      type: "VARCHAR",
      getValue: (entry) => entry.tableName,
    },
    {
      name: merged.recordId,
      type: "VARCHAR",
      getValue: (entry) => entry.recordId,
    },
    {
      name: merged.values,
      type: "JSONB",
      getValue: (entry) => (entry.values ? safeSerialize(entry.values) : null),
    },
    {
      name: merged.metadata,
      type: "JSONB",
      getValue: (entry) => (entry.metadata ? safeSerialize(entry.metadata) : null),
    },
    {
      name: merged.transactionId,
      type: "VARCHAR",
      getValue: (entry) => entry.transactionId || null,
    },
  ];
}
