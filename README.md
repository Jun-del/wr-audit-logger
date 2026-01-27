# audit-logger

Automatic audit logging for **Drizzle ORM + PostgreSQL**.
Track who changed what and when — **without manual logging calls**.

## Installation

```bash
pnpm add audit-logger
# or
npm install audit-logger
# or
yarn add audit-logger
```

## Quick Start

### 1. Create the audit table

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createAuditTableSQL } from "audit-logger";

const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client);

// Run once to create the audit_logs table
await db.execute(createAuditTableSQL);
```

### 2. Create an audit logger (wraps your db)

```ts
import { createAuditLogger } from "audit-logger";

const auditLogger = createAuditLogger(db, {
  tables: ["users", "vehicles"],
  excludeFields: ["password", "token"],
  getUserId: () = getCurrentUser()?.id,
});

// IMPORTANT: use the wrapped db
const { db: auditedDb } = auditLogger;
```

### 3. Set context (example: Express middleware)

```ts
app.use((req, res, next) = {
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

### 4. Use the database normally — auditing is automatic

```ts
// INSERT
const [user] = await auditedDb.insert(users).values(data).returning();

// UPDATE (before/after captured automatically)
const [updated] = await auditedDb
  .update(users)
  .set({ name: "New Name" })
  .where(eq(users.id, userId))
  .returning();

// DELETE
await auditedDb.delete(users).where(eq(users.id, userId));
```

No manual audit calls.
No extra code per operation.

## Configuration

```ts
interface AuditConfig {
  // Tables to audit
  tables: string[] | "*";

  // Specific fields per table (optional)
  fields?: Record<string, string[];

  // Fields to exclude globally
  excludeFields?: string[];

  // Audit table name (default: audit_logs)
  auditTable?: string;

  // Fail the DB operation if audit logging fails
  strictMode?: boolean;

  // Resolve current user id
  getUserId?: () = string | undefined | Promise<string | undefined;

  // Resolve additional metadata
  getMetadata?: () = Record<string, unknown | Promise<Record<string, unknown;
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
  async () = {
    await auditedDb
      .delete(expiredTokens)
      .where(lt(expiredTokens.expiresAt, new Date()));
  }
);
```

All operations inside the callback inherit this context.

### Transactions

All operations inside a transaction automatically share the same `transaction_id`.

```ts
await auditedDb.transaction(async (tx) = {
  const [user] = await tx
    .insert(users)
    .values(userData)
    .returning();

  const [post] = await tx
    .insert(posts)
    .values({ ...postData, userId: user.id })
    .returning();

  // Both audit entries share the same transaction_id
});
```

## Querying Audit Logs

```ts
import { auditLogs } from "audit-logger";
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

## Development

```bash
pnpm install
pnpm test
pnpm test:ui
pnpm build
pnpm lint
pnpm format
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
