# wr-audit-logger

Automatic audit logging for **Drizzle ORM and PostgreSQL**.
Track who changed what and when without manual logging calls.

> [!NOTE]
> Most of this code was written and reviewed by AI. Use with caution.

## Installation

```bash
pnpm add wr-audit-logger drizzle-orm postgres
# or
npm install wr-audit-logger drizzle-orm postgres
# or
yarn add wr-audit-logger drizzle-orm postgres
```

The Quick Start uses the postgres driver. For node-postgres, install pg and use drizzle-orm/node-postgres instead.

Supports drizzle-orm `^0.45.2` and `^1.0.0-rc.4`.

## Quick start

### 1. Create the audit table

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createAuditTableSQL } from "wr-audit-logger";

const client = postgres(process.env.DATABASE_URL);
const db = drizzle({ client });

// Run once to create or update the audit_logs table
await db.execute(createAuditTableSQL);
```

Custom table name:

```ts
import { createAuditTableSQLFor } from "wr-audit-logger";
await db.execute(createAuditTableSQLFor("my_audit_logs"));
```

Custom column names:

```ts
import { createAuditTableSQLFor } from "wr-audit-logger";
await db.execute(
  createAuditTableSQLFor("my_audit_logs", {
    columnMap: { userId: "actor_id", tableName: "resource" },
  }),
);
```

Drizzle table helper with a custom table name and extra columns:

```ts
import { varchar } from "drizzle-orm/pg-core";
import { createAuditLogsTable } from "wr-audit-logger";

export const auditLogs = createAuditLogsTable("my_audit_logs", {
  companyId: varchar("company_id", { length: 255 }),
});
```

This helper defines the Drizzle table. Apply it with your migration tool. The
built-in writer writes only the standard audit columns, so extra columns must
be nullable or have a database default. Use customWriter to populate them.

### 2. Create an audit logger (wraps your db)

```ts
import { createAuditLogger } from "wr-audit-logger";

const auditLogger = createAuditLogger(db, {
  tables: {
    users: { primaryKey: "id" },
    vehicles: { primaryKey: "id" },
  },
  excludeFields: ["password", "token"],
  getUserId: () => getCurrentUser()?.id,
});

// IMPORTANT: use the wrapped db
const { db: auditedDb } = auditLogger;
```

### 3. Set context

#### Example: Express middleware

```ts
app.use((req, res, next) => {
  auditLogger.setContext({
    userId: req.user?.id,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
    metadata: {
      path: req.path,
      method: req.method,
    },
  });

  next();
});
```

#### Example: Hono middleware

```ts
import { Hono } from "hono";

const app = new Hono();

app.use("*", async (c, next) => {
  auditLogger.setContext({
    userId: c.get("user")?.id,
    ipAddress: c.req.header("x-forwarded-for") || c.req.raw.headers.get("x-forwarded-for"),
    userAgent: c.req.header("user-agent"),
    metadata: {
      path: c.req.path,
      method: c.req.method,
    },
  });

  await next();
});
```

#### Example: tRPC middleware

```ts
import { initTRPC } from "@trpc/server";

const t = initTRPC
  .context<{
    req: { user?: { id?: string }; ip?: string; headers?: Record<string, string> };
  }>()
  .create();

const auditContext = t.middleware(({ ctx, next }) => {
  auditLogger.setContext({
    userId: ctx.req.user?.id,
    ipAddress: ctx.req.ip,
    userAgent: ctx.req.headers?.["user-agent"],
    metadata: {
      path: ctx.req.headers?.["x-path"],
      method: ctx.req.headers?.["x-method"],
    },
  });

  return next();
});

const protectedProcedure = t.procedure.use(auditContext);
```

### 4. Use the database normally

```ts
await auditedDb.insert(users).values({
  email: "alice@example.com",
  name: "Alice",
});
// Audit log created automatically

await auditedDb.update(users).set({ name: "Alice Smith" }).where(eq(users.id, 1));
// Audit log created with before/after values

await auditedDb.delete(users).where(eq(users.id, 1));
// Audit log created automatically
```

The wrapped database intercepts INSERT, UPDATE, and DELETE query builders and
creates audit logs for configured tables. That covers `await`, `.then()`,
`.execute()`, and prepared statements (`.prepare()`).

Not audited: raw SQL (`db.execute(...)`), queries on the original unwrapped
`db`, and statements built from `db.with(...)`. Upserts
(`onConflictDoUpdate`) are logged as INSERT.

### Return values (auto-injected `.returning()`)

For audit capture, `.returning()` is auto-injected for INSERT/UPDATE/DELETE when you don't call it.
The result is then the affected rows instead of the driver's usual result object. The
row count is kept on the array as `rowCount` (node-postgres) and `count` (postgres-js),
so `if (result.rowCount === 0)` still works. Other driver metadata, such as
node-postgres `command` or `fields`, is not available while auditing is enabled.

A partial selection such as `.returning({ userId: users.id })` returns exactly what you
selected; the logger requests the full row for the audit log separately in the same query.

## Configuration

```ts
interface AuditConfig {
  // Tables to audit with per-table primary key config
  tables: Record<string, { primaryKey: string | string[] }>;

  // Specific fields per table (optional)
  fields?: Record<string, string[]>;

  // Fields to exclude globally. Their values are never stored. When a locked
  // before-state is available, changes use "[REDACTED]"; full after-rows omit them.
  excludeFields?: string[];

  // Audit table name (default: audit_logs)
  // If you change this, use createAuditTableSQLFor() when creating schema
  auditTable?: string;

  // Map logical audit fields to custom column names
  auditColumnMap?: {
    userId?: string;
    ipAddress?: string;
    userAgent?: string;
    action?: string;
    tableName?: string;
    recordId?: string;
    values?: string;
    createdAt?: string;
    metadata?: string;
    transactionId?: string;
    deletedAt?: string;
  };

  // Propagate audit failures (default: false). Custom writers can fail after commit;
  // see AuditDeliveryError under Transactions.
  strictMode?: boolean;

  // Customize error handling for audit write failures
  logError?: (message: string, error: unknown) => void;

  // Resolve current user id. Used when the context (setContext/withContext)
  // has no userId; an explicit context userId wins.
  getUserId?: () => string | undefined | Promise<string | undefined>;

  // Resolve additional metadata
  getMetadata?: () => Record<string, unknown> | Promise<Record<string, unknown>>;

  // "changed": locked diffs inside audited transactions; full after-rows outside.
  // "full": always store the full after-row, with excluded fields removed.
  updateValuesMode?: "changed" | "full";

  // Batch configuration for async writes (disabled by default)
  batch?: {
    // Max logs per batch (default: 100)
    batchSize?: number;
    // Max queued logs (default: 10000)
    maxQueueSize?: number;
    // Flush interval in ms (default: 1000)
    flushInterval?: number;
    // If true, wait for writes before returning (default: false)
    waitForWrite?: boolean;
  };
  // Batch mode never keeps the process alive and installs no signal handlers.
  // Queued logs are flushed on "beforeExit"; call shutdown() from your own
  // SIGTERM handler so they are also written when the process is stopped.

  // Custom writer to store audit logs in your own table.
  // `context.userId` falls back to getUserId(); `context.metadata` and each
  // `log.metadata` include getMetadata(). Inside a transaction it is called
  // after the transaction commits (and not at all if it rolls back).
  customWriter?: (
    logs: Array<{
      action: string;
      tableName: string;
      recordId: string;
      values?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }>,
    context: AuditContext | undefined,
  ) => Promise<void> | void;
}

interface AuditContext {
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  transactionId?: string;
}
```

## Usage patterns

### 1) Default auto-audit (recommended)

```ts
const auditLogger = createAuditLogger(db, {
  tables: {
    users: { primaryKey: "id" },
    vehicles: { primaryKey: "id" },
  },
  excludeFields: ["password", "token"],
  getUserId: () => getCurrentUser()?.id,
});

const { db: auditedDb } = auditLogger;
await auditedDb.insert(users).values({ ... });
```

### 2) Custom audit table name / column names

```ts
await db.execute(
  createAuditTableSQLFor("my_audit_logs", {
    columnMap: { userId: "actor_id", tableName: "resource" },
  }),
);

const auditLogger = createAuditLogger(db, {
  tables: {
    users: { primaryKey: "id" },
  },
  auditTable: "my_audit_logs",
  auditColumnMap: { userId: "actor_id", tableName: "resource" },
});
```

### 3) Custom table with extra columns

```ts
export const auditLogs = createAuditLogsTable("audit_logs", {
  companyId: varchar("company_id", { length: 255 }),
});

const auditLogger = createAuditLogger(db, {
  tables: {
    users: { primaryKey: "id" },
  },
  // The built-in writer writes only standard columns.
});
```

If `company_id` must be populated, use `customWriter` as shown below.

### 4) Custom storage (full control)

```ts
const auditLogger = createAuditLogger(db, {
  tables: {
    users: { primaryKey: "id" },
  },
  customWriter: async (logs, context) => {
    await db.insert(myAuditTable).values(
      logs.map((log) => ({
        company_id: getCompanyId(),
        user_id: context?.userId,
        action: log.action,
        table_name: log.tableName,
        record_id: log.recordId,
        values: log.values,
        metadata: log.metadata,
      })),
    );
  },
});
```

### 5) Batch mode (async)

```ts
const auditLogger = createAuditLogger(db, {
  tables: {
    users: { primaryKey: "id" },
  },
  batch: { batchSize: 200, flushInterval: 1000 },
});

process.on("SIGTERM", async () => {
  await auditLogger.shutdown(); // writes anything still queued
  process.exit(0);
});
```

Batch mode writes after the mutation returns, so an audit row can be lost if the
process dies first, or if a batch fails to write (failed batches are reported
through `logError`, not retried). For atomic data/audit writes, use the built-in
writer inside an audited transaction with `strictMode: true`.

### 6) Manual logging

```ts
const auditLogger = createAuditLogger(db, {
  tables: {
    users: { primaryKey: "id" },
  },
});
// The table must be listed in `tables` or the logger ignores the entry.
await auditLogger.log({
  action: "READ",
  tableName: "users",
  recordId: "1",
  values: { ... },
});
```

### 7) Type-safe schema usage

Table names, columns and primary keys are checked against the tables your Drizzle
instance knows about. Without them, any table name is accepted.

drizzle-orm 1.x reads tables from `relations`:

```ts
import { defineRelations } from "drizzle-orm";

const relations = defineRelations({ users, vehicles });
const db = drizzle({ client, relations });

const auditLogger = createAuditLogger(db, {
  tables: {
    users: { primaryKey: "id" },
  },
  fields: { users: ["id", "email"] },
});
```

drizzle-orm 0.45 reads tables from `schema`:

```ts
const schema = { users, vehicles };
const db = drizzle({ client, schema });

const auditLogger = createAuditLogger(db, {
  tables: {
    users: { primaryKey: "id" },
  },
  fields: { users: ["id", "email"] },
});
```

Defaults (if omitted):

- `excludeFields`: `["password", "token", "secret", "apiKey"]`
- `auditTable`: `"audit_logs"`
- `strictMode`: `false`
- `updateValuesMode`: `"changed"` (locked diffs inside audited transactions;
  full after-rows outside transactions)
- `batch`: disabled (writes immediately)

## Schema contract (default writer)

If you use the built-in writer (no `customWriter`), your table must have these columns
or map them via `auditColumnMap`:

- `userId` → `user_id` (nullable)
- `ipAddress` → `ip_address` (nullable)
- `userAgent` → `user_agent` (nullable)
- `action` → `action` (NOT NULL)
- `tableName` → `table_name` (NOT NULL)
- `recordId` → `record_id` (NOT NULL)
- `values` → `values` (JSONB, nullable)
- `metadata` → `metadata` (JSONB, nullable)
- `transactionId` → `transaction_id` (nullable)

`created_at` should default to `NOW()`. `id` and `deleted_at` are optional.

## Examples

### Audit specific fields only

```ts
const auditLogger = createAuditLogger(db, {
  tables: {
    users: { primaryKey: "id" },
    vehicles: { primaryKey: "id" },
  },
  fields: {
    users: ["id", "email", "role"],
    vehicles: ["id", "make", "model", "status"],
  },
});
```

### Custom context (background jobs, scripts)

```ts
await auditLogger.withContext(
  {
    userId: "SYSTEM",
    metadata: {
      jobId: "cleanup-job-123",
      reason: "scheduled_maintenance",
    },
  },
  async () => {
    await auditedDb.delete(expiredTokens).where(lt(expiredTokens.expiresAt, new Date()));
  },
);
```

All operations inside the callback inherit this context.

Drizzle builders are lazy: start execution inside the callback. Returning a builder
from a synchronous callback, such as `withContext(ctx, () => auditedDb.insert(users).values(data))`,
lets an outer `await` start it after the scope has returned. Use an async callback
with an inner `await` as above, an async callback returning the builder, or call
`.execute()` inside the callback.

### Manual and custom actions

You can log custom actions such as READ or EXPORT manually. The table must be
listed in `tables` or the logger ignores the entry.

```ts
await auditLogger.log({
  action: "READ",
  tableName: "users",
  recordId: docId,
  metadata: { reason: "user_request" },
});
```

### Transactions

Operations inside a transaction share a generated `transaction_id`. With the
built-in writer, audit rows use the transaction's own connection: they commit and
roll back together with your changes. Nested transactions (savepoints) share
the outer `transaction_id`.

- Non-strict mode wraps each audit write in a savepoint, so a failed audit
  write is reported through `logError` without aborting your transaction.
- In strict mode a failed built-in audit write fails the statement, and with it
  the transaction.
- A `customWriter` can't join the transaction, so it is called after commit
  and skipped on rollback.
- With the built-in writer, batch mode doesn't apply inside a transaction: audit rows are written
  immediately on the transaction, so they stay atomic with the change.
- With `updateValuesMode: "changed"`, the before-state SELECT uses
  `FOR UPDATE`. Outside audited transactions, the logger stores the full returned
  after-row instead of taking an unlocked snapshot. It also falls back to the
  after-row for updates without a WHERE clause or with UPDATE FROM/joins.

For automatic updates, field diffs require an audited transaction. Without one,
even an update that sets an existing value is logged as an UPDATE with its full
after-row. Field allow-lists and exclusions still apply in both modes.

If a custom writer fails after commit, strict mode throws the exported
`AuditDeliveryError`, with `code: "AUDIT_DELIVERY_FAILED_AFTER_COMMIT"`,
`committed: true`, `transactionId`, and the original error in `cause`.
The database changes are already committed: **do not retry the business transaction**.
Non-strict mode reports this error through `logError` and returns the transaction
result. A custom writer may have partially delivered logs before failing; recovery
needs an idempotent writer. With asynchronous batching, later failures are reported
through `logError` rather than rejecting the completed transaction.

```ts
import { AuditDeliveryError } from "wr-audit-logger";

try {
  await auditedDb.transaction(async (tx) => {
    await tx.insert(users).values(data);
  });
} catch (error) {
  if (error instanceof AuditDeliveryError) {
    // Data committed. Report/reconcile audit delivery separately; do not rerun the insert.
    reportAuditDeliveryFailure(error.transactionId, error.cause);
  } else {
    throw error;
  }
}
```

For durable external delivery, write an outbox entry in the same business
transaction and deliver it with an idempotent worker. A custom writer alone
cannot make a database commit and an external write atomic. Outside a transaction,
an audit failure also cannot undo an already-committed mutation.

Use the `tx` passed to the callback. Statements run on the root `db` inside the
callback are not part of the transaction, and neither are their audit rows.

```ts
await auditedDb.transaction(async (tx) => {
  // No .returning() needed unless you want the data
  await tx.insert(users).values({
    email: "bob@example.com",
    name: "Bob Builder",
    role: "user",
  });

  // Use .returning() when you need the data
  const [user] = await tx
    .insert(users)
    .values({
      email: "alice@example.com",
      name: "Alice",
    })
    .returning();

  await tx.insert(posts).values({
    title: "My Post",
    content: "Content",
    userId: user.id, // Using the returned data
  });

  // All operations share the same transaction_id.
});
```

## Querying audit logs

```ts
import { eq, desc } from "drizzle-orm";
import { auditLogs } from "wr-audit-logger";

// History for a specific record
const history = await auditedDb
  .select()
  .from(auditLogs)
  .where(eq(auditLogs.tableName, "users"))
  .where(eq(auditLogs.recordId, userId))
  .orderBy(desc(auditLogs.createdAt));

// All changes by a user
const activity = await auditedDb
  .select()
  .from(auditLogs)
  .where(eq(auditLogs.userId, userId))
  .orderBy(desc(auditLogs.createdAt))
  .limit(100);
```

## Roadmap

- [x] Phase 1, manual audit logging
- [x] Phase 2, automatic interception (current)
- [x] Phase 3, async and batched writes
- [ ] Phase 4, ORM adapters

## License

ISC
