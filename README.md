# wr-audit-logger

Automatic audit logging for **Drizzle ORM and PostgreSQL**.
Track who changed what and when without manual logging calls.

> [!NOTE]
> Most of this code was written by AI and reviewed by a human. Use with caution.

## Installation

```bash
pnpm add wr-audit-logger drizzle-orm postgres
# or
npm install wr-audit-logger drizzle-orm postgres
# or
yarn add wr-audit-logger drizzle-orm postgres
```

The Quick Start uses the postgres driver. For node-postgres, install pg and use drizzle-orm/node-postgres instead.

## Quick start

### 1. Create the audit table

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createAuditTableSQL } from "wr-audit-logger";

const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client);

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

The wrapped database intercepts INSERT, UPDATE, and DELETE operations and
creates audit logs for configured tables.

### Return values (auto-injected `.returning()`)

For audit capture, `.returning()` is auto-injected for INSERT/UPDATE/DELETE when you don't call it.
This means the result may be the returned rows even if you didn't explicitly request them.
If your code relies on non-returning metadata, avoid depending on that behavior while auditing is enabled.

## Configuration

```ts
interface AuditConfig {
  // Tables to audit with per-table primary key config
  tables: Record<string, { primaryKey: string | string[] }>;

  // Specific fields per table (optional)
  fields?: Record<string, string[]>;

  // Fields to exclude globally
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

  // Fail the DB operation if audit logging fails (default: false)
  strictMode?: boolean;

  // Customize error handling for audit write failures
  logError?: (message: string, error: unknown) => void;

  // Resolve current user id
  getUserId?: () => string | undefined | Promise<string | undefined>;

  // Resolve additional metadata
  getMetadata?: () => Record<string, unknown> | Promise<Record<string, unknown>>;

  // How UPDATE values are stored ("changed" or "full")
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

  // Custom writer to store audit logs in your own table
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
```

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

```ts
const schema = { users, vehicles };
const auditLogger = createAuditLogger(db as PostgresJsDatabase<typeof schema>, {
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
- `updateValuesMode`: `"changed"` (UPDATE stores only changed fields)
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

Operations inside a transaction share a generated `transaction_id`. Audit
writes use the logger's database connection, not the transaction connection,
so audit rows do not roll back with the transaction.

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
