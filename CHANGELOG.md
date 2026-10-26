# wr-audit-logger

## 0.5.0

### Minor Changes

- 09b8add: Fix package exports so CommonJS consumers get CommonJS types. `require` now resolves `dist/index.d.cts` and `import` resolves `dist/index.d.mts`; previously both used the ESM declarations, which TypeScript flagged as "masquerading as ESM" under `node16`/`nodenext` resolution. `wr-audit-logger/package.json` is now exported.

  Remove the optional `pg` peer dependency. The library never imports `pg`; install whichever Postgres driver your drizzle setup uses.

  **Breaking:** the default export is removed. Use the named export instead:

  ```ts
  // before
  import createAuditLogger from "wr-audit-logger";
  // after
  import { createAuditLogger } from "wr-audit-logger";
  ```

- 09b8add: Fix several correctness bugs in automatic auditing.

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

## 0.4.0

### Minor Changes

- cb049f0: Support drizzle-orm 1.x (`^1.0.0-rc.4`) alongside 0.45. On 1.x, table names and columns are type-checked against the tables in `relations`. `createAuditLogger` now infers types from the database instance, and its returned `db` has the same type as the one passed in.

### Patch Changes

- afe8b52: Require drizzle-orm `^0.45.2` as a peer dependency. Earlier 0.45.x releases have a SQL injection advisory for improperly escaped SQL identifiers.

## 0.3.1

### Patch Changes

- e760e24: Type tables config so each table primaryKey only accepts that table's schema column names.

## 0.3.0

### Minor Changes

- 6341ff0: Improve audit logging stability and test reliability: fix primary key serialization edge cases, clean interceptor/error handling, and streamline test scripts (unit default, integration opt-in).

## 0.2.3

### Patch Changes

- 1172f5e: Augment partial returning({ ... }) to full returning for audit; preserve user result shape.

## 0.2.2

### Patch Changes

- 13ed03c: Returning audit improvements

## 0.2.1

### Patch Changes

- ed73527: Fix batched custom writer waitForWrite behavior; add coverage for update returning projection

## 0.2.0

### Minor Changes

- f2a8fb4: add sanitized error logging hook
  cap batch queue size via maxQueueSize
  harden metadata merge vs proto pollution
  add/adjust tests

## 0.1.3

### Patch Changes

- 8384917: improve interceptor typings and batch error tracking

## 0.1.2

### Patch Changes

- a3c0995: type-safe audited db keeps Drizzle schema

## 0.1.1

### Patch Changes

- Preserve Drizzle schema types in audited db.
- 4addcb8: fix: store null metadata when empty

## 0.1.0

### Minor Changes

- f08a171: Release
