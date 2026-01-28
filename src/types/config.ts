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
   * Whether to capture "before" values for DELETE operations
   * Disabling this skips the additional SELECT query before deletes
   * @default false
   */
  captureDeletedValues?: boolean;

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
  Omit<AuditConfig, "getUserId" | "getMetadata" | "customWriter">
> & {
  getUserId: () => string | undefined | Promise<string | undefined>;
  getMetadata: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  captureOldValues: boolean;
  captureDeletedValues: boolean;
  customWriter?: (logs: any[], context: AuditContext | undefined) => Promise<void> | void;
};
