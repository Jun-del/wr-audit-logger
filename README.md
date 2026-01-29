# wr-audit-logger

Automatic audit logging for **Drizzle ORM + PostgreSQL**.
Track who changed what and when — **without manual logging calls**.

## Installation

```bash
pnpm add wr-audit-logger
# or
npm install wr-audit-logger
# or
yarn add wr-audit-logger
```

## Quick Start

### 1. Create the audit table

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createAuditTableSQL } from "wr-audit-logger";

const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client);

// Run once to create the audit_logs table
await db.execute(createAuditTableSQL);
```

### 2. Create an audit logger (wraps your db)

```ts
import { createAuditLogger } from "wr-audit-logger";

const auditLogger = createAuditLogger(db, {
  tables: ["users", "vehicles"],
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
```

### 4. Use the database normally — auditing is automatic!

```ts
await auditedDb.insert(users).values({
  email: "alice@example.com",
  name: "Alice",
});
// ✓ Audit log created automatically

await auditedDb.update(users).set({ name: "Alice Smith" }).where(eq(users.id, 1));
// ✓ Audit log created with before/after values

await auditedDb.delete(users).where(eq(users.id, 1));
// ✓ Audit log created automatically
```

**No manual audit calls needed!** The audit logger automatically intercepts operations and creates audit logs.

## 🎉 No `.returning()` Required!

The audit logger automatically captures data from INSERT, UPDATE, and DELETE operations **without requiring** you to call `.returning()` on every query.

**How it works:**

- If you don't call `.returning()`, the audit logger injects it internally
- Audit logs are created using the captured data
- Your code's return value remains unchanged for backward compatibility

**When to use `.returning()`:**

- Only use `.returning()` when **you** need the returned data in your application code
- The audit logger works whether you use it or not

```typescript
// Works without .returning()
await db.insert(users).values({ email: "test@example.com" });
// Audit log created ✓

// Also works with .returning() when you need the data
const [user] = await db.insert(users).values({ email: "test@example.com" }).returning();
// Audit log created ✓ + you get the user object
```

See [Automatic .returning() Injection](./docs/auto-returning.md) for details.

## Configuration

```ts
interface AuditConfig {
  // Tables to audit
  tables: string[] | "*";

  // Specific fields per table (optional)
  fields?: Record<string, string[]>;

  // Fields to exclude globally
  excludeFields?: string[];

  // Audit table name (default: audit_logs)
  auditTable?: string;

  // Fail the DB operation if audit logging fails
  strictMode?: boolean;

  // Resolve current user id
  getUserId?: () => string | undefined | Promise<string | undefined;

  // Resolve additional metadata
  getMetadata?: () => Record<string, unknown> | Promise<Record<string, unknown>>;

  // Whether to capture "before" values for UPDATE operations
  captureOldValues?: boolean;

  // Custom writer to store audit logs in your own table
  customWriter?: (
    logs: Array<{
      action: string;
      tableName: string;
      recordId: string;
      oldValues?: Record<string, unknown>;
      newValues?: Record<string, unknown>;
      changedFields?: string[];
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

## Examples

### Audit all tables

```ts
const auditLogger = createAuditLogger(db, {
  tables: "*",
  excludeFields: ["password", "token", "secret"],
});
```

### Audit specific fields only

```ts
const auditLogger = createAuditLogger(db, {
  tables: ["users", "vehicles"],
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

### Transactions

All operations inside a transaction automatically share the same `transaction_id`.

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

  // All operations logged with same transaction_id ✓
});
```

## Querying Audit Logs

```ts
import { auditLogs } from "wr-audit-logger";
import { eq, desc } from "drizzle-orm";

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

- [x] Phase 1 — Manual audit logging
- [x] Phase 2 — Automatic interception (current)
- [ ] Phase 3 — Async / batched writes
- [ ] Phase 4 — ORM adapters (Prisma, TypeORM)
- [ ] Phase 5 — Restore / rollback helpers
- [ ] Phase 6 — PostgreSQL triggers (opt-in)

## Contributing

Contributions are welcome! Please open an issue or PR.

## License

ISC
