# Performance

This page describes the queries the logger adds and how its queue behaves. It
does not promise fixed latency or throughput. Database driver, network
distance, row size, indexes, and concurrent work all affect those numbers.

## Queries per mutation

The counts below describe immediate mode with one affected row. A bulk
mutation still uses one audit insert for all returned rows.

| Mutation                                |   Queries |
| --------------------------------------- | --------: |
| INSERT                                  |         2 |
| UPDATE with updateValuesMode: "changed" | Usually 3 |
| UPDATE with updateValuesMode: "full"    |         2 |
| DELETE                                  |         2 |

INSERT and DELETE use the mutation with RETURNING, followed by one audit
insert.

With updateValuesMode: "changed", the logger first reads the matching rows,
then runs the UPDATE with RETURNING, then writes the audit rows. If it cannot
read a WHERE clause, it skips the before-state query and records the returned
after rows instead.

With updateValuesMode: "full", the logger stores the returned after rows and
does not run the extra SELECT.

The wrapper adds RETURNING when the query does not have one. An explicit
returning() call still works. For a selected return shape, the logger gets the
full row for audit capture and returns the selected fields to the caller.

## Batch mode

Batch mode changes how the logger writes audit rows. It does not combine the
application's INSERT, UPDATE, or DELETE queries.

Defaults:

- batchSize: 100 logs
- maxQueueSize: 10,000 logs
- flushInterval: 1,000 milliseconds
- waitForWrite: false

The standard writer sends queued logs in one database insert per flush. A
custom writer receives the queued logs as one array per flush.

With waitForWrite: false, the mutation returns after the logger queues the
audit entry. A later flush writes it. Call flush() before a handoff or
shutdown() during process termination so queued entries are written.

With waitForWrite: true, each logging call waits for queued entries to flush.
This gives the caller a stronger delivery guarantee, but it can reduce the
benefit of batching. strictMode: true also waits and propagates audit write
failures to the mutation.

When the queue reaches maxQueueSize, adding more logs fails. In non-strict
mode the logger reports the error through logError and lets the application
operation continue. In strict mode the failure reaches the caller.

Example:

```ts
const auditLogger = createAuditLogger(db, {
  tables: { users: { primaryKey: "id" } },
  batch: {
    batchSize: 100,
    maxQueueSize: 10_000,
    flushInterval: 1000,
    waitForWrite: false,
  },
});
```

## Choosing a configuration

Use updateValuesMode: "changed" when the audit record must show which fields
changed. It adds a before-state query when the logger can extract a WHERE
clause.

Use updateValuesMode: "full" when the after row is enough. It avoids that
extra query but stores more data.

Use fields to keep only named columns. Use excludeFields for values such as
passwords and tokens. Filtering happens before the logger serializes the audit
payload.

Start with immediate mode. Add batching after measuring the application with
the same database, driver, row sizes, and concurrency it will use in
production. Tune batchSize and flushInterval against queue size and write
errors. A larger batch also holds more data in memory.

## Database load

Immediate mode adds one audit insert for each audited mutation. Batch mode
reduces the number of audit insert statements, but the application still
sends one mutation query per operation.

The default audit table has indexes for:

```sql
CREATE INDEX idx_audit_logs_table_record
  ON audit_logs(table_name, record_id);
CREATE INDEX idx_audit_logs_user_id
  ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_created_at
  ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_action
  ON audit_logs(action);
CREATE INDEX idx_audit_logs_table_created
  ON audit_logs(table_name, created_at DESC);
```

Indexes speed up the lookup patterns they cover and add work to each audit
insert. Check the query plan and table size in your own database before adding
more indexes.

## Monitoring

getStats() returns values only when batch mode is enabled. It reports the
current queue size, whether a write is active, and whether shutdown has
started.

```ts
const stats = auditLogger.getStats();

if (stats) {
  console.log({
    queueSize: stats.queueSize,
    isWriting: stats.isWriting,
    isShuttingDown: stats.isShuttingDown,
  });
}
```

Alert on a queue that stays near maxQueueSize, repeated write errors, or a
writer that remains active longer than the application's normal database
latency. The package does not expose a failed-flush counter, so count errors
in the logError hook if you need one.

## Bulk work

Flush and shut down the logger after an import:

```ts
for (const item of items) {
  await auditedDb.insert(users).values(item);
}

await auditLogger.flush();
await auditLogger.shutdown();
```

For large imports, process input in chunks. The queue still stores serialized
audit entries until each flush completes.

## Measuring your deployment

Measure at least these cases:

- INSERT, UPDATE, and DELETE
- both update value modes
- immediate mode and batch mode
- waitForWrite set to both values
- small and large audit payloads
- normal and high queue depth

Record p50 and p95 latency, audit write errors, queue size, and memory use.
Do not copy a throughput number from another deployment. It will not describe
yours.
