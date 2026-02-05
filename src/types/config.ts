import type { Table } from "drizzle-orm";

type TableName<TTable> = TTable extends { _: { name: infer N } } ? N : never;
type TableColumns<TTable> = TTable extends { _: { columns: infer C } }
  ? C extends Record<string, unknown>
    ? C
    : never
  : never;
type TableSelect<TTable> = TTable extends { _: { inferSelect: infer S } } ? S : never;

type SchemaTable<TSchema, TName extends string> = {
  [K in keyof TSchema]: TSchema[K] extends Table
    ? TableName<TSchema[K]> extends TName
      ? TSchema[K]
      : never
    : never;
}[keyof TSchema];

export type AuditTableName<TSchema extends Record<string, unknown>> = {
  [K in keyof TSchema]: TSchema[K] extends Table ? TableName<TSchema[K]> : never;
}[keyof TSchema] &
  string;

export type AuditTableRecord<
  TSchema extends Record<string, unknown>,
  TName extends AuditTableName<TSchema>,
> = Partial<TableSelect<SchemaTable<TSchema, TName>>>;

export type AuditFieldConfig<TSchema extends Record<string, unknown>> = {
  [K in AuditTableName<TSchema>]?: Array<keyof TableColumns<SchemaTable<TSchema, K>> & string>;
};

export type AuditColumnKey =
  | "id"
  | "userId"
  | "ipAddress"
  | "userAgent"
  | "action"
  | "tableName"
  | "recordId"
  | "values"
  | "createdAt"
  | "metadata"
  | "transactionId"
  | "deletedAt";

export type AuditColumnMap = Record<AuditColumnKey, string>;

/**
 * Configuration options for the audit logger
 */
export interface AuditConfig<TSchema extends Record<string, unknown> = Record<string, any>> {
  /**
   * Tables to audit. Use '*' to audit all tables.
   * @example ['users', 'vehicles', 'transactions']
   * @example '*'
   */
  tables: AuditTableName<TSchema>[] | "*";

  /**
   * Specific fields to track per table.
   * If not specified, all fields are tracked.
   * @example { users: ['id', 'email', 'role'], vehicles: ['id', 'make', 'model'] }
   */
  fields?: AuditFieldConfig<TSchema>;

  /**
   * Fields to exclude from audit logs globally (e.g., passwords, tokens)
   * @default ['password', 'token', 'secret', 'apiKey']
   */
  excludeFields?: string[];

  /**
   * Name of the audit log table
   * @default 'audit_logs'
   */
  auditTable?: string;

  /**
   * Map logical audit fields to custom column names
   * @example { userId: "actor_id", tableName: "resource", createdAt: "created_on" }
   */
  auditColumnMap?: Partial<AuditColumnMap>;

  /**
   * If true, operations fail if audit logging fails.
   * If false, errors are logged but operations proceed.
   * @default false
   */
  strictMode?: boolean;

  /**
   * Function to get the current user ID
   * Can be async to support async context retrieval
   */
  getUserId?: () => string | undefined | Promise<string | undefined>;

  /**
   * Function to get additional metadata for audit logs
   */
  getMetadata?: () => Record<string, unknown> | Promise<Record<string, unknown>>;

  /**
   * How UPDATE values are stored
   * - "changed": store only changed fields (requires SELECT before UPDATE)
   * - "full": store full row after UPDATE (no extra SELECT)
   * @default "changed"
   */
  updateValuesMode?: "changed" | "full";

  /**
   * Batch configuration for async writes
   * When enabled, audit logs are queued and written in batches
   * @default undefined (disabled - writes immediately)
   */
  batch?: BatchConfig;

  /**
   * Custom writer function for audit logs
   * Allows complete control over how audit logs are stored
   * If provided, the default audit_logs table is not used
   *
   * @example
   * // Custom table with company_id
   * customWriter: async (logs, context) => {
   *   await db.insert(myCustomAuditTable).values(
   *     logs.map(log => ({
   *       company_id: getCurrentCompany(),
   *       user_id: context?.userId,
   *       action: log.action,
   *       table_name: log.tableName,
   *       // ... map your custom fields
   *     }))
   *   );
   * }
   */
  customWriter?: (
    logs: Array<{
      action: string;
      tableName: AuditTableName<TSchema>;
      recordId: string;
      values?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }>,
    context: AuditContext | undefined,
  ) => Promise<void> | void;
}

/**
 * Configuration for batched audit log writes
 */
export interface BatchConfig {
  /**
   * Maximum number of logs to batch before automatic flush
   * @default 100
   * @minimum 1
   */
  batchSize?: number;

  /**
   * Interval in milliseconds to automatically flush pending logs
   * @default 1000 (1 second)
   * @minimum 1
   */
  flushInterval?: number;

  /**
   * If true, waits for batches to be written before returning
   * If false, queues logs asynchronously (fire-and-forget)
   * @default false (async mode)
   * @note This is independent of strictMode - you can have async batching
   *       with strict error handling by setting both to true
   */
  waitForWrite?: boolean;
}

/**
 * Context information for audit logs
 */
export interface AuditContext {
  /**
   * ID of the user performing the operation
   */
  userId?: string;

  /**
   * IP address of the request
   */
  ipAddress?: string;

  /**
   * User agent string
   */
  userAgent?: string;

  /**
   * Additional metadata (request ID, session ID, etc.)
   */
  metadata?: Record<string, unknown>;

  /**
   * Transaction ID to group related operations
   */
  transactionId?: string;
}

/**
 * Statistics from batch writer
 * Useful for monitoring queue health and performance
 */
export interface BatchWriterStats {
  /**
   * Number of audit logs currently queued
   */
  queueSize: number;

  /**
   * Whether a write operation is currently in progress
   */
  isWriting: boolean;

  /**
   * Whether the writer is shutting down
   */
  isShuttingDown: boolean;
}

/**
 * Normalized configuration with all defaults applied
 */
export type NormalizedConfig<TSchema extends Record<string, unknown> = Record<string, any>> =
  Required<Omit<AuditConfig<TSchema>, "getUserId" | "getMetadata" | "customWriter" | "batch">> & {
    getUserId: () => string | undefined | Promise<string | undefined>;
    getMetadata: () => Record<string, unknown> | Promise<Record<string, unknown>>;
    updateValuesMode: "changed" | "full";
    batch: Required<BatchConfig> | null;
    auditColumnMap: AuditColumnMap;
    customWriter?: (logs: any[], context: AuditContext | undefined) => Promise<void> | void;
  };
