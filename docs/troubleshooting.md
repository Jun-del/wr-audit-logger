# Troubleshooting Guide

Common issues and solutions for wr-audit-logger.

## Table of Contents

- [Installation Issues](#installation-issues)
- [Setup Issues](#setup-issues)
- [Runtime Issues](#runtime-issues)
- [Performance Issues](#performance-issues)
- [Data Issues](#data-issues)
- [Integration Issues](#integration-issues)

## Installation Issues

### Problem: Package not found

```bash
npm ERR! 404 Not Found - GET https://registry.npmjs.org/wr-audit-logger
```

**Solution:**

```bash
# Use correct package name
pnpm add wr-audit-logger

# Or check if published
npm view wr-audit-logger
```

### Problem: Peer dependency warnings

```bash
npm WARN wr-audit-logger@1.0.0 requires a peer of drizzle-orm@^0.45.1
```

**Solution:**

```bash
# Install required peer dependencies
pnpm add drizzle-orm@^0.45.1 pg@^8.17.2
```

## Setup Issues

### Problem: Audit table doesn't exist

```
Error: relation "audit_logs" does not exist
```

**Solution:**

```typescript
import { initializeAuditLogging } from "wr-audit-logger";

// Run this once to create the table
await initializeAuditLogging(db);
```

Or run the SQL manually:

```typescript
import { createAuditTableSQL, createAuditTableSQLFor } from "wr-audit-logger";

await db.execute(createAuditTableSQL); // default table name
// or custom table name
await db.execute(createAuditTableSQLFor("my_audit_logs"));
// or custom column names
await db.execute(
  createAuditTableSQLFor("my_audit_logs", {
    columnMap: { userId: "actor_id", tableName: "resource" },
  }),
);
```

### Problem: Migration fails

```
Error: column "values" does not exist
```

**Solution:**

```sql
-- Check current table structure
\d audit_logs

-- Drop and recreate (CAUTION: This deletes data!)
DROP TABLE IF EXISTS audit_logs CASCADE;

-- Then reinitialize
```

```typescript
await initializeAuditLogging(db);
```

### Problem: Permission denied

```
Error: permission denied for table audit_logs
```

**Solution:**

```sql
-- Grant permissions to your app user
GRANT INSERT, SELECT ON audit_logs TO your_app_user;
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO your_app_user;
```

## Runtime Issues

### Problem: Operations not being audited

**Symptom:** Database operations complete, but no audit logs are created.

**Checklist:**

1. Are you using the wrapped `db`?

   ```typescript
   const { db: auditedDb } = auditLogger;
   await auditedDb.insert(users).values(data); // ✓
   // NOT:
   await db.insert(users).values(data); // ✗
   ```

2. Is the table in your config?

   ```typescript
   const auditLogger = createAuditLogger(db, {
     tables: ["users"], // Must include the table!
   });
   ```

3. Check `shouldAudit` method:
   ```typescript
   console.log(auditLogger.shouldAudit("users")); // Should be true
   ```

### Problem: `.returning()` called explicitly throws error

**Symptom:**

```
Error: .returning() has already been called
```

**Explanation:**
Auto-injection adds `.returning()` automatically. If you call it explicitly AND it's auto-injected, you'll get an error.

**Solution:**
Don't call `.returning()` explicitly. The wrapper handles it:

```typescript
// ✗ Don't do this:
await auditedDb.insert(users).values(data).returning();

// ✓ Do this:
await auditedDb.insert(users).values(data);

// ✓ Or this (if you need the data):
const result = await auditedDb.insert(users).values(data);
// result will have the data from auto-injected .returning()
```

### Problem: Context not being captured

**Symptom:** `userId`, `ipAddress` are `null` in audit logs.

**Solution 1: Set context**

```typescript
auditLogger.setContext({
  userId: getCurrentUser().id,
  ipAddress: req.ip,
  userAgent: req.headers["user-agent"],
});
```

**Solution 2: Use middleware**

```typescript
// Express
app.use((req, res, next) => {
  auditLogger.setContext({
    userId: req.user?.id,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });
  next();
});
```

**Solution 3: Use `getUserId` config**

```typescript
const auditLogger = createAuditLogger(db, {
  tables: ["users"],
  getUserId: () => {
    // Return current user ID from your auth system
    return getCurrentUser()?.id;
  },
});
```

### Problem: Transactions don't share transaction ID

**Symptom:** Operations in same transaction have different `transaction_id`.

**Solution:**
Make sure you're using the wrapped `tx` inside the transaction callback:

```typescript
// ✗ Wrong:
await auditedDb.transaction(async (tx) => {
  // Using original 'db' - won't work!
  await db.insert(users).values(data);
});

// ✓ Correct:
await auditedDb.transaction(async (tx) => {
  // Using wrapped 'tx' from callback
  await tx.insert(users).values(data);
});
```

## Performance Issues

### Problem: Slow INSERT/UPDATE/DELETE operations

**Symptom:** Operations take 50ms+ each.

**Diagnosis:**

```typescript
const start = Date.now();
await auditedDb.insert(users).values(data);
console.log(`Took: ${Date.now() - start}ms`);
```

**Solutions:**

1. **Enable batch mode:**

   ```typescript
   const auditLogger = createAuditLogger(db, {
     tables: ["users"],
     batch: {
       batchSize: 100,
       flushInterval: 1000,
       waitForWrite: false, // Async mode
     },
   });
   ```

2. **Use full update mode if changed fields not needed:**

   ```typescript
   const auditLogger = createAuditLogger(db, {
     tables: ["users"],
     updateValuesMode: "full", // Skip SELECT before UPDATE
   });
   ```

3. **Audit specific fields only:**
   ```typescript
   const auditLogger = createAuditLogger(db, {
     tables: ["users"],
     fields: {
       users: ["id", "email", "role"], // Only audit these fields
     },
   });
   ```

### Problem: Queue growing unbounded

**Symptom:**

```typescript
const stats = auditLogger.getStats();
console.log(stats.queueSize); // Growing rapidly
```

**Solutions:**

1. **Increase batch size:**

   ```typescript
   batch: {
     batchSize: 200,  // Larger batches
   }
   ```

2. **Decrease flush interval:**

   ```typescript
   batch: {
     flushInterval: 500,  // Flush more frequently (ms)
   }
   ```

3. **Check database performance:**
   ```sql
   -- Check for long-running queries
   SELECT pid, now() - query_start as duration, query
   FROM pg_stat_activity
   WHERE state = 'active'
   ORDER BY duration DESC;
   ```

### Problem: High memory usage

**Symptom:** Node.js process memory keeps growing.

**Diagnosis:**

```typescript
const stats = auditLogger.getStats();
console.log(`Queue size: ${stats.queueSize}`);
// Large queue = high memory
```

**Solutions:**

1. **Reduce batch size:**

   ```typescript
   batch: {
     batchSize: 50,  // Smaller batches
   }
   ```

2. **Flush manually in bulk operations:**

   ```typescript
   for (let i = 0; i < 10000; i++) {
     await auditedDb.insert(users).values(data[i]);

     if (i % 1000 === 0) {
       await auditLogger.flush(); // Manual flush every 1000
     }
   }
   ```

3. **Use streaming for huge imports:**
   ```typescript
   // Process in chunks
   const CHUNK_SIZE = 1000;
   for (let i = 0; i < data.length; i += CHUNK_SIZE) {
     const chunk = data.slice(i, i + CHUNK_SIZE);
     await Promise.all(chunk.map((item) => auditedDb.insert(users).values(item)));
     await auditLogger.flush();
   }
   ```

## Data Issues

### Problem: Sensitive data in audit logs

**Symptom:** Password, tokens appear in `values`.

**Solution:**

```typescript
const auditLogger = createAuditLogger(db, {
  tables: ["users"],
  excludeFields: ["password", "token", "secret", "apiKey"],
});
```

### Problem: UPDATE logs store full rows

**Symptom:** `values` includes all columns instead of only changed fields.

**Explanation:** `updateValuesMode` is set to `"full"`.

**Solution:**

```typescript
const auditLogger = createAuditLogger(db, {
  tables: ["users"],
  updateValuesMode: "changed", // Store only changed fields
});
```

### Problem: Missing `recordId`

**Symptom:** `record_id` is `null` or incorrect.

**Diagnosis:**
The library tries to extract the primary key from these fields (in order):

1. `id`
2. `{tableName}_id`
3. `uuid`
4. `pk`
5. Any field ending in `id` or `Id`

**Solution 1: Use standard naming**

```typescript
// ✓ These work:
{
  id: 1;
}
{
  userId: 1;
}
{
  uuid: "...";
}

// ✗ These don't:
{
  identifier: 1;
}
{
  recordNumber: 1;
}
```

**Solution 2: Custom serialization**
Modify `extractPrimaryKey` in `src/utils/primary-key.ts` for your schema.

### Problem: No changed fields in UPDATE logs

**Symptom:** UPDATE logs show full rows; you can't tell which fields changed.

**Explanation:** This happens when `updateValuesMode: "full"`.

**Solution:**

```typescript
const auditLogger = createAuditLogger(db, {
  tables: ["users"],
  updateValuesMode: "changed", // Store only changed fields
});
```

## Integration Issues

### Problem: Doesn't work with raw SQL

**Symptom:**

```typescript
await auditedDb.execute(sql`INSERT INTO users ...`);
// No audit log created
```

**Explanation:**
Auto-auditing only works with Drizzle's query builders (insert, update, delete).

**Solution:**
Use manual logging for raw SQL:

```typescript
const result = await auditedDb.execute(sql`INSERT INTO users ... RETURNING *`);
await auditLogger.logInsert("users", result.rows);
```

### Problem: Doesn't work with ORMs other than Drizzle

**Symptom:**

```typescript
// Using Prisma, TypeORM, etc.
await prisma.user.create({ data: { ... } });
// No audit log
```

**Explanation:**
This library is designed specifically for Drizzle ORM.

**Solution:**

1. Use manual logging:

   ```typescript
   const user = await prisma.user.create({ data });
   await auditLogger.logInsert("users", user);
   ```

2. Or switch to Drizzle ORM

### Problem: TypeScript errors with wrapped db

**Symptom:**

```typescript
const { db: auditedDb } = auditLogger;
// Type error: Property 'insert' does not exist
```

**Solution:**
The wrapped db should maintain the same type. If not:

```typescript
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

const { db } = auditLogger;
const auditedDb: PostgresJsDatabase<typeof schema> = db;
```

### Problem: Works in development, fails in production

**Checklist:**

1. **Environment variables:**

   ```typescript
   // Make sure DATABASE_URL is set in production
   console.log(process.env.DATABASE_URL);
   ```

2. **Database permissions:**

   ```sql
   -- Check if app user has INSERT on audit_logs
   SELECT grantee, privilege_type
   FROM information_schema.role_table_grants
   WHERE table_name = 'audit_logs';
   ```

3. **Connection pool:**

   ```typescript
   // Production might need larger pool
   const client = new Client({
     connectionString: process.env.DATABASE_URL,
     max: 20, // Increase pool size
   });
   ```

4. **Timeouts:**
   ```typescript
   // Production might have stricter timeouts
   batch: {
     flushInterval: 500,  // Flush more frequently
   }
   ```

## Error Messages

### "BatchAuditWriter is shutting down"

**Cause:** Trying to queue logs after calling `shutdown()`.

**Solution:**

```typescript
// Don't use auditedDb after shutdown
await auditLogger.shutdown();
// await auditedDb.insert(...);  // ✗ Will fail

// If you need to use it again, create a new instance
```

### "Cannot read property 'returning' of undefined"

**Cause:** Query builder is undefined or malformed.

**Solution:**

```typescript
// ✗ Wrong:
await auditedDb.insert();

// ✓ Correct:
await auditedDb.insert(users).values(data);
```

### "relation 'audit_logs' does not exist"

**Solution:**

```typescript
await initializeAuditLogging(db);
```

## Debugging

### Enable debug logging

Set environment variable:

```bash
export AUDIT_DEBUG=true
```

```typescript
// You'll see detailed logs like:
// [AUDIT DEBUG] Intercepting INSERT on users via then
// [AUDIT DEBUG] Auto-injecting .returning() for INSERT on users
// [AUDIT DEBUG] Logging 1 INSERT operations
```

### Check audit setup

```typescript
import { checkAuditSetup } from "wr-audit-logger";

const isSetup = await checkAuditSetup(db);
console.log("Audit system ready:", isSetup);
```

### Inspect audit logs

```typescript
import { auditLogs } from "wr-audit-logger";
import { desc } from "drizzle-orm";

const logs = await db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(10);

console.table(logs);
```

### Monitor queue

```typescript
setInterval(() => {
  const stats = auditLogger.getStats();
  if (stats) {
    console.log(`Queue: ${stats.queueSize}, Writing: ${stats.isWriting}`);
  }
}, 5000);
```

## Getting Help

If you're still stuck:

1. **Check Examples:** Review [examples/](./examples/)
2. **Check Issues:** Search [GitHub issues](https://github.com/Jun-del/wr-audit-log/issues)
3. **Enable Debug:** Set `AUDIT_DEBUG=true`
4. **Create Issue:** Include:
   - Node version
   - Database version
   - Minimal reproduction code
   - Error messages
   - Debug output

## Common Gotchas

1. **Not using wrapped db** - Use `auditedDb` from `createAuditLogger`, not original `db`
2. **Calling `.returning()` explicitly** - Auto-injected, don't call manually
3. **Forgetting `updateValuesMode`** - Defaults to `"changed"`
4. **Not calling `shutdown()`** - Always shutdown gracefully
5. **Using raw SQL** - Use Drizzle query builders or manual logging
6. **Wrong transaction usage** - Use wrapped `tx` from callback
7. **Missing context** - Set context in middleware or config
8. **Sensitive fields** - Remember to exclude them via `excludeFields`
