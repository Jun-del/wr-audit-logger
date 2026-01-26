# audit-logger

Automatic audit logging for Drizzle ORM and PostgreSQL. Track who changed what and when with minimal code changes.

## Features

- 🔍 **Automatic audit logging** for INSERT, UPDATE, and DELETE operations
- 🎯 **Configurable** - choose which tables and fields to audit
- 🔒 **Type-safe** - Full TypeScript support
- ⚡ **Minimal overhead** - Efficient logging with configurable strategies
- 🧩 **Context-aware** - Track user, IP, and custom metadata
- 🛡️ **Production-ready** - Proper error handling and transaction support

## Installation

```bash
pnpm add audit-logger
# or
npm install audit-logger
# or
yarn add audit-logger
```

## Quick Start

### 1. Set up the audit table

```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createAuditTableSQL } from "audit-logger";

const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client);

// Run once to create the audit_logs table
await db.execute(createAuditTableSQL);
```

### 2. Create an audit logger

```typescript
import { createAuditLogger } from "audit-logger";

const auditLogger = createAuditLogger(db, {
  tables: ["users", "vehicles"],
  excludeFields: ["password", "token"],
  getUserId: () => getCurrentUser()?.id,
});
```

### 3. Set context (e.g., in Express middleware)

```typescript
app.use((req, res, next) => {
  auditLogger.setContext({
    userId: req.user?.id,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });
  next();
});
```

### 4. Log your operations

```typescript
// INSERT
const [user] = await db.insert(users).values(data).returning();
await auditLogger.logInsert("users", user);

// UPDATE (need before state)
const [before] = await db.select().from(users).where(eq(users.id, id));
const [after] = await db.update(users).set(changes).where(eq(users.id, id)).returning();
await auditLogger.logUpdate("users", before, after);

// DELETE
const [deleted] = await db.delete(users).where(eq(users.id, id)).returning();
await auditLogger.logDelete("users", deleted);
```

## Configuration

```typescript
interface AuditConfig {
  // Tables to audit
  tables: string[] | "*";

  // Specific fields per table (optional)
  fields?: Record<string, string[]>;

  // Fields to exclude globally
  excludeFields?: string[];

  // Audit table name
  auditTable?: string;

  // Fail operations if audit fails
  strictMode?: boolean;

  // Get current user ID
  getUserId?: () => string | undefined | Promise<string | undefined>;

  // Get additional metadata
  getMetadata?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
}
```

## Examples

### Audit all tables

```typescript
const auditLogger = createAuditLogger(db, {
  tables: "*", // Audit everything
  excludeFields: ["password", "token", "secret"],
});
```

### Audit specific fields only

```typescript
const auditLogger = createAuditLogger(db, {
  tables: ["users", "vehicles"],
  fields: {
    users: ["id", "email", "role"], // Only track these fields
    vehicles: ["id", "make", "model", "status"],
  },
});
```

### With custom context

```typescript
await auditLogger.withContext(
  {
    userId: 'SYSTEM',
    metadata: { jobId: 'cleanup-job-123' },
  },
  async () => {
    // Operations here use this context
    const deleted = await db.delete(expiredTokens)...;
    await auditLogger.logDelete('tokens', deleted);
  }
);
```

## Querying Audit Logs

```typescript
import { auditLogs } from "audit-logger";
import { eq, desc } from "drizzle-orm";

// Get history for a specific record
const history = await db
  .select()
  .from(auditLogs)
  .where(eq(auditLogs.tableName, "users"))
  .where(eq(auditLogs.recordId, userId))
  .orderBy(desc(auditLogs.createdAt));

// Get all changes by a user
const userActivity = await db
  .select()
  .from(auditLogs)
  .where(eq(auditLogs.userId, userId))
  .orderBy(desc(auditLogs.createdAt))
  .limit(100);
```

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Run tests with UI
pnpm test:ui

# Build
pnpm build

# Lint
pnpm lint

# Format
pnpm format
```

## Roadmap

- [x] Phase 1: MVP with manual logging
- [ ] Phase 2: Automatic interception via Drizzle hooks
- [ ] Phase 3: Async/batch logging for performance
- [ ] Phase 4: Support for other ORMs (Prisma, TypeORM)
- [ ] Phase 5: Restore/rollback utilities
- [ ] Phase 6: PostgreSQL trigger generation

## Contributing

Contributions are welcome! Please open an issue or PR.

## License

ISC
