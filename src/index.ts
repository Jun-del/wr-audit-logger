import type { AuditConfig, AuditContext } from "./types/config.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { AuditLogger } from "./core/AuditLogger.js";

// Re-export types
export type { AuditConfig, AuditContext } from "./types/config.js";
export type { AuditAction, AuditLog, AuditLogEntry, StoredAuditLog } from "./types/audit.js";

// Re-export schema and migration
export { auditLogs, createAuditTableSQL } from "./storage/schema.js";

/**
 * Create an audit logger instance
 *
 * @example
 * ```typescript
 * const auditLogger = createAuditLogger(db, {
 *   tables: ['users', 'vehicles'],
 *   getUserId: () => getCurrentUser()?.id,
 * });
 *
 * // Set context (e.g., in Express middleware)
 * auditLogger.setContext({
 *   userId: req.user.id,
 *   ipAddress: req.ip,
 * });
 *
 * // Perform operations
 * const user = await db.insert(users).values(data).returning();
 *
 * // Manually log (for MVP)
 * await auditLogger.logInsert('users', user);
 * ```
 */
export function createAuditLogger(db: PostgresJsDatabase<any>, config: AuditConfig) {
  const logger = new AuditLogger(db, config);

  return {
    /**
     * The original database instance
     * Use this for all database operations
     */
    db,

    /**
     * Manually log an INSERT operation
     */
    logInsert: logger.logInsert.bind(logger),

    /**
     * Manually log an UPDATE operation
     */
    logUpdate: logger.logUpdate.bind(logger),

    /**
     * Manually log a DELETE operation
     */
    logDelete: logger.logDelete.bind(logger),

    /**
     * Set audit context for current async scope
     */
    setContext: logger.setContext.bind(logger),

    /**
     * Run a function with specific audit context
     */
    withContext: logger.withContext.bind(logger),

    /**
     * Get current audit context
     */
    getContext: logger.getContext.bind(logger),
  };
}

/**
 * Default export
 */
export default createAuditLogger;
