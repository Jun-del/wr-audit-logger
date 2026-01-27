import type { AuditLogger } from "./AuditLogger.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getTableName, isTable } from "drizzle-orm/table";

/**
 * Extract table name from Drizzle query builder
 * This is a bit hacky but works with Drizzle's internal structure
 */
function resolveTableName(table: unknown): string | null {
  if (!table || (typeof table !== "object" && typeof table !== "function")) {
    return null;
  }

  try {
    if (isTable(table as any)) {
      return getTableName(table as any);
    }
  } catch (_e) {
    // Ignore detection errors
  }

  const maybeName = (table as any).name;
  return typeof maybeName === "string" ? maybeName : null;
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
  } catch (e) {
    // Ignore extraction errors
  }

  return null;
}

/**
 * Create a proxied database instance that intercepts operations
 */
export function createInterceptedDb(
  db: PostgresJsDatabase<any>,
  auditLogger: AuditLogger,
): PostgresJsDatabase<any> {
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
  }) as PostgresJsDatabase<any>;
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
  const proxy = new Proxy(queryBuilder, {
    get(target, prop) {
      const original = target[prop];

      // Intercept terminal methods that execute the query
      if (prop === "execute" || prop === "then") {
        return async function (...args: any[]) {
          const tableName = extractTableName(target, tableRef);

          // If we can't extract table name or shouldn't audit, just execute
          if (!tableName || !(auditLogger as any).shouldAudit(tableName)) {
            return original.apply(target, args);
          }

          // Execute with audit logging
          return executeWithAudit(
            operation,
            tableName,
            target,
            original,
            args,
            db,
            auditLogger,
            tableRef,
          );
        };
      }

      // For fluent API methods (where, set, values, etc.), continue wrapping
      if (typeof original === "function") {
        return function (...args: any[]) {
          const result = original.apply(target, args);

          // If it returns a new builder, wrap it too
          if (result && typeof result === "object" && result !== target) {
            return createExecutionProxy(operation, result, db, auditLogger);
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
    // For UPDATE/DELETE, capture the "before" state
    if (operation === "update" || operation === "delete") {
      beforeState = await captureBeforeState(tableName, queryBuilder, db, tableRef);
    }

    // Execute the actual operation
    const result = await originalExecute.apply(queryBuilder, executeArgs);

    // Create audit logs based on operation type
    await createAuditLogs(operation, tableName, beforeState, result, auditLogger);

    return result;
  } catch (error) {
    // If strict mode, rethrow the error
    // Otherwise, log but allow operation to fail
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
      .where(whereClause)
      .execute();

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

  if (records.length === 0 && beforeState.length === 0) {
    return;
  }

  switch (operation) {
    case "insert":
      if (records.length > 0) {
        await auditLogger.logInsert(tableName, records);
      }
      break;

    case "update":
      if (records.length > 0 && beforeState.length > 0) {
        await auditLogger.logUpdate(tableName, beforeState, records);
      }
      break;

    case "delete":
      // For delete, use beforeState since records are gone
      if (beforeState.length > 0) {
        await auditLogger.logDelete(tableName, beforeState);
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
