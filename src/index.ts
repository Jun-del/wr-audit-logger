import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { AuditLogger } from "./core/AuditLogger.js";
import type {
  AuditConfig,
  AuditContext,
  AuditTableName,
  AuditTableRecord,
  DbSchema,
} from "./types/config.js";

// Re-export types
export type {
  AuditConfig,
  AuditContext,
  AuditColumnMap,
  AuditColumnKey,
  BatchWriterStats,
  DbSchema,
} from "./types/config.js";
export type { AuditAction, AuditLog, AuditLogEntry, StoredAuditLog } from "./types/audit.js";
export type { BatchAuditWriterStats } from "./storage/batch-writer.js";
export type { BatchedCustomWriterStats } from "./storage/batched-custom-writer.js";

// Re-export schema and migration
export {
  auditLogs,
  createAuditTableSQL,
  createAuditTableSQLFor,
  createAuditLogsTable,
} from "./storage/schema.js";

// Re-export utilities
export { initializeAuditLogging, checkAuditSetup, getAuditStats } from "./utils/migration.js";

/**
 * Create an audit logger instance with automatic interception
 *
 * @param db - Original Drizzle database instance
 * @param config - Audit configuration options
 * @returns Object with wrapped database and audit logger methods
 *
 * @example
 * ```typescript
 * const { db } = createAuditLogger(originalDb, {
 *   tables: { users: { primaryKey: "id" }, vehicles: { primaryKey: "id" } },
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
export function createAuditLogger<TDb extends PostgresJsDatabase<any>>(
  db: TDb,
  config: AuditConfig<DbSchema<TDb>>,
) {
  const logger = new AuditLogger<DbSchema<TDb>>(db, config);

  return {
    /**
     * The wrapped database instance with automatic audit logging
     * Use this instead of your original db instance
     */
    db: logger.createAuditedDb() as TDb,

    /**
     * Manually log an INSERT operation (for edge cases)
     *
     * @param tableName - Table name
     * @param records - Inserted record(s)
     *
     * @example
     * ```typescript
     * await auditLogger.logInsert('users', { id: 1, email: 'user@example.com' });
     * ```
     */
    logInsert: <TTable extends AuditTableName<DbSchema<TDb>>>(
      tableName: TTable,
      insertedRecords:
        | AuditTableRecord<DbSchema<TDb>, TTable>
        | AuditTableRecord<DbSchema<TDb>, TTable>[],
    ) => logger.logInsert(tableName, insertedRecords),

    /**
     * Manually log an UPDATE operation (for edge cases)
     *
     * @param tableName - Table name
     * @param beforeRecords - Records before update
     * @param afterRecords - Records after update
     *
     * @example
     * ```typescript
     * await auditLogger.logUpdate('users', oldUser, newUser);
     * ```
     */
    logUpdate: <TTable extends AuditTableName<DbSchema<TDb>>>(
      tableName: TTable,
      beforeRecords:
        | AuditTableRecord<DbSchema<TDb>, TTable>
        | AuditTableRecord<DbSchema<TDb>, TTable>[],
      afterRecords:
        | AuditTableRecord<DbSchema<TDb>, TTable>
        | AuditTableRecord<DbSchema<TDb>, TTable>[],
    ) => logger.logUpdate(tableName, beforeRecords, afterRecords),

    /**
     * Manually log a DELETE operation (for edge cases)
     *
     * @param tableName - Table name
     * @param records - Deleted record(s)
     *
     * @example
     * ```typescript
     * await auditLogger.logDelete('users', deletedUser);
     * ```
     */
    logDelete: <TTable extends AuditTableName<DbSchema<TDb>>>(
      tableName: TTable,
      deletedRecords:
        | AuditTableRecord<DbSchema<TDb>, TTable>
        | AuditTableRecord<DbSchema<TDb>, TTable>[],
    ) => logger.logDelete(tableName, deletedRecords),

    /**
     * Set audit context for current async scope
     *
     * @param context - Partial context to merge
     *
     * @example
     * ```typescript
     * auditLogger.setContext({
     *   userId: 'user-123',
     *   ipAddress: req.ip
     * });
     * ```
     */
    setContext: logger.setContext.bind(logger),

    /**
     * Run a function with specific audit context
     *
     * @param context - Context for the operation
     * @param fn - Function to execute
     *
     * @example
     * ```typescript
     * await auditLogger.withContext(
     *   { userId: 'admin', metadata: { reason: 'bulk_import' } },
     *   async () => {
     *     await db.insert(users).values([...]);
     *   }
     * );
     * ```
     */
    withContext: logger.withContext.bind(logger),

    /**
     * Get current audit context
     *
     * @returns Current context or undefined
     *
     * @example
     * ```typescript
     * const context = auditLogger.getContext();
     * console.log('User:', context?.userId);
     * ```
     */
    getContext: logger.getContext.bind(logger),

    /**
     * Generic manual logging for any operation (READ, custom actions, etc.)
     *
     * @param entry - Log entry details
     *
     * @example
     * ```typescript
     * await auditLogger.log({
     *   action: 'READ',
     *   tableName: 'sensitive_documents',
     *   recordId: doc.id,
     *   values: { accessed: true },
     *   metadata: { reason: 'user_request' }
     * });
     * ```
     */
    log: <TTable extends AuditTableName<DbSchema<TDb>>>(entry: {
      action: string;
      tableName: TTable;
      recordId: string;
      values?: AuditTableRecord<DbSchema<TDb>, TTable>;
      metadata?: Record<string, unknown>;
    }) => logger.log(entry),

    /**
     * Manually flush pending batch logs (only works with batch mode)
     *
     * @returns Promise that resolves when flush completes
     *
     * @example
     * ```typescript
     * await auditLogger.flush();
     * ```
     */
    flush: logger.flush.bind(logger),

    /**
     * Gracefully shutdown the audit logger
     * Flushes all pending logs before shutting down
     *
     * @returns Promise that resolves when shutdown completes
     *
     * @example
     * ```typescript
     * process.on('SIGTERM', async () => {
     *   await auditLogger.shutdown();
     *   process.exit(0);
     * });
     * ```
     */
    shutdown: logger.shutdown.bind(logger),

    /**
     * Get batch writer stats (only available in batch mode)
     *
     * @returns Writer statistics or undefined if not in batch mode
     *
     * @example
     * ```typescript
     * const stats = auditLogger.getStats();
     * if (stats) {
     *   console.log('Queue size:', stats.queueSize);
     * }
     * ```
     */
    getStats: logger.getStats.bind(logger),
  };
}

/**
 * Default export
 */
export default createAuditLogger;
