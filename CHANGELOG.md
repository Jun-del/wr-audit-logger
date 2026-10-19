# wr-audit-logger

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
