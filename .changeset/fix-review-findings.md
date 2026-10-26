---
"wr-audit-logger": minor
---

Fix several correctness bugs in automatic auditing.

- A failed query (e.g. a unique-constraint error) on an audited table now rejects normally. Previously `await` never settled and Node reported an unhandled rejection.
- `.execute()` and prepared statements (`.prepare().execute()`) are now audited. Previously `.execute()` threw after the change was committed (node-postgres) or skipped the audit (postgres-js).
- Partial selections such as `.returning({ userId: users.id })` return the selected fields. Previously renamed fields came back empty.
- Without `.returning()`, the result keeps the affected row count as `rowCount` and `count`.
- Audit rows for statements inside `db.transaction()` are written on the transaction, so they roll back with it; this also removes a deadlock with single-connection pools. Non-strict mode isolates the audit write in a savepoint. With `updateValuesMode: "changed"`, the before-state rows are locked with `FOR UPDATE`.
- Custom writers inside a transaction run after commit, and are skipped on rollback.
- An UPDATE that only changes an excluded field (e.g. `password`) is now logged. With a locked before-state it stores `"[REDACTED]"` for the changed field; full after-row captures omit excluded fields.
- In non-strict mode, a failure while building the audit log (e.g. a missing primary key column) no longer fails the user's query.
- Custom writers now receive `getUserId()` / `getMetadata()` values. Batched custom writers no longer drop the IP address, user agent, or metadata of logs that share a user and transaction ID.
- `checkAuditSetup` and `getAuditStats` work with drivers that return row arrays (postgres-js).
- `initializeAuditLogging` no longer prints to the console. The setup SQL only runs `ALTER TABLE` and `CREATE INDEX` when something is missing, instead of locking the audit table on every run, and it quotes identifiers consistently.

**Behavior changes:**

- Batch mode no longer installs SIGINT/SIGTERM handlers (which stopped Ctrl+C and SIGTERM from exiting the process), and its timer no longer keeps the process alive. Queued logs are flushed on `beforeExit`; call `shutdown()` from your own SIGTERM handler.
- An explicit `userId` from `setContext`/`withContext` now takes precedence over `getUserId()`.
- Automatic UPDATEs outside audited transactions now store full after-rows, even with `updateValuesMode: "changed"`. This prevents stale before-state snapshots from hiding concurrent changes. Locked field diffs require an audited transaction; field filters and exclusions still apply. Updates that set existing values are also logged outside transactions.
- Partial RETURNING selections use collision-free audit keys, so user aliases such as `__audit__id` cannot replace the captured primary key or inject audit fields.
- A custom-writer failure after a successful transaction commit now throws `AuditDeliveryError` in strict mode (or is reported to `logError` in non-strict mode), with `committed: true`, a transaction ID, and the original cause. Do not retry the business transaction. Asynchronous batch failures are still reported through `logError` after the caller returns.
- The `BatchAuditWriterStats` and `BatchedCustomWriterStats` types are deprecated aliases of `BatchWriterStats`.
