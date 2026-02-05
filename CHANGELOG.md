# wr-audit-logger

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
