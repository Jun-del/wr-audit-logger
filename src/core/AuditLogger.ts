import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDeleteAuditLogs } from "../capture/delete.js";
import { createInsertAuditLogs } from "../capture/insert.js";
import { createUpdateAuditLogs } from "../capture/update.js";
import { BatchQueue } from "../storage/batch-queue.js";
import { DEFAULT_AUDIT_COLUMN_MAP } from "../storage/column-map.js";
import { insertAuditLogs } from "../storage/writer.js";
import type { AuditLog, AuditLogEntry } from "../types/audit.js";
import type {
  AuditConfig,
  AuditContext,
  AuditColumnMap,
  AuditTableName,
  AuditTableRecord,
  BatchWriterStats,
  NormalizedConfig,
} from "../types/config.js";
import { isSafeIdentifier } from "../utils/identifier.js";
import { sanitizeError } from "../utils/logging.js";
import { mergeMetadata } from "../utils/metadata.js";
import { safeSerialize } from "../utils/serializer.js";
import { AuditContextManager } from "./context.js";
import { AuditDeliveryError } from "./errors.js";
import { createInterceptedDb } from "./interceptor.js";

type Db = PostgresJsDatabase<any>;

export type MutationOperation = "insert" | "update" | "delete";

/**
 * An audit log with the context it was recorded in (user ID and metadata already resolved).
 */
interface ResolvedAuditLog {
  log: AuditLog;
  context: AuditContext;
}

/**
 * A transaction opened through the audited db.
 */
interface TransactionScope {
  /** The raw Drizzle transaction; set once Drizzle hands it to the callback */
  tx: unknown;
  transactionId: string;
  parent: TransactionScope | undefined;
  /** Logs for the custom writer, released once the outermost transaction commits */
  afterCommit: ResolvedAuditLog[];
}

/**
 * Main audit logger class
 * Wraps a Drizzle database instance to provide automatic audit logging
 *
 * @example
 * ```typescript
 * const auditLogger = new AuditLogger(db, {
 *   tables: { users: { primaryKey: "id" }, posts: { primaryKey: "id" } },
 *   excludeFields: ['password'],
 *   getUserId: () => getCurrentUser()?.id
 * });
 *
 * const auditedDb = auditLogger.createAuditedDb();
 * await auditedDb.insert(users).values({ ... });
 * ```
 */
export class AuditLogger<TSchema extends Record<string, unknown> = any> {
  private config: NormalizedConfig<TSchema>;
  private contextManager = new AuditContextManager();
  private transactions = new AsyncLocalStorage<TransactionScope>();
  private queue: BatchQueue<ResolvedAuditLog> | null = null;

  /**
   * Creates a new AuditLogger instance
   *
   * @param db - Drizzle database instance to wrap
   * @param config - Audit configuration options
   * @throws {Error} If config validation fails (e.g., invalid batch size)
   *
   * @example
   * ```typescript
   * const logger = new AuditLogger(db, {
   *   tables: { users: { primaryKey: "id" } },
   *   batch: { batchSize: 100, flushInterval: 1000 }
   * });
   * ```
   */
  constructor(
    private db: Db,
    config: AuditConfig<TSchema>,
  ) {
    this.config = this.normalizeConfig(config);
    this.validateConfig(this.config);

    if (this.config.batch) {
      this.queue = new BatchQueue((logs) => this.writeNow(logs), {
        batchSize: this.config.batch.batchSize,
        maxQueueSize: this.config.batch.maxQueueSize,
        flushInterval: this.config.batch.flushInterval,
        logError: this.config.logError,
      });
    }
  }

  /**
   * Validate configuration values
   * @private
   * @throws {Error} If configuration is invalid
   */
  private validateConfig(config: NormalizedConfig<TSchema>): void {
    if (config.batch) {
      if (config.batch.batchSize <= 0) {
        throw new Error("batchSize must be greater than 0");
      }
      if (config.batch.maxQueueSize <= 0) {
        throw new Error("maxQueueSize must be greater than 0");
      }
      if (config.batch.maxQueueSize < config.batch.batchSize) {
        throw new Error("maxQueueSize must be >= batchSize");
      }
      if (config.batch.flushInterval <= 0) {
        throw new Error("flushInterval must be greater than 0");
      }
    }

    if (Object.keys(config.tables).length === 0) {
      throw new Error("tables config cannot be empty.");
    }

    this.validateTablesConfig(config);
    this.validateColumnMap(config.auditColumnMap);
  }

  private validateTablesConfig(config: NormalizedConfig<TSchema>): void {
    for (const [table, tableConfig] of Object.entries(config.tables) as Array<
      [string, { primaryKey: string | string[] }]
    >) {
      if (!tableConfig) {
        throw new Error(`tables.${table} is missing configuration`);
      }
      this.validatePrimaryKeyValue(table, tableConfig.primaryKey);
    }
  }

  private validatePrimaryKeyValue(table: string, key: string | string[]): void {
    if (typeof key === "string") {
      if (!key.trim()) {
        throw new Error(`tables.${table}.primaryKey cannot be empty`);
      }
      return;
    }

    if (Array.isArray(key)) {
      if (key.length === 0 || key.some((value) => !value || !value.trim())) {
        throw new Error(`tables.${table}.primaryKey contains empty field`);
      }
      return;
    }

    throw new Error(`tables.${table}.primaryKey must be string or string[]`);
  }

  private validateColumnMap(map: AuditColumnMap): void {
    const seen = new Set<string>();
    for (const name of Object.values(map)) {
      if (!isSafeIdentifier(name)) {
        throw new Error(`Invalid auditColumnMap identifier: ${name}`);
      }
      if (seen.has(name)) {
        throw new Error(`auditColumnMap has duplicate column name: ${name}`);
      }
      seen.add(name);
    }
  }

  /**
   * Normalize configuration with defaults
   * @private
   */
  private normalizeConfig(config: AuditConfig<TSchema>): NormalizedConfig<TSchema> {
    const batchConfig = config.batch
      ? {
          batchSize: config.batch.batchSize ?? 100,
          maxQueueSize: config.batch.maxQueueSize ?? 10000,
          flushInterval: config.batch.flushInterval ?? 1000,
          waitForWrite: config.batch.waitForWrite ?? false,
        }
      : null;

    return {
      tables: config.tables,
      fields: config.fields || {},
      excludeFields: config.excludeFields || ["password", "token", "secret", "apiKey"],
      auditTable: config.auditTable || "audit_logs",
      // oxlint-disable-next-line unicorn/no-useless-fallback-in-spread
      auditColumnMap: { ...DEFAULT_AUDIT_COLUMN_MAP, ...(config.auditColumnMap || {}) },
      strictMode: config.strictMode ?? false,
      getUserId: config.getUserId || (() => undefined),
      getMetadata: config.getMetadata || (() => ({})),
      logError:
        config.logError ||
        ((message, error) => {
          console.error(message, sanitizeError(error));
        }),
      updateValuesMode: config.updateValuesMode ?? "changed",
      batch: batchConfig,
      customWriter: config.customWriter,
    };
  }

  /**
   * Create a wrapped database instance with automatic audit logging
   *
   * @returns Database instance that automatically logs all INSERT/UPDATE/DELETE operations
   *
   * @example
   * ```typescript
   * const auditedDb = logger.createAuditedDb();
   * await auditedDb.insert(users).values({ email: 'user@example.com' });
   * // Audit log created automatically
   * ```
   */
  createAuditedDb(): Db {
    return createInterceptedDb(this.db, this);
  }

  /**
   * Check if a table should be audited
   * Exposed for use by interceptor
   *
   * @param tableName - Name of the table to check
   * @returns True if the table should be audited
   *
   * @example
   * ```typescript
   * if (logger.shouldAudit('users')) {
   *   // Table is being audited
   * }
   * ```
   */
  shouldAudit(tableName: string): boolean {
    // Never audit the audit table itself
    if (tableName === this.config.auditTable) {
      return false;
    }

    return tableName in this.config.tables;
  }

  /**
   * Check if before state should be captured for UPDATE operations
   * Exposed for use by interceptor
   */
  shouldCaptureBeforeState(): boolean {
    return this.config.updateValuesMode === "changed";
  }

  /**
   * Record an INSERT/UPDATE/DELETE the interceptor just ran.
   * `executor` is the db or transaction that ran it, so the audit write can join that transaction.
   * @internal
   */
  recordMutation(
    operation: MutationOperation,
    tableName: string,
    beforeRecords: Record<string, unknown>[],
    records: Record<string, unknown>[],
    executor: unknown,
  ): Promise<void> {
    return this.audit(() => {
      switch (operation) {
        case "insert":
          return createInsertAuditLogs(tableName, records, this.config);
        case "update":
          return createUpdateAuditLogs(tableName, beforeRecords, records, this.config);
        case "delete":
          return createDeleteAuditLogs(tableName, records, this.config);
      }
    }, executor);
  }

  /**
   * Run a Drizzle transaction so audit writes made inside it join it.
   * `start` must call `bindTx` with the transaction object Drizzle passes to its callback.
   * @internal
   */
  async runTransaction<T>(start: (bindTx: (tx: unknown) => void) => Promise<T>): Promise<T> {
    const parent = this.transactions.getStore();
    const scope: TransactionScope = {
      tx: undefined,
      // Savepoints belong to the outer transaction, so they share its ID
      transactionId: parent?.transactionId ?? randomUUID(),
      parent,
      afterCommit: [],
    };
    const context = { ...this.contextManager.getContext(), transactionId: scope.transactionId };

    const result = await this.contextManager.runWithContext(context, () =>
      this.transactions.run(scope, () =>
        start((tx) => {
          scope.tx = tx;
        }),
      ),
    );

    // Committed (or, when nested, the savepoint was released)
    if (scope.afterCommit.length > 0) {
      if (parent) {
        parent.afterCommit.push(...scope.afterCommit);
      } else {
        try {
          await this.dispatch(scope.afterCommit);
        } catch (error) {
          this.handleError(new AuditDeliveryError(scope.transactionId, error));
        }
      }
    }

    return result;
  }

  /**
   * True if `executor` is a transaction opened through the audited db.
   * @internal
   */
  isTransaction(executor: unknown): boolean {
    return this.findTransaction(executor) !== undefined;
  }

  /**
   * @internal
   */
  logError(message: string, error: unknown): void {
    this.config.logError(message, error);
  }

  /**
   * Manually log an INSERT operation
   *
   * @param tableName - Name of the table
   * @param insertedRecords - Record(s) that were inserted
   *
   * @example
   * ```typescript
   * await logger.logInsert('users', { id: 1, email: 'user@example.com' });
   * ```
   */
  async logInsert<TTable extends AuditTableName<TSchema>>(
    tableName: TTable,
    insertedRecords: AuditTableRecord<TSchema, TTable> | AuditTableRecord<TSchema, TTable>[],
  ): Promise<void> {
    if (!this.shouldAudit(tableName)) return;

    const records = Array.isArray(insertedRecords) ? insertedRecords : [insertedRecords];
    await this.audit(() => createInsertAuditLogs(tableName, records, this.config));
  }

  /**
   * Manually log an UPDATE operation
   *
   * @param tableName - Name of the table
   * @param beforeRecords - Record(s) before the update
   * @param afterRecords - Record(s) after the update
   *
   * @example
   * ```typescript
   * await logger.logUpdate('users',
   *   { id: 1, name: 'Old' },
   *   { id: 1, name: 'New' }
   * );
   * ```
   */
  async logUpdate<TTable extends AuditTableName<TSchema>>(
    tableName: TTable,
    beforeRecords: AuditTableRecord<TSchema, TTable> | AuditTableRecord<TSchema, TTable>[],
    afterRecords: AuditTableRecord<TSchema, TTable> | AuditTableRecord<TSchema, TTable>[],
  ): Promise<void> {
    if (!this.shouldAudit(tableName)) return;

    const before = Array.isArray(beforeRecords) ? beforeRecords : [beforeRecords];
    const after = Array.isArray(afterRecords) ? afterRecords : [afterRecords];
    await this.audit(() => createUpdateAuditLogs(tableName, before, after, this.config));
  }

  /**
   * Manually log a DELETE operation
   *
   * @param tableName - Name of the table
   * @param deletedRecords - Record(s) that were deleted
   *
   * @example
   * ```typescript
   * await logger.logDelete('users', { id: 1, email: 'deleted@example.com' });
   * ```
   */
  async logDelete<TTable extends AuditTableName<TSchema>>(
    tableName: TTable,
    deletedRecords: AuditTableRecord<TSchema, TTable> | AuditTableRecord<TSchema, TTable>[],
  ): Promise<void> {
    if (!this.shouldAudit(tableName)) return;

    const records = Array.isArray(deletedRecords) ? deletedRecords : [deletedRecords];
    await this.audit(() => createDeleteAuditLogs(tableName, records, this.config));
  }

  /**
   * Build and write audit logs. Any failure, including building the logs, follows `strictMode`:
   * thrown in strict mode, otherwise passed to `logError` so the caller's operation still succeeds.
   */
  private async audit(build: () => AuditLog[], executor?: unknown): Promise<void> {
    try {
      const logs = build();
      if (logs.length === 0) return;

      const resolved = await this.resolveLogs(logs);
      const scope = this.findTransaction(executor);
      if (scope) {
        await this.writeInTransaction(resolved, scope);
      } else {
        await this.dispatch(resolved);
      }
    } catch (error) {
      this.handleError(error);
    }
  }

  private handleError(error: unknown): void {
    if (this.config.strictMode) {
      throw error;
    }
    this.config.logError("[AUDIT] Failed to write audit logs:", error);
  }

  /**
   * Attach the current context: an explicit `userId` from `setContext`/`withContext` wins over
   * `getUserId()`, and metadata merges `getMetadata()`, context metadata, then per-log metadata.
   */
  private async resolveLogs(logs: AuditLog[]): Promise<ResolvedAuditLog[]> {
    const current = this.contextManager.getContext();
    const userId = current?.userId || (await this.config.getUserId()) || undefined;
    const metadata = mergeMetadata(await this.config.getMetadata(), current?.metadata) ?? undefined;
    const context: AuditContext = { ...current, userId, metadata };

    return logs.map((log) => ({
      log: { ...log, metadata: mergeMetadata(metadata, log.metadata) ?? undefined },
      context,
    }));
  }

  private findTransaction(executor?: unknown): TransactionScope | undefined {
    let scope = this.transactions.getStore();
    if (executor === undefined) return scope;
    // A statement run on the root db inside a transaction callback is not part of it
    while (scope && scope.tx !== executor) {
      scope = scope.parent;
    }
    return scope;
  }

  private async writeInTransaction(
    logs: ResolvedAuditLog[],
    scope: TransactionScope,
  ): Promise<void> {
    if (this.config.customWriter) {
      // A custom writer can't join the transaction; hold its logs until the transaction commits
      scope.afterCommit.push(...logs);
      return;
    }

    const tx = scope.tx as Db;
    if (this.config.strictMode) {
      await this.writeNow(logs, tx);
      return;
    }
    // A failed statement aborts the whole Postgres transaction, so isolate the write in a savepoint
    await tx.transaction((savepoint) => this.writeNow(logs, savepoint as unknown as Db));
  }

  /**
   * Write outside of a transaction: through the batch queue if enabled, otherwise immediately.
   */
  private async dispatch(logs: ResolvedAuditLog[]): Promise<void> {
    if (!this.queue) {
      await this.writeNow(logs);
      return;
    }

    const waitForWrite = this.config.batch?.waitForWrite || this.config.strictMode;
    const written = this.queue.enqueue(logs, waitForWrite);
    if (waitForWrite) {
      await written;
    } else {
      written.catch((error) => {
        this.config.logError("[AUDIT] Failed to write audit logs:", error);
      });
    }
  }

  /**
   * Hand logs to the custom writer, or insert them into the audit table.
   */
  private async writeNow(logs: ResolvedAuditLog[], db: Db = this.db): Promise<void> {
    const { customWriter } = this.config;
    if (customWriter) {
      for (const group of groupByContext(logs)) {
        await customWriter(group.logs, group.context);
      }
      return;
    }

    const entries: AuditLogEntry[] = logs.map(({ log, context }) => ({
      ...log,
      userId: context.userId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      transactionId: context.transactionId,
    }));
    await insertAuditLogs(db, this.config.auditTable, this.config.auditColumnMap, entries);
  }

  /**
   * Set audit context for current async scope
   *
   * @param context - Partial context to merge with existing context
   *
   * @example
   * ```typescript
   * logger.setContext({
   *   userId: 'user-123',
   *   ipAddress: req.ip,
   *   userAgent: req.headers['user-agent']
   * });
   * ```
   */
  setContext(context: Partial<AuditContext>): void {
    this.contextManager.mergeContext(context);
  }

  /**
   * Run a function with specific audit context
   *
   * @param context - Context to use for the operation
   * @param fn - Function to execute with the context
   * @returns Result of the function
   *
   * @example
   * ```typescript
   * await logger.withContext(
   *   { userId: 'admin', metadata: { reason: 'bulk_import' } },
   *   async () => {
   *     await db.insert(users).values([...]);
   *   }
   * );
   * ```
   */
  withContext<T>(context: AuditContext, fn: () => T): T {
    return this.contextManager.runWithContext(context, fn);
  }

  /**
   * Get current audit context
   *
   * @returns Current audit context or undefined if not set
   *
   * @example
   * ```typescript
   * const context = logger.getContext();
   * console.log('Current user:', context?.userId);
   * ```
   */
  getContext(): AuditContext | undefined {
    return this.contextManager.getContext();
  }

  /**
   * Generic manual logging for any operation (READ, custom actions, etc.)
   *
   * @param entry - Audit log entry details
   * @param entry.action - Action type (e.g., 'READ', 'EXPORT')
   * @param entry.tableName - Table name
   * @param entry.recordId - Record identifier
   * @param entry.values - Optional values payload
   * @param entry.metadata - Optional metadata
   *
   * @example
   * ```typescript
   * // Log a READ operation
   * await logger.log({
   *   action: 'READ',
   *   tableName: 'sensitive_documents',
   *   recordId: documentId,
   *   values: { accessedFields: ['ssn', 'salary'] },
   *   metadata: { reason: 'compliance_audit' }
   * });
   *
   * // Log a custom action
   * await logger.log({
   *   action: 'EXPORT',
   *   tableName: 'customer_data',
   *   recordId: customerId,
   *   metadata: { format: 'CSV', rowCount: 1500 }
   * });
   * ```
   */
  async log<TTable extends AuditTableName<TSchema>>(entry: {
    action: string;
    tableName: TTable;
    recordId: string;
    values?: AuditTableRecord<TSchema, TTable>;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.shouldAudit(entry.tableName)) return;

    await this.audit(() => [
      {
        action: entry.action,
        tableName: entry.tableName,
        recordId: entry.recordId,
        values: entry.values,
        metadata: entry.metadata,
      },
    ]);
  }

  /**
   * Manually flush pending batch logs (only works with batch mode)
   *
   * @returns Promise that resolves when flush is complete
   *
   * @example
   * ```typescript
   * // Insert many records
   * for (const record of records) {
   *   await db.insert(users).values(record);
   * }
   *
   * // Ensure all logs are written before continuing
   * await logger.flush();
   * ```
   */
  async flush(): Promise<void> {
    await this.queue?.flush();
  }

  /**
   * Gracefully shutdown the audit logger
   * Flushes all pending logs before shutting down
   *
   * @returns Promise that resolves when shutdown is complete
   *
   * @example
   * ```typescript
   * // On application shutdown
   * process.on('SIGTERM', async () => {
   *   await logger.shutdown();
   *   process.exit(0);
   * });
   * ```
   */
  async shutdown(): Promise<void> {
    await this.queue?.shutdown();
  }

  /**
   * Get batch writer stats (only available in batch mode)
   *
   * @returns Writer statistics or undefined if not in batch mode
   *
   * @example
   * ```typescript
   * const stats = logger.getStats();
   * if (stats) {
   *   console.log('Queue size:', stats.queueSize);
   *   console.log('Is writing:', stats.isWriting);
   * }
   * ```
   */
  getStats(): BatchWriterStats | undefined {
    return this.queue?.getStats();
  }
}

/**
 * Group logs that share a context so each custom writer call gets one accurate context.
 */
function groupByContext(
  logs: ResolvedAuditLog[],
): Array<{ context: AuditContext; logs: AuditLog[] }> {
  const groups = new Map<string, { context: AuditContext; logs: AuditLog[] }>();
  for (const { log, context } of logs) {
    const key = contextKey(context);
    const group = groups.get(key);
    if (group) {
      group.logs.push(log);
    } else {
      groups.set(key, { context, logs: [log] });
    }
  }
  return [...groups.values()];
}

function contextKey(context: AuditContext): string {
  try {
    return JSON.stringify(
      safeSerialize([
        context.userId,
        context.ipAddress,
        context.userAgent,
        context.transactionId,
        context.metadata,
      ]),
    );
  } catch {
    // Unserializable metadata: keep the log in a group of its own
    return randomUUID();
  }
}
