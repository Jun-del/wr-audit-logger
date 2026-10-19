# Troubleshooting

## Installation and setup

### Package or peer dependency not found

Install the package, Drizzle ORM, and the driver used by your application.

```bash
pnpm add wr-audit-logger drizzle-orm postgres
```

For node-postgres, install pg instead of postgres:

```bash
pnpm add wr-audit-logger drizzle-orm pg
```

### The audit table does not exist

Run the initializer once:

```ts
import { initializeAuditLogging } from "wr-audit-logger";

await initializeAuditLogging(db);
```

For a custom table name, pass tableName and the same column map used by the
logger.

### A migration fails

Inspect the current table before changing it:

```sql
\d audit_logs
```

Apply a migration that adds or changes the missing column. Do not drop
audit_logs in production unless you have exported the data and accepted the
loss. The initializer creates the table and indexes, but it is not a general
schema migration tool.

### Permission denied

Grant the application role access to the audit table and its sequence:

```sql
GRANT INSERT, SELECT ON audit_logs TO your_app_user;
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO your_app_user;
```

Use the sequence name that belongs to your custom table and ID column.

## Runtime issues

### No audit logs are created

Check both conditions:

1. Use the wrapped database.

```ts
const { db: auditedDb } = auditLogger;
await auditedDb.insert(users).values(data);
```

The original db bypasses the interceptor.

2. Add the table to the logger configuration.

```ts
const auditLogger = createAuditLogger(db, {
  tables: { users: { primaryKey: "id" } },
});
```

The logger ignores mutations on tables that are not in tables.

### Return values are different

The wrapper adds RETURNING when an INSERT, UPDATE, or DELETE query does not
have one. The result can therefore contain rows instead of the driver's
usual mutation metadata.

An explicit returning() call works. A selected return shape also works. The
logger reads the full row for audit capture and returns the selected fields to
your code.

### Context fields are null

Set context before the database operation:

```ts
auditLogger.setContext({
  userId: getCurrentUser()?.id,
  ipAddress: req.ip,
  userAgent: req.headers["user-agent"],
});
```

You can also provide getUserId or use withContext for jobs and scripts.

### Transaction IDs are missing or different

Use the wrapped transaction passed to the callback:

```ts
await auditedDb.transaction(async (tx) => {
  await tx.insert(users).values(data);
});
```

Do not use the original db inside the callback. Operations in the wrapped
transaction share a generated transaction_id. Audit inserts use the logger's
database connection, not tx, so they do not roll back with the transaction.

## Performance issues

### Mutations are slow

Measure the operation and the audit write separately if possible. Then check:

- updateValuesMode is "changed", which adds a before-state SELECT when a WHERE
  clause is available
- batch mode is enabled for audit writes
- the audit table has its expected indexes
- the database connection and network latency

Use full update mode when the after row is enough:

```ts
const auditLogger = createAuditLogger(db, {
  tables: { users: { primaryKey: "id" } },
  updateValuesMode: "full",
});
```

Use fields or excludeFields to reduce the audit payload.

### The queue grows

Batch mode has a bounded queue. maxQueueSize defaults to 10,000. Once the
limit is reached, adding logs fails. Non-strict mode reports the failure
through logError and lets the application mutation continue. strictMode
propagates the failure.

Check the queue and lower the flush interval or increase the batch size only
if the database can handle larger writes:

```ts
const stats = auditLogger.getStats();
console.log(stats?.queueSize);
```

Also check database write errors. A larger queue only delays the failure and
uses more memory.

### Memory use grows

The queue stores pending audit entries, including their values and metadata.
Reduce payload size with fields and excludeFields. Flush during bulk work and
call shutdown during process termination.

Process large imports in chunks:

```ts
const chunkSize = 1000;

for (let i = 0; i < data.length; i += chunkSize) {
  const chunk = data.slice(i, i + chunkSize);
  await Promise.all(chunk.map((item) => auditedDb.insert(users).values(item)));
  await auditLogger.flush();
}
```

This is chunked processing, not streaming. The full data array is still in
memory.

## Data issues

### Sensitive fields appear in values

Exclude them when creating the logger:

```ts
const auditLogger = createAuditLogger(db, {
  tables: { users: { primaryKey: "id" } },
  excludeFields: ["password", "token", "secret", "apiKey"],
});
```

Review custom fields and metadata too. The logger does not know which values
are sensitive unless you configure them.

### UPDATE logs contain full rows

Set updateValuesMode to "changed":

```ts
const auditLogger = createAuditLogger(db, {
  tables: { users: { primaryKey: "id" } },
  updateValuesMode: "changed",
});
```

If the logger cannot capture the before state, it records the returned after
row as a fallback.

### record_id is wrong

Set the primary key field for every audited table. For a composite key, pass
an array:

```ts
const auditLogger = createAuditLogger(db, {
  tables: {
    electricity_bill: { primaryKey: "jobid" },
    bill_line: { primaryKey: ["billId", "lineId"] },
  },
});
```

## Integration issues

### Raw SQL is not audited

The interceptor handles Drizzle INSERT, UPDATE, and DELETE query builders. It
does not inspect raw SQL. Add a manual log after a statement that returns the
affected rows:

```ts
import { sql } from "drizzle-orm";

const result = await auditedDb.execute(sql`INSERT INTO users (...) VALUES (...) RETURNING *`);
await auditLogger.logInsert("users", result.rows);
```

The table must be configured in tables.

### Another ORM is not audited

The package only intercepts Drizzle. With another ORM, write the change first
and then call the manual logging method with the affected record.

### The wrapped database has a type error

The wrapper returns the same type as the database you pass in. If table names
or columns are rejected, check that the database was created with your tables:
`relations` on drizzle-orm 1.x, `schema` on 0.45.

```ts
const db = drizzle({ client, relations }); // 1.x
const db = drizzle({ client, schema }); // 0.45

const { db: auditedDb } = createAuditLogger(db, config); // same type as db
```

## Production checks

Confirm that DATABASE_URL is set and that the application role can write to
the audit table.

If the application needs a connection pool with node-postgres, create a Pool
instead of a single Client:

```ts
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
});
```

Configure SQL and network timeouts in the database driver or database server.
flushInterval controls when queued audit logs are flushed. It is not a SQL
timeout.

## Errors and debugging

After shutdown, the batch writer rejects new audit entries. Create a new
logger if the process needs to resume writing.

Set AUDIT_DEBUG before starting the process:

```bash
AUDIT_DEBUG=true node app.js
```

The debug output shows intercepted operations, table detection, RETURNING
injection, and audit-log creation.

Check whether the audit table exists:

```ts
import { checkAuditSetup } from "wr-audit-logger";

const ready = await checkAuditSetup(db);
console.log(ready);
```

Inspect recent rows with the exported audit table:

```ts
import { desc } from "drizzle-orm";
import { auditLogs } from "wr-audit-logger";

const logs = await db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(10);
```

For custom table names or column maps, use your own Drizzle table definition.

## Getting help

When opening an issue, include the Node version, database version, smallest
reproduction, error message, and relevant debug output. Examples are in
examples/.

Issues: [github.com/Jun-del/wr-audit-logger](https://github.com/Jun-del/wr-audit-logger/issues)
