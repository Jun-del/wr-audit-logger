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
export type NormalizedConfig = Required<Omit<AuditConfig, "getUserId" | "getMetadata">> & {
  getUserId: () => string | undefined | Promise<string | undefined>;
  getMetadata: () => Record<string, unknown> | Promise<Record<string, unknown>>;
};
