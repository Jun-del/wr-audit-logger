import { getTableName, isTable } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { AuditLogger } from "./AuditLogger.js";

// Enable debug logging via environment variable
const DEBUG = process.env.AUDIT_DEBUG === "true";
function debug(...args: unknown[]) {
  if (DEBUG) {
    console.log("[AUDIT DEBUG]", ...args);
  }
}

type QueryBuilderLike = Record<string, unknown> & {
  table?: unknown;
  config?: {
    table?: unknown;
    where?: unknown;
  };
  _?: {
    table?: unknown;
    where?: unknown;
    name?: string;
    config?: { name?: string };
  };
  name?: string;
  toSQL?: () => { sql?: string };
  returning?: (...args: unknown[]) => QueryBuilderLike;
  then?: (...args: unknown[]) => unknown;
  catch?: (...args: unknown[]) => unknown;
  finally?: (...args: unknown[]) => unknown;
};

type QueryMethod = (...args: unknown[]) => QueryBuilderLike;

/**
 * Extract table name from Drizzle query builder
 */
function resolveTableName(table: unknown): string | null {
  if (!table || (typeof table !== "object" && typeof table !== "function")) {
    return null;
  }

  if (isTable(table)) {
    return getTableName(table);
  }

  const metaName =
    (table as QueryBuilderLike)?._?.name ??
    (table as QueryBuilderLike)?._?.config?.name ??
    (table as QueryBuilderLike)?.name;
  if (typeof metaName === "string" && metaName.length > 0) {
    return metaName;
  }

  return null;
}

function extractTableName(queryBuilder: QueryBuilderLike, tableRef?: unknown): string | null {
  try {
    const directRef = resolveTableName(tableRef);
    if (directRef) {
      return directRef;
    }

    // Try to get table from different query builder types
    const directTable = resolveTableName(queryBuilder.table);
    if (directTable) {
      return directTable;
    }

    const configTable = resolveTableName(queryBuilder.config?.table);
    if (configTable) {
      return configTable;
    }

    // For insert/update/delete builders
    const internalTable = resolveTableName(queryBuilder._?.table);
    if (internalTable) {
      return internalTable;
    }

    // Try to extract from SQL query (last resort)
    const sqlQuery = queryBuilder.toSQL?.();
    if (sqlQuery?.sql) {
      const match = sqlQuery.sql.match(/(?:from|into|update)\s+(?:"?(\w+)"?\.)?"?(\w+)"?/i);
      if (match) {
        const tableName = match[2] ?? match[1] ?? null;
        if (tableName) {
          debug("Extracted table name from SQL:", tableName);
        }
        return tableName;
      }
      debug("Failed SQL table extraction", sqlQuery.sql.slice(0, 160));
    }
  } catch (error) {
    debug("Table name extraction error", error);
  }

  return null;
}

/**
 * Extract WHERE clause conditions to query "before" state
 */
function extractWhereClause(queryBuilder: QueryBuilderLike): unknown {
  try {
    // Get the WHERE condition from query builder
    if (queryBuilder.config?.where) {
      return queryBuilder.config.where;
    }

    if (queryBuilder._ && queryBuilder._.where) {
      return queryBuilder._.where;
    }
  } catch {
    // Ignore extraction errors
  }

  return null;
}

/**
 * Create a proxied database instance that intercepts operations
 */
export function createInterceptedDb<TSchema extends Record<string, unknown>>(
  db: PostgresJsDatabase<TSchema>,
  auditLogger: AuditLogger<TSchema>,
): PostgresJsDatabase<TSchema> {
  return new Proxy(db, {
    get(target, prop) {
      const original = target[prop as keyof typeof target];

      // Intercept insert/update/delete methods
      if (prop === "insert" || prop === "update" || prop === "delete") {
        return createQueryBuilderProxy(prop, original as QueryMethod, target, auditLogger);
      }

      // Intercept transaction method to maintain context
      if (prop === "transaction") {
        return createTransactionProxy(original as unknown, target, auditLogger);
      }

      return original;
    },
  }) as PostgresJsDatabase<TSchema>;
}

/**
 * Create a proxy for insert/update/delete query builders
 */
function createQueryBuilderProxy(
  operation: string,
  originalMethod: QueryMethod,
  db: PostgresJsDatabase<any>,
  auditLogger: AuditLogger,
) {
  return function (...args: unknown[]) {
    // Call original method to get the query builder
    const queryBuilder = originalMethod.apply(db, args);
    const tableRef = args[0];

    // Wrap the query builder to intercept execution
    return createExecutionProxy(operation, queryBuilder, db, auditLogger, tableRef);
  };
}

/**
 * Create a proxy that intercepts the execution of queries
 */
function createExecutionProxy(
  operation: string,
  queryBuilder: QueryBuilderLike,
  db: PostgresJsDatabase<any>,
  auditLogger: AuditLogger,
  tableRef?: unknown,
) {
  let hasIntercepted = false; // Prevent double interception
  let hasReturning = false; // Track if user called .returning()
  let shouldAugmentReturning = false;
  let projectUserResult: ((result: unknown) => unknown) | null = null;
  let fullReturningBuilder: QueryBuilderLike | null = null;

  const proxy = new Proxy(queryBuilder, {
    get(target, prop) {
      const original = (target as Record<string, unknown>)[prop as string];

      if (prop === "returning" && typeof original === "function") {
        return function (...args: unknown[]) {
          hasReturning = true;
          if (args.length === 1 && isSelectionObject(args[0])) {
            const keys = Object.keys(args[0]);
            shouldAugmentReturning = keys.length > 0;
            projectUserResult = (result) => projectReturningResult(result, keys);
            if (shouldAugmentReturning) {
              // Build a full-returning variant for audit only.
              fullReturningBuilder = (original as Function).apply(target, []);
              // Keep original builder unmodified; we'll project results to user selection.
              return proxy;
            }
          } else {
            shouldAugmentReturning = false;
            projectUserResult = null;
            fullReturningBuilder = null;
          }

          const result = (original as Function).apply(target, args);

          if (result && typeof result === "object" && result !== target) {
            return createExecutionProxy(
              operation,
              result as QueryBuilderLike,
              db,
              auditLogger,
              tableRef,
            );
          }

          if (result === target) {
            return proxy;
          }

          return result;
        };
      }

      // Intercept promise methods (then, catch, finally) which trigger execution
      if (prop === "then" || prop === "catch" || prop === "finally") {
        return function (...args: unknown[]) {
          // If we've already intercepted, just pass through
          if (hasIntercepted) {
            debug(`Already intercepted for ${operation}, passing through ${String(prop)}`);
            return (original as Function | undefined)?.apply(target, args);
          }

          hasIntercepted = true;
          const tableName = extractTableName(target, tableRef);
          debug(`Intercepting ${operation} on ${tableName} via ${String(prop)}`);

          // If we can't extract table name or shouldn't audit, just execute normally
          if (!tableName || !auditLogger.shouldAudit(tableName)) {
            debug(
              `Skipping audit for ${tableName} (shouldAudit: ${tableName ? auditLogger.shouldAudit(tableName) : "no table"})`,
            );
            return (original as Function | undefined)?.apply(target, args);
          }

          // For INSERT/UPDATE/DELETE, automatically add .returning() if not present
          let queryToExecute = target;
          if (operation === "insert" || operation === "update" || operation === "delete") {
            if (!hasReturning) {
              debug(`Auto-injecting .returning() for ${operation} on ${tableName}`);
              if (typeof target.returning === "function") {
                queryToExecute = target.returning();
              }
            } else if (shouldAugmentReturning && typeof target.returning === "function") {
              // User selected partial columns; execute with full returning for audit,
              // then project back to user's selection.
              queryToExecute = fullReturningBuilder ?? target.returning();
            }
          }

          // Create a promise that executes with audit
          const auditedPromise = (async () => {
            debug(`Executing ${operation} on ${tableName} with audit`);
            return executeWithAudit(
              operation,
              tableName,
              queryToExecute,
              () => {
                // Execute the query - Drizzle queries are thenable, so we can await them
                return Promise.resolve(queryToExecute);
              },
              [],
              db,
              auditLogger,
              tableRef,
            );
          })();

          // Now apply the promise method to our audited promise
          return auditedPromise.then(
            (result) => {
              const projected = projectUserResult ? projectUserResult(result) : result;
              debug(
                `${operation} on ${tableName} completed, result count: ${Array.isArray(projected) ? projected.length : 1}`,
              );
              if (prop === "then" && args[0]) {
                return (args[0] as Function)(projected);
              }
              if (prop === "finally" && args[0]) {
                (args[0] as Function)();
              }
              return projected;
            },
            (error) => {
              debug(`${operation} on ${tableName} failed:`, error.message);
              if (prop === "catch" && args[0]) {
                return (args[0] as Function)(error);
              }
              if (prop === "finally" && args[0]) {
                (args[0] as Function)();
              }
              throw error;
            },
          );
        };
      }

      // For fluent API methods (where, set, values, returning, etc.), continue wrapping
      if (typeof original === "function") {
        return function (...args: unknown[]) {
          const result = (original as Function).apply(target, args);

          // If it returns a new builder, wrap it too (preserve tableRef)
          if (result && typeof result === "object" && result !== target) {
            return createExecutionProxy(
              operation,
              result as QueryBuilderLike,
              db,
              auditLogger,
              tableRef,
            );
          }

          // Preserve the proxy when chaining methods that return `this`
          if (result === target) {
            return proxy;
          }

          return result;
        };
      }

      return original;
    },
  });

  return proxy;
}

/**
 * Execute query with automatic audit logging
 */
async function executeWithAudit(
  operation: string,
  tableName: string,
  queryBuilder: QueryBuilderLike,
  originalExecute: unknown,
  executeArgs: unknown[],
  db: PostgresJsDatabase<any>,
  auditLogger: AuditLogger,
  tableRef?: unknown,
): Promise<unknown> {
  let beforeState: unknown[] = [];

  // For UPDATE only, capture the "before" state if configured
  if (operation === "update" && auditLogger.shouldCaptureBeforeState()) {
    beforeState = await captureBeforeState(tableName, queryBuilder, db, tableRef);
  }

  // Execute the actual operation
  // For DELETE, we rely on .returning() which is auto-injected
  let result: unknown;
  if (typeof originalExecute === "function" && (originalExecute as Function).length === 0) {
    // It's a wrapper function we created
    result = await (originalExecute as Function)();
  } else if (originalExecute) {
    // It's the original method from Drizzle
    result = await (originalExecute as Function).apply(queryBuilder, executeArgs);
  } else {
    // No execute method, the queryBuilder itself is thenable
    result = await Promise.resolve(queryBuilder as unknown);
  }

  // Create audit logs based on operation type
  await createAuditLogs(operation, tableName, beforeState, result, auditLogger);

  return result;
}

/**
 * Capture current state before UPDATE/DELETE
 */
async function captureBeforeState(
  tableName: string,
  queryBuilder: QueryBuilderLike,
  db: PostgresJsDatabase<any>,
  tableRef?: unknown,
): Promise<unknown[]> {
  try {
    const whereClause = extractWhereClause(queryBuilder);

    if (!whereClause) {
      // If no WHERE clause, we can't safely query before state
      // This might be a full table update/delete
      console.warn(`No WHERE clause found for ${tableName}, skipping before state capture`);
      return [];
    }

    // Query current state
    const fromTarget =
      (tableRef as any) ||
      queryBuilder.table ||
      queryBuilder._?.table ||
      queryBuilder.config?.table;
    const result = await db
      .select()
      .from(fromTarget as any)
      .where(whereClause as any);

    return Array.isArray(result) ? result : [result];
  } catch (error) {
    console.error("Failed to capture before state:", error);
    return [];
  }
}

/**
 * Create audit logs after operation completes
 */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSelectionObject(value: unknown): value is Record<string, unknown> {
  return isRecordObject(value) && !Array.isArray(value);
}

function projectReturningResult(result: unknown, keys: string[]): unknown {
  if (keys.length === 0) return result;
  if (Array.isArray(result)) {
    return result.map((row) => projectReturningResult(row, keys));
  }
  if (!isRecordObject(result)) return result;
  const projected: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in result) {
      projected[key] = result[key];
    }
  }
  return projected;
}

async function createAuditLogs(
  operation: string,
  tableName: string,
  beforeState: unknown[],
  result: unknown,
  auditLogger: AuditLogger,
): Promise<void> {
  const records = Array.isArray(result) ? result : result ? [result] : [];
  const recordObjects = records.filter(isRecordObject);
  const beforeObjects = beforeState.filter(isRecordObject);

  debug(
    `Creating audit logs for ${operation} on ${tableName}, records: ${records.length}, beforeState: ${beforeState.length}`,
  );

  if (recordObjects.length === 0 && beforeObjects.length === 0) {
    debug("No records to audit");
    return;
  }

  switch (operation) {
    case "insert":
      if (recordObjects.length > 0) {
        debug(`Logging ${recordObjects.length} INSERT operations`);
        await auditLogger.logInsert(tableName as any, recordObjects as any);
      }
      break;

    case "update":
      if (recordObjects.length > 0 && beforeObjects.length > 0) {
        debug(`Logging ${recordObjects.length} UPDATE operations`);
        await auditLogger.logUpdate(tableName as any, beforeObjects as any, recordObjects as any);
      } else if (recordObjects.length > 0 && beforeObjects.length === 0) {
        // Before state not captured; log with best-effort values
        debug(`Logging ${recordObjects.length} UPDATE operations (without before state)`);
        await auditLogger.logUpdate(tableName as any, [], recordObjects as any);
      } else {
        debug(
          `Skipping UPDATE audit: records=${recordObjects.length}, beforeState=${beforeObjects.length}`,
        );
      }
      break;

    case "delete":
      // For DELETE, we use data from .returning() which is auto-injected
      // The deleted data is in the result
      if (recordObjects.length > 0) {
        debug(`Logging ${recordObjects.length} DELETE operations`);
        await auditLogger.logDelete(tableName as any, recordObjects as any);
      } else {
        debug("Skipping DELETE audit: no records matched or returned");
      }
      break;
  }
}

/**
 * Wrap transaction method to maintain audit context
 */
function createTransactionProxy(originalTransaction: any, db: any, auditLogger: AuditLogger) {
  return async function (
    callback: (tx: PostgresJsDatabase<any>) => Promise<unknown>,
    options?: unknown,
  ) {
    // Generate transaction ID
    const transactionId = crypto.randomUUID();

    // Merge transaction ID into current context
    const currentContext = auditLogger.getContext() || {};
    const transactionContext = {
      ...currentContext,
      transactionId,
    };

    // Run transaction with audit context
    return auditLogger.withContext(transactionContext, async () => {
      return (originalTransaction as Function).call(
        db,
        async (tx: PostgresJsDatabase<any>) => {
          // Wrap the transaction db instance too
          const wrappedTx = createInterceptedDb(tx, auditLogger);
          return callback(wrappedTx);
        },
        options,
      );
    });
  };
}
