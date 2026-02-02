# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-02-02

### Added

#### Core Features

- **Automatic audit logging** - No manual `logInsert/logUpdate/logDelete` calls needed
- **Auto-injected `.returning()`** - Automatically captures data for INSERT/UPDATE/DELETE operations
- **Context management** - Track user, IP, user agent, and metadata across async operations
- **Transaction support** - Automatically groups operations with shared `transaction_id`
- **Async batch mode** - Queue and write audit logs in batches for better performance
- **Custom writer support** - Use your own audit table schema or external storage
- **Batched custom writers** - Custom writers with built-in batching support
- **Flexible field filtering** - Control exactly which fields are audited per table
- **Generic logging** - Support for custom actions like READ, EXPORT, etc.

#### Configuration Options

- `tables` - Specify which tables to audit (or use `"*"` for all)
- `fields` - Define specific fields to track per table
- `excludeFields` - Globally exclude sensitive fields (default: password, token, secret, apiKey)
- `captureOldValues` - Toggle capturing "before" state for UPDATE operations (default: false)
- `strictMode` - Fail operations if audit logging fails (default: false)
- `batch` - Configure async batching for better performance
  - `batchSize` - Max logs per batch (default: 100)
  - `flushInterval` - Auto-flush interval in ms (default: 1000)
  - `waitForWrite` - Wait for writes to complete (default: false)
- `customWriter` - Provide custom audit log writer function
- `getUserId` - Function to resolve current user ID
- `getMetadata` - Function to resolve additional metadata

#### API Methods

- `createAuditLogger(db, config)` - Create audit logger and get wrapped db
- `setContext(context)` - Set audit context for current async scope
- `withContext(context, fn)` - Run function with specific audit context
- `log(entry)` - Manually log custom actions (READ, EXPORT, etc.)
- `flush()` - Manually flush pending batch logs
- `shutdown()` - Gracefully shutdown and flush all pending logs
- `getStats()` - Get batch writer statistics

#### Utilities

- `initializeAuditLogging(db)` - Initialize audit table
- `checkAuditSetup(db)` - Verify audit system is ready
- `getAuditStats(db)` - Get comprehensive audit statistics
- `createAuditTableSQL` - SQL migration for audit_logs table

### Changed

- DELETE operations now always log using auto-injected `.returning()` (no configuration needed)
- Removed `captureDeletedValues` config option (DELETE always logs)
- Improved performance: DELETE operations reduced from 3 queries to 2 queries (33% faster)

### Fixed

- **Race condition** in batch writer when queueing during flush
- **BigInt serialization** errors in JSON.stringify for primary key extraction
- **Circular reference** handling in record serialization
- **Error swallowing** - All errors are now properly logged
- **Queue consistency** - Correct queue size during concurrent operations
- **Unhandled promise rejections** - All async operations have proper error handlers
- **Memory leaks** - Proper cleanup of event listeners on shutdown

### Performance

- **Batch mode**: 2-5x faster for bulk operations
- **Auto-returning**: 33% fewer queries for DELETE operations
- **Optional old values**: Skip SELECT before UPDATE when not needed

### Documentation

- Comprehensive README with examples
- Migration guide from manual to automatic mode
- Performance characteristics documentation
- Troubleshooting guide
- API reference with JSDoc
- Example code for common scenarios

### Breaking Changes

- Removed `captureDeletedValues` configuration option
  - Migration: Simply remove this option from your config
  - DELETE operations now always log (better default)
  - Performance improved from 3 to 2 queries per delete

[0.1.0]: https://github.com/Jun-del/wr-audit-log/releases/tag/v0.1.0
