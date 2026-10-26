import { getTableColumns, getTableName, isTable } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { AuditLogger, MutationOperation } from "./AuditLogger.js";

// Enable debug logging via environment variable
const DEBUG = process.env.AUDIT_DEBUG === "true";
function debug(...args: unknown[]) {
  if (DEBUG) {
    console.log("[AUDIT DEBUG]", ...args);
  }
}

type Db = PostgresJsDatabase<any>;
type Row = Record<string, unknown>;
type Builder = Record<PropertyKey, any>;
type PlaceholderValues = Record<string, unknown> | undefined;

/** Prefix for the extra columns requested next to a partial `.returning({...})` selection */
const AUDIT_KEY_PREFIX = "__audit__";

interface BuilderState {
  operation: MutationOperation;
  table: unknown;
  /** The db or transaction the statement runs on */
  db: Db;
  auditLogger: AuditLogger<any>;
  /**
   * What the caller passed to `.returning()`:
   * `undefined` if it was never called, `null` for `.returning()` with no selection.
   */
  selection: Record<string, unknown> | null | undefined;
}

/**
 * How to run a statement so the audit gets full rows while the caller gets what they asked for.
 */
interface ReturningPlan {
  split(result: unknown): { returned: unknown; auditRows: Row[] };
  /** Put back the caller's own `.returning()` selection on the builder */
  restore(): void;
}

/**
 * Create a proxied database instance that intercepts operations
 */
export function createInterceptedDb<TDb extends Db>(db: TDb, auditLogger: AuditLogger<any>): TDb {
  return new Proxy(db, {
    get(target, prop) {
      const original = (target as Builder)[prop];
      if (typeof original !== "function") {
        return original;
      }

      if (prop === "insert" || prop === "update" || prop === "delete") {
        return (table: unknown, ...rest: unknown[]) =>
          wrapBuilder(
            { operation: prop, table, db: target, auditLogger, selection: undefined },
            original.call(target, table, ...rest),
          );
      }

      if (prop === "transaction") {
        return (callback: (tx: Db) => unknown, ...rest: unknown[]) =>
          auditLogger.runTransaction((bindTx) =>
            original.call(
              target,
              (tx: Db) => {
                bindTx(tx);
                return callback(createInterceptedDb(tx, auditLogger));
              },
              ...rest,
            ),
          );
      }

      return original;
    },
  });
}

/**
 * Wrap an insert/update/delete builder so that running it (await, .then, .execute(),
 * or a prepared statement) also writes the audit log.
 */
function wrapBuilder(state: BuilderState, builder: Builder): Builder {
  const proxy: Builder = new Proxy(builder, {
    get(target, prop) {
      const original = target[prop];
      if (typeof original !== "function") {
        return original;
      }

      switch (prop) {
        case "then":
          return (
            onFulfilled?: (value: unknown) => unknown,
            onRejected?: (e: unknown) => unknown,
          ) => run(state, target, () => target.execute()).then(onFulfilled, onRejected);
        case "catch":
          return (onRejected?: (e: unknown) => unknown) =>
            run(state, target, () => target.execute()).catch(onRejected);
        case "finally":
          return (onFinally?: () => void) =>
            run(state, target, () => target.execute()).finally(onFinally);
        case "execute":
          return (placeholderValues?: PlaceholderValues) =>
            run(state, target, () => target.execute(placeholderValues), placeholderValues);
        case "prepare":
          return (...args: unknown[]) => prepare(state, target, args);
        case "returning":
          return (selection?: Record<string, unknown>) => {
            state.selection = selection ?? null;
            return chain(state, target, proxy, original.call(target, selection));
          };
        default:
          return (...args: unknown[]) => chain(state, target, proxy, original.apply(target, args));
      }
    },
  });

  return proxy;
}

/**
 * Keep fluent calls (`values`, `set`, `where`, ...) on the proxy.
 */
function chain(state: BuilderState, target: Builder, proxy: Builder, result: unknown): unknown {
  if (result === target) {
    return proxy;
  }
  if (isQueryBuilder(result)) {
    return wrapBuilder({ ...state }, result);
  }
  return result;
}

function isQueryBuilder(value: unknown): value is Builder {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Builder;
  return (
    typeof candidate.execute === "function" ||
    typeof candidate.values === "function" ||
    typeof candidate.set === "function"
  );
}

function auditedTableName(state: BuilderState): string | null {
  const tableName = isTable(state.table) ? getTableName(state.table) : null;
  if (!tableName || !state.auditLogger.shouldAudit(tableName)) {
    debug(`Skipping audit for ${state.operation} on ${tableName ?? "unknown table"}`);
    return null;
  }
  return tableName;
}

async function run(
  state: BuilderState,
  builder: Builder,
  execute: () => Promise<unknown>,
  placeholderValues?: PlaceholderValues,
): Promise<unknown> {
  const tableName = auditedTableName(state);
  if (!tableName) {
    return execute();
  }

  const plan = planReturning(builder, state);
  try {
    return await runAudited(state, tableName, builder, plan, execute, placeholderValues);
  } finally {
    plan.restore();
  }
}

function prepare(state: BuilderState, builder: Builder, args: unknown[]): unknown {
  const tableName = auditedTableName(state);
  if (!tableName) {
    return builder.prepare(...args);
  }

  // RETURNING has to be part of the statement before it is prepared
  const plan = planReturning(builder, state);
  let prepared: Builder;
  try {
    prepared = builder.prepare(...args);
  } finally {
    plan.restore();
  }

  return new Proxy(prepared, {
    get(target, prop) {
      const original = target[prop];
      if (prop !== "execute" || typeof original !== "function") {
        return original;
      }
      return (placeholderValues?: PlaceholderValues) =>
        runAudited(
          state,
          tableName,
          builder,
          plan,
          () => original.call(target, placeholderValues),
          placeholderValues,
        );
    },
  });
}

async function runAudited(
  state: BuilderState,
  tableName: string,
  builder: Builder,
  plan: ReturningPlan,
  execute: () => Promise<unknown>,
  placeholderValues: PlaceholderValues,
): Promise<unknown> {
  const beforeState =
    state.operation === "update" && state.auditLogger.shouldCaptureBeforeState()
      ? await captureBeforeState(state, builder, placeholderValues)
      : [];

  const result = await execute();
  const { returned, auditRows } = plan.split(result);

  debug(`${state.operation} on ${tableName} returned ${auditRows.length} row(s)`);
  await state.auditLogger.recordMutation(
    state.operation,
    tableName,
    beforeState,
    auditRows,
    state.db,
  );

  return returned;
}

/**
 * Make the statement return full rows for the audit log. Drizzle's `.returning()` replaces the
 * selection on the builder in place, which is why `restore()` exists.
 */
function planReturning(builder: Builder, state: BuilderState): ReturningPlan {
  const { selection } = state;
  const columns = isTable(state.table) ? (getTableColumns(state.table) as Row) : undefined;
  const noop = () => {};

  if (selection === null || (selection && !columns)) {
    // `.returning()` already gives full rows (or there's no table to ask for more columns)
    return {
      split: (result) => ({ returned: result, auditRows: toRows(result) }),
      restore: noop,
    };
  }

  if (selection === undefined) {
    // The caller didn't ask for rows; add RETURNING for the audit and keep the row count usable
    builder.returning(columns);
    return {
      split: (result) => ({ returned: withRowCount(result), auditRows: toRows(result) }),
      restore: noop,
    };
  }

  // Partial selection: ask for every column under a prefix next to the caller's own selection
  const userKeys = Object.keys(selection);
  const usedKeys = new Set(userKeys);
  const auditSelection: Row = {};
  const auditKeys = new Map<string, string>();
  for (const [key, column] of Object.entries(columns!)) {
    let alias = AUDIT_KEY_PREFIX + key;
    while (usedKeys.has(alias)) alias += "_";
    usedKeys.add(alias);
    auditSelection[alias] = column;
    auditKeys.set(alias, key);
  }
  builder.returning({ ...auditSelection, ...selection });

  return {
    split(result) {
      const rows = toRows(result);
      return {
        returned: rows.map((row) => pick(row, userKeys)),
        auditRows: rows.map((row) =>
          Object.fromEntries([...auditKeys].map(([alias, key]) => [key, row[alias]])),
        ),
      };
    },
    restore: () => builder.returning(selection),
  };
}

/**
 * Capture current state before UPDATE
 */
async function captureBeforeState(
  state: BuilderState,
  builder: Builder,
  placeholderValues: PlaceholderValues,
): Promise<Row[]> {
  // An unlocked snapshot can go stale before UPDATE, even hiding a real change.
  // Outside transactions use the returned after-state instead of attempting a diff.
  if (!state.auditLogger.isTransaction(state.db)) {
    return [];
  }

  const config = builder.config as { where?: unknown; from?: unknown; joins?: unknown[] };

  if (!config?.where) {
    debug("No WHERE clause, skipping before state capture");
    return [];
  }
  if (config.from || config.joins?.length) {
    // The WHERE clause may reference the other tables of an UPDATE ... FROM
    debug("UPDATE ... FROM, skipping before state capture");
    return [];
  }

  try {
    const query = state.db
      .select()
      .from(state.table as any)
      .where(config.where as any)
      .for("update");
    return toRows(await query.execute(placeholderValues));
  } catch (error) {
    state.auditLogger.logError("[AUDIT] Failed to capture before state:", error);
    return [];
  }
}

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null;
}

function toRows(result: unknown): Row[] {
  return Array.isArray(result) ? result.filter(isRow) : [];
}

function pick(row: Row, keys: string[]): Row {
  const picked: Row = {};
  for (const key of keys) {
    picked[key] = row[key];
  }
  return picked;
}

/**
 * Without RETURNING, drivers report how many rows changed: `rowCount` (node-postgres)
 * or `count` (postgres-js). Mirror both onto the rows we got back instead.
 */
function withRowCount(result: unknown): unknown {
  if (!Array.isArray(result)) {
    return result;
  }
  for (const key of ["rowCount", "count"]) {
    if (!(key in result)) {
      Object.defineProperty(result, key, { value: result.length, configurable: true });
    }
  }
  return result;
}
