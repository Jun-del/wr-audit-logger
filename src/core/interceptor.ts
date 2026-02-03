import type { AuditLogger } from "./AuditLogger.js";
import { getTableName, isTable } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

// Enable debug logging via environment variable
const DEBUG = process.env.AUDIT_DEBUG === "true";
function debug(...args: any[]) {
  if (DEBUG) {
    console.log("[AUDIT DEBUG]", ...args);
  }
}

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
    (table as any)?._?.name ?? (table as any)?._?.config?.name ?? (table as any)?.name;
  if (typeof metaName === "string" && metaName.length > 0) {
    return metaName;
  }

  return null;
}

function extractTableName(queryBuilder: any, tableRef?: unknown): string | null {
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
        return match[2] || match[1];
      }
    }
  } catch (_e) {
    // Ignore extraction errors
  }

  return null;
}

/**
 * Extract WHERE clause conditions to query "before" state
 */
function extractWhereClause(queryBuilder: any): any {
  try {
    // Get the WHERE condition from query builder
    if (queryBuilder.config?.where) {
      return queryBuilder.config.where;
    }

    if (queryBuilder._ && queryBuilder._.where) {
      return queryBuilder._.where;
    }
  } catch (_e) {
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
        return createQueryBuilderProxy(prop, original, target, auditLogger);
      }

      // Intercept transaction method to maintain context
      if (prop === "transaction") {
        return createTransactionProxy(original, target, auditLogger);
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
  originalMethod: any,
  db: any,
  auditLogger: AuditLogger,
) {
  return function (...args: any[]) {
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
  queryBuilder: any,
  db: any,
  auditLogger: AuditLogger,
  tableRef?: unknown,
) {
  let hasIntercepted = false; // Prevent double interception
  let hasReturning = false; // Track if user called .returning()

  const proxy = new Proxy(queryBuilder, {
    get(target, prop) {
      const original = target[prop];

      // Track if .returning() was called
      if (prop === "returning") {
        hasReturning = true;
      }

      // Intercept promise methods (then, catch, finally) which trigger execution
      if (prop === "then" || prop === "catch" || prop === "finally") {
        return function (...args: any[]) {
          // If we've already intercepted, just pass through
          if (hasIntercepted) {
            debug(`Already intercepted for ${operation}, passing through ${String(prop)}`);
            return original?.apply(target, args);
          }

          hasIntercepted = true;
          const tableName = extractTableName(target, tableRef);
          debug(`Intercepting ${operation} on ${tableName} via ${String(prop)}`);

          // If we can't extract table name or shouldn't audit, just execute normally
          if (!tableName || !auditLogger.shouldAudit(tableName)) {
            debug(
              `Skipping audit for ${tableName} (shouldAudit: ${tableName ? auditLogger.shouldAudit(tableName) : "no table"})`,
            );
            return original?.apply(target, args);
          }

          // For INSERT/UPDATE/DELETE, automatically add .returning() if not present
          let queryToExecute = target;
          if (
            (operation === "insert" || operation === "update" || operation === "delete") &&
            !hasReturning
          ) {
            debug(`Auto-injecting .returning() for ${operation} on ${tableName}`);
            // Call .returning() on the query builder to get the affected rows
            if (typeof target.returning === "function") {
              queryToExecute = target.returning();
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
              debug(
                `${operation} on ${tableName} completed, result count: ${Array.isArray(result) ? result.length : 1}`,
              );
              if (prop === "then" && args[0]) {
                return args[0](result);
              }
              if (prop === "finally" && args[0]) {
                args[0]();
              }
              return result;
            },
            (error) => {
              debug(`${operation} on ${tableName} failed:`, error.message);
              if (prop === "catch" && args[0]) {
                return args[0](error);
              }
              if (prop === "finally" && args[0]) {
                args[0]();
              }
              throw error;
            },
          );
        };
      }

      // For fluent API methods (where, set, values, returning, etc.), continue wrapping
      if (typeof original === "function") {
        return function (...args: any[]) {
          const result = original.apply(target, args);

          // If it returns a new builder, wrap it too (preserve tableRef)
          if (result && typeof result === "object" && result !== target) {
            return createExecutionProxy(operation, result, db, auditLogger, tableRef);
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
  queryBuilder: any,
  originalExecute: any,
  executeArgs: any[],
  db: any,
  auditLogger: AuditLogger,
  tableRef?: unknown,
): Promise<any> {
  let beforeState: any[] = [];

  try {
    // For UPDATE only, capture the "before" state if configured
    if (operation === "update" && auditLogger.shouldCaptureOldValues()) {
      beforeState = await captureBeforeState(tableName, queryBuilder, db, tableRef);
    }

    // Execute the actual operation
    // For DELETE, we rely on .returning() which is auto-injected
    let result;
    if (typeof originalExecute === "function" && originalExecute.length === 0) {
      // It's a wrapper function we created
      result = await originalExecute();
    } else if (originalExecute) {
      // It's the original method from Drizzle
      result = await originalExecute.apply(queryBuilder, executeArgs);
    } else {
      // No execute method, the queryBuilder itself is thenable
      result = await queryBuilder;
    }

    // Create audit logs based on operation type
    await createAuditLogs(operation, tableName, beforeState, result, auditLogger);

    return result;
  } catch (error) {
    // Always rethrow - let the application handle the error
    throw error;
  }
}

/**
 * Capture current state before UPDATE/DELETE
 */
async function captureBeforeState(
  tableName: string,
  queryBuilder: any,
  db: any,
  tableRef?: unknown,
): Promise<any[]> {
  try {
    const whereClause = extractWhereClause(queryBuilder);

    if (!whereClause) {
      // If no WHERE clause, we can't safely query before state
      // This might be a full table update/delete
      console.warn(`No WHERE clause found for ${tableName}, skipping before state capture`);
      return [];
    }

    // Query current state
    const result = await db
      .select()
      .from(
        (tableRef as any) ||
          queryBuilder.table ||
          queryBuilder._?.table ||
          queryBuilder.config?.table,
      )
      .where(whereClause);

    return Array.isArray(result) ? result : [result];
  } catch (error) {
    console.error("Failed to capture before state:", error);
    return [];
  }
}

/**
 * Create audit logs after operation completes
 */
async function createAuditLogs(
  operation: string,
  tableName: string,
  beforeState: any[],
  result: any,
  auditLogger: AuditLogger,
): Promise<void> {
  const records = Array.isArray(result) ? result : result ? [result] : [];

  debug(
    `Creating audit logs for ${operation} on ${tableName}, records: ${records.length}, beforeState: ${beforeState.length}`,
  );

  if (records.length === 0 && beforeState.length === 0) {
    debug("No records to audit");
    return;
  }

  switch (operation) {
    case "insert":
      if (records.length > 0) {
        debug(`Logging ${records.length} INSERT operations`);
        await auditLogger.logInsert(tableName, records);
      }
      break;

    case "update":
      if (records.length > 0 && beforeState.length > 0) {
        debug(`Logging ${records.length} UPDATE operations`);
        await auditLogger.logUpdate(tableName, beforeState, records);
      } else if (records.length > 0 && beforeState.length === 0) {
        // captureOldValues is disabled, log without old values
        debug(`Logging ${records.length} UPDATE operations (without old values)`);
        await auditLogger.logUpdate(tableName, [], records);
      } else {
        debug(
          `Skipping UPDATE audit: records=${records.length}, beforeState=${beforeState.length}`,
        );
      }
      break;

    case "delete":
      // For DELETE, we use data from .returning() which is auto-injected
      // The deleted data is in the result
      if (records.length > 0) {
        debug(`Logging ${records.length} DELETE operations`);
        await auditLogger.logDelete(tableName, records);
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
  return async function (callback: any, options?: any) {
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
      return originalTransaction.call(
        db,
        async (tx: any) => {
          // Wrap the transaction db instance too
          const wrappedTx = createInterceptedDb(tx, auditLogger);
          return callback(wrappedTx);
        },
        options,
      );
    });
  };
}
