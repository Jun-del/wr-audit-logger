import type { AuditConfig, AuditContext } from "./types/config.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { AuditLogger } from "./core/AuditLogger.js";

// Re-export types
export type { AuditConfig, AuditContext } from "./types/config.js";
export type { AuditAction, AuditLog, AuditLogEntry, StoredAuditLog } from "./types/audit.js";

// Re-export schema and migration
export { auditLogs, createAuditTableSQL } from "./storage/schema.js";

// Re-export utilities
export { initializeAuditLogging, checkAuditSetup, getAuditStats } from "./utils/migration.js";

/**
 * Create an audit logger instance with automatic interception
 *
 * @example
 * ```typescript
 * const { db } = createAuditLogger(originalDb, {
 *   tables: ['users', 'vehicles'],
 *   getUserId: () => getCurrentUser()?.id,
 * });
 *
 * // Set context (e.g., in Express middleware)
 * app.use((req, res, next) => {
 *   auditLogger.setContext({
 *     userId: req.user.id,
 *     ipAddress: req.ip,
 *   });
 *   next();
 * });
 *
 * // Operations are automatically audited!
 * const user = await db.insert(users).values(data).returning();
 * // ✓ Audit log created automatically
 *
 * const updated = await db.update(users)
 *   .set({ name: 'New Name' })
 *   .where(eq(users.id, userId))
 *   .returning();
 * // ✓ Audit log created with before/after values
 * ```
 */
export function createAuditLogger(db: PostgresJsDatabase<any>, config: AuditConfig) {
  const logger = new AuditLogger(db, config);

  return {
    /**
     * The wrapped database instance with automatic audit logging
     * Use this instead of your original db instance
     */
    db: logger.createAuditedDb(),

    /**
     * Manually log an INSERT operation (for edge cases)
     */
    logInsert: logger.logInsert.bind(logger),

    /**
     * Manually log an UPDATE operation (for edge cases)
     */
    logUpdate: logger.logUpdate.bind(logger),

    /**
     * Manually log a DELETE operation (for edge cases)
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

    /**
     * Generic manual logging for any operation (READ, custom actions, etc.)
     *
     * @example
     * await auditLogger.log({
     *   action: 'READ',
     *   tableName: 'sensitive_documents',
     *   recordId: doc.id,
     *   newValues: { accessed: true },
     *   metadata: { reason: 'user_request' }
     * });
     */
    log: logger.log.bind(logger),

    /**
     * Manually flush pending batch logs (only works with batch mode)
     */
    flush: logger.flush.bind(logger),

    /**
     * Gracefully shutdown the audit logger
     * Flushes all pending logs before shutting down
     */
    shutdown: logger.shutdown.bind(logger),

    /**
     * Get batch writer stats (only available in batch mode)
     */
    getStats: logger.getStats.bind(logger),
  };
}

/**
 * Default export
 */
export default createAuditLogger;
