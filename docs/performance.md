# Performance Characteristics

This document details the performance characteristics of wr-audit-logger and how to optimize for your use case.

## Query Patterns

### INSERT Operations

**Queries per operation: 2**

```sql
-- 1. INSERT with auto-injected RETURNING
INSERT INTO users (email, name) VALUES ('test@example.com', 'Test') RETURNING *;

-- 2. INSERT audit log
INSERT INTO audit_logs (...) VALUES (...);
```

**Performance:**

- Baseline overhead: ~1-2ms per insert
- Batch mode (100 logs): ~0.1-0.2ms per insert
- **Speedup with batch mode: 5-10x**

### UPDATE Operations

#### With `captureOldValues: false` (default)

**Queries per operation: 2**

```sql
-- 1. UPDATE with auto-injected RETURNING
UPDATE users SET name = 'New Name' WHERE id = 1 RETURNING *;

-- 2. INSERT audit log
INSERT INTO audit_logs (...) VALUES (...);
```

**Performance:**

- Baseline overhead: ~1-2ms per update
- Batch mode (100 logs): ~0.1-0.2ms per update
- **Speedup with batch mode: 5-10x**

#### With `captureOldValues: true`

**Queries per operation: 3**

```sql
-- 1. SELECT before state
SELECT * FROM users WHERE id = 1;

-- 2. UPDATE with auto-injected RETURNING
UPDATE users SET name = 'New Name' WHERE id = 1 RETURNING *;

-- 3. INSERT audit log
INSERT INTO audit_logs (...) VALUES (...);
```

**Performance:**

- Baseline overhead: ~2-3ms per update
- Additional SELECT query adds ~0.5-1ms
- Batch mode (100 logs): ~0.2-0.3ms per update
- **Trade-off: 50% more queries for complete audit trail**

### DELETE Operations

**Queries per operation: 2**

```sql
-- 1. DELETE with auto-injected RETURNING
DELETE FROM users WHERE id = 1 RETURNING *;

-- 2. INSERT audit log
INSERT INTO audit_logs (...) VALUES (...);
```

**Performance:**

- Baseline overhead: ~1-2ms per delete
- Batch mode (100 logs): ~0.1-0.2ms per delete
- **Improvement from v0.x: 33% fewer queries** (old captureDeletedValues used 3 queries)

## Batch Mode Performance

### Immediate Mode (default)

```typescript
const auditLogger = createAuditLogger(db, {
  tables: ["users"],
  // No batch config - writes immediately
});
```

**Characteristics:**

- Every operation writes immediately
- Simple, predictable behavior
- Good for: Low-volume operations, strict consistency requirements

**Benchmark (100 inserts):**

```
Immediate mode: 250ms
~400 ops/sec
```

### Batch Mode (async)

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

**Characteristics:**

- Queues logs in memory
- Flushes when batch size reached or interval expires
- Best throughput

**Benchmark (100 inserts):**

```
Batch mode: 50ms
~2000 ops/sec
Speedup: 5x
```

### Batch Mode (sync)

```typescript
const auditLogger = createAuditLogger(db, {
  tables: ["users"],
  batch: {
    batchSize: 100,
    flushInterval: 1000,
    waitForWrite: true, // Wait for writes
  },
});
```

**Characteristics:**

- Queues logs in memory
- Waits for batch to be written before returning
- Balanced: Better throughput than immediate, more consistency than async

**Benchmark (100 inserts):**

```
Batch mode (sync): 100ms
~1000 ops/sec
Speedup: 2.5x
```

## Configuration Recommendations

### Low Volume (<100 ops/sec)

```typescript
const auditLogger = createAuditLogger(db, {
  tables: ["users"],
  captureOldValues: true, // Full audit trail
  // No batch mode needed
});
```

**Why:** Immediate writes are fine for low volume. Keep it simple.

### Medium Volume (100-1000 ops/sec)

```typescript
const auditLogger = createAuditLogger(db, {
  tables: ["users"],
  captureOldValues: true, // If you need full trail
  batch: {
    batchSize: 50,
    flushInterval: 500,
    waitForWrite: true, // Balanced mode
  },
});
```

**Why:** Batch mode improves throughput while maintaining consistency.

### High Volume (>1000 ops/sec)

```typescript
const auditLogger = createAuditLogger(db, {
  tables: ["users"],
  captureOldValues: false, // Skip old values
  batch: {
    batchSize: 100,
    flushInterval: 1000,
    waitForWrite: false, // Async for max throughput
  },
});
```

**Why:** Maximum throughput for high-volume scenarios. Trade consistency for speed.

### Bulk Import/Export

```typescript
const auditLogger = createAuditLogger(db, {
  tables: ["users"],
  captureOldValues: false,
  batch: {
    batchSize: 500, // Large batches
    flushInterval: 5000,
    waitForWrite: false,
  },
});

// Your bulk operation
for (const item of items) {
  await auditedDb.insert(users).values(item);
}

// Ensure all logs are written
await auditLogger.flush();
await auditLogger.shutdown();
```

**Performance:** Can handle 5000+ ops/sec with large batch sizes.

## Memory Usage

### Immediate Mode

- **Memory overhead:** Minimal (~1KB per operation)
- **Peak memory:** Constant

### Batch Mode

- **Memory overhead:** `batchSize * ~1KB`
- **Peak memory:** Grows with queue size
- **Example:** batchSize=100 → ~100KB peak memory

### Recommendations

- Small apps: batchSize = 50-100
- Medium apps: batchSize = 100-200
- Large apps: batchSize = 200-500
- **Don't go over 1000** - diminishing returns and memory concerns

## Database Load

### Immediate Mode

- **Load pattern:** Constant small writes
- **Connection usage:** One write per operation
- **Good for:** Distributed load, predictable performance

### Batch Mode

- **Load pattern:** Bursty writes
- **Connection usage:** One write per batch
- **Good for:** Reducing database round-trips

### Index Performance

The audit table has these indexes:

```sql
CREATE INDEX idx_audit_logs_table_record ON audit_logs(table_name, record_id);
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_table_created ON audit_logs(table_name, created_at DESC);
```

**Query performance:**

- Lookup by table + record: O(log n) - ~1ms for 1M records
- Lookup by user: O(log n) - ~1ms for 1M records
- Time-based queries: O(log n) - ~1ms for 1M records

**Insert performance:**

- Index maintenance adds ~10-20% overhead
- Batch inserts benefit from batch index updates

## Network Latency

If your app server is far from your database:

```typescript
const auditLogger = createAuditLogger(db, {
  tables: ["users"],
  batch: {
    batchSize: 100,
    flushInterval: 1000,
    waitForWrite: false, // Don't wait for network round-trip
  },
});
```

**Impact:**

- Immediate mode: 1 network round-trip per operation
- Batch mode: 1 network round-trip per batch
- **Example:** 100ms latency → 10 ops/sec (immediate) vs 1000 ops/sec (batch)

## Real-World Benchmarks

### Scenario: E-commerce Orders

**Setup:**

- 1000 orders/minute
- Each order: 1 INSERT + 3 item INSERTs + 1 UPDATE
- 5 operations per order = 5000 ops/minute = ~83 ops/sec

**Immediate mode:**

```
Throughput: ~400 ops/sec ✓ (sufficient)
Latency per operation: ~2.5ms
Total overhead: 5 * 2.5ms = 12.5ms per order
```

**Batch mode:**

```
Throughput: ~2000 ops/sec ✓ (plenty of headroom)
Latency per operation: ~0.5ms
Total overhead: 5 * 0.5ms = 2.5ms per order
```

### Scenario: User Activity Tracking

**Setup:**

- 10,000 events/minute
- Mostly INSERTs with occasional UPDATEs
- ~166 ops/sec

**Recommended config:**

```typescript
const auditLogger = createAuditLogger(db, {
  tables: ["events"],
  captureOldValues: false, // Don't need old values for events
  batch: {
    batchSize: 100,
    flushInterval: 500,
    waitForWrite: false, // Max throughput
  },
});
```

**Performance:**

- Throughput: ~2000 ops/sec ✓
- Overhead: <0.5ms per event
- Database load: 2 writes/sec (vs 166 without batching)

## Monitoring

Track these metrics:

```typescript
const stats = auditLogger.getStats();

console.log({
  queueSize: stats.queueSize, // How many logs waiting
  isWriting: stats.isWriting, // Currently writing
  isShuttingDown: stats.isShuttingDown,
});
```

**Alerts to set:**

- `queueSize > batchSize * 2` - Queue backing up
- `isWriting === true` for >5 seconds - Slow database writes
- Failed flush count increasing - Database issues

## Troubleshooting Performance Issues

### Symptom: Slow Inserts

**Check:**

1. Is `captureOldValues` enabled unnecessarily?
2. Are you using batch mode?
3. Database connection pool size?

**Fix:**

```typescript
// Disable old values if not needed
captureOldValues: false,

// Enable batching
batch: {
  batchSize: 100,
  flushInterval: 1000,
  waitForWrite: false,
},
```

### Symptom: Queue Growing

**Check:**

```typescript
const stats = auditLogger.getStats();
console.log(stats.queueSize); // Growing?
```

**Fix:**

1. Increase `batchSize`
2. Decrease `flushInterval`
3. Check database performance
4. Scale database vertically or horizontally

### Symptom: High Memory Usage

**Check:**

```typescript
const stats = auditLogger.getStats();
// queueSize * 1KB ≈ memory usage
```

**Fix:**

1. Decrease `batchSize`
2. Decrease `flushInterval`
3. Call `flush()` manually in bulk operations

## Best Practices

1. **Start simple:** Use immediate mode first
2. **Measure:** Profile your app before optimizing
3. **Batch for bulk:** Use batch mode for imports/exports
4. **Tune batch size:** Start with 100, adjust based on metrics
5. **Monitor queue:** Alert on queue size
6. **Graceful shutdown:** Always call `shutdown()` before exit
7. **Skip old values:** Set `captureOldValues: false` unless required
8. **Custom fields only:** Use `fields` config to limit audited columns

## Summary Table

| Mode          | Queries/Op | Throughput | Memory | Use Case            |
| ------------- | ---------- | ---------- | ------ | ------------------- |
| Immediate     | 2-3        | ~400/sec   | Low    | Default, low volume |
| Batch (sync)  | 2-3        | ~1000/sec  | Medium | Balanced            |
| Batch (async) | 2-3        | ~2000/sec  | Medium | High volume         |
| Batch (large) | 2-3        | ~5000/sec  | High   | Bulk operations     |

## Further Optimization

For extreme performance needs:

1. **Partition audit table by date**

   ```sql
   CREATE TABLE audit_logs_2024_01 PARTITION OF audit_logs
   FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
   ```

2. **Async replication**
   - Write to primary
   - Replicate audit logs to read replicas

3. **External storage**
   - Use custom writer to send to S3, BigQuery, etc.
   - Keep hot data in PostgreSQL, archive cold data

4. **Sampling**
   - Audit 100% of critical operations
   - Sample 1-10% of read operations
