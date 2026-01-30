/**
 * Configuration options for the audit logger
 */
export interface AuditConfig {
  /**
   * Tables to audit. Use '*' to audit all tables.
   * @example ['users', 'vehicles', 'transactions']
   * @example '*'
   */
  tables: string[] | "*";

  /**
   * Specific fields to track per table.
   * If not specified, all fields are tracked.
   * @example { users: ['id', 'email', 'role'], vehicles: ['id', 'make', 'model'] }
   */
  fields?: Record<string, string[]>;

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
   * Whether to capture "before" values for UPDATE operations
   * Disabling this skips the additional SELECT query before updates
   * @default false
   */
  captureOldValues?: boolean;

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
      tableName: string;
      recordId: string;
      oldValues?: Record<string, unknown>;
      newValues?: Record<string, unknown>;
      changedFields?: string[];
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
   */
  batchSize?: number;

  /**
   * Interval in milliseconds to automatically flush pending logs
   * @default 1000 (1 second)
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
 * Normalized configuration with all defaults applied
 */
export type NormalizedConfig = Required<
  Omit<AuditConfig, "getUserId" | "getMetadata" | "customWriter" | "batch">
> & {
  getUserId: () => string | undefined | Promise<string | undefined>;
  getMetadata: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  captureOldValues: boolean;
  batch: Required<BatchConfig> | null;
  customWriter?: (logs: any[], context: AuditContext | undefined) => Promise<void> | void;
};
