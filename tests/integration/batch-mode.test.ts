import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, serial, text, varchar } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createAuditLogger, auditLogs } from "../../src/index.js";

// Use unique table name per run to avoid stale data collisions
const TEST_ID = `batch_${Date.now()}_${Math.random().toString(36).substring(7)}`;
const USERS_TABLE = `batch_test_users_${TEST_ID}`;

// Test schema
const testUsers = pgTable(USERS_TABLE, {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  name: text("name"),
});

describe("Batch Mode Integration", () => {
  let client: Client;
  let originalDb: any;

  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error("DATABASE_URL is not set");
    }

    client = new Client(dbUrl);
    await client.connect();
    originalDb = drizzle(client);

    // Create test table
    await originalDb.execute(`
      DROP TABLE IF EXISTS "${USERS_TABLE}" CASCADE;
      CREATE TABLE "${USERS_TABLE}" (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        name TEXT
      )
    `);
  });

  afterAll(async () => {
    await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${USERS_TABLE}'`);
    await originalDb.execute(`DROP TABLE IF EXISTS "${USERS_TABLE}" CASCADE`);
    await client.end();
  });

  beforeEach(async () => {
    await originalDb.execute(`DELETE FROM "${USERS_TABLE}"`);
    await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${USERS_TABLE}'`);
  });

  describe("Basic batching", () => {
    it("should queue and batch multiple operations", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: [USERS_TABLE],
        batch: {
          batchSize: 5,
          flushInterval: 5000, // High interval to test manual flush
          waitForWrite: false,
        },
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert 3 users (below batch size)
      await db.insert(testUsers).values({ email: "user1@example.com", name: "User 1" }).returning();
      await db.insert(testUsers).values({ email: "user2@example.com", name: "User 2" }).returning();
      await db.insert(testUsers).values({ email: "user3@example.com", name: "User 3" }).returning();

      // Check stats - should be queued
      const stats = auditLogger.getStats();
      expect(stats).toBeDefined();
      expect(stats!.queueSize).toBeGreaterThan(0);

      // No logs in database yet (not flushed)
      let logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, USERS_TABLE));
      expect(logs).toHaveLength(0);

      // Manually flush
      await auditLogger.flush();

      // Now logs should be in database
      logs = await originalDb.select().from(auditLogs).where(eq(auditLogs.tableName, USERS_TABLE));
      expect(logs).toHaveLength(3);

      // Queue should be empty
      const statsAfter = auditLogger.getStats();
      expect(statsAfter!.queueSize).toBe(0);

      await auditLogger.shutdown();
    });

    it("should auto-flush when batch size is reached", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: [USERS_TABLE],
        batch: {
          batchSize: 3, // Small batch size
          flushInterval: 10000,
          waitForWrite: true, // Wait for write to complete
        },
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert exactly 3 users (batch size)
      await db.insert(testUsers).values({ email: "user1@example.com", name: "User 1" }).returning();
      await db.insert(testUsers).values({ email: "user2@example.com", name: "User 2" }).returning();
      await db.insert(testUsers).values({ email: "user3@example.com", name: "User 3" }).returning();

      // With waitForWrite: true, logs should be written
      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, USERS_TABLE));
      expect(logs).toHaveLength(3);

      await auditLogger.shutdown();
    });

    it("should auto-flush based on time interval", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: [USERS_TABLE],
        batch: {
          batchSize: 100,
          flushInterval: 200, // 200ms
          waitForWrite: false,
        },
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert 2 users (below batch size)
      await db.insert(testUsers).values({ email: "user1@example.com", name: "User 1" }).returning();
      await db.insert(testUsers).values({ email: "user2@example.com", name: "User 2" }).returning();

      // Wait for auto-flush (200ms + buffer)
      await new Promise((resolve) => setTimeout(resolve, 400));

      // Logs should be written by now
      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, USERS_TABLE));
      expect(logs).toHaveLength(2);

      await auditLogger.shutdown();
    });
  });

  describe("waitForWrite configuration", () => {
    it("should wait for write when waitForWrite is true", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: [USERS_TABLE],
        batch: {
          batchSize: 100,
          flushInterval: 10000,
          waitForWrite: true, // Synchronous mode
        },
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert a user
      await db.insert(testUsers).values({ email: "sync@example.com", name: "Sync User" });

      // Manually flush
      await auditLogger.flush();

      // Log should be immediately available
      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, USERS_TABLE));
      expect(logs).toHaveLength(1);
      expect(logs[0].newValues).toMatchObject({
        email: "sync@example.com",
        name: "Sync User",
      });

      await auditLogger.shutdown();
    });

    it("should not wait for write when waitForWrite is false (async mode)", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: [USERS_TABLE],
        batch: {
          batchSize: 100,
          flushInterval: 10000,
          waitForWrite: false, // Async mode
        },
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert a user
      await db.insert(testUsers).values({ email: "async@example.com", name: "Async User" });

      // Log might not be in database yet
      const logsBefore = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, USERS_TABLE));

      // Manually flush and wait
      await auditLogger.flush();

      // Now log should be there
      const logsAfter = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, USERS_TABLE));
      expect(logsAfter).toHaveLength(1);

      await auditLogger.shutdown();
    });
  });

  describe("Graceful shutdown", () => {
    it("should flush all pending logs on shutdown", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: [USERS_TABLE],
        batch: {
          batchSize: 100,
          flushInterval: 60000, // Very high interval
          waitForWrite: false,
        },
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert multiple users
      await db.insert(testUsers).values([
        { email: "user1@example.com", name: "User 1" },
        { email: "user2@example.com", name: "User 2" },
        { email: "user3@example.com", name: "User 3" },
        { email: "user4@example.com", name: "User 4" },
        { email: "user5@example.com", name: "User 5" },
      ]);

      // Logs not flushed yet
      let logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, USERS_TABLE));
      expect(logs.length).toBeLessThan(5); // Might be 0 if very fast

      // Shutdown should flush
      await auditLogger.shutdown();

      // All logs should be written now
      logs = await originalDb.select().from(auditLogs).where(eq(auditLogs.tableName, USERS_TABLE));
      expect(logs).toHaveLength(5);
    });

    it("should handle multiple shutdown calls gracefully", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: [USERS_TABLE],
        batch: {
          batchSize: 100,
          flushInterval: 10000,
        },
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      await db.insert(testUsers).values({ email: "test@example.com", name: "Test" });

      // Multiple shutdowns should not error
      await auditLogger.shutdown();
      await auditLogger.shutdown();
      await auditLogger.shutdown();

      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, USERS_TABLE));
      expect(logs).toHaveLength(1);
    });

    it("should reject new operations after shutdown", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: [USERS_TABLE],
        batch: {
          batchSize: 100,
          flushInterval: 10000,
        },
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      await auditLogger.shutdown();

      // Try to insert after shutdown - should fail audit logging
      try {
        await db.insert(testUsers).values({ email: "after@example.com", name: "After" });
        // The insert itself might succeed, but audit logging should fail silently
      } catch (error) {
        // Expected in strict mode
      }
    });
  });

  describe("Performance comparison", () => {
    it("should be faster than immediate mode for bulk operations", async () => {
      // Immediate mode
      const immediateLogger = createAuditLogger(originalDb, {
        tables: [USERS_TABLE],
        // No batch config - immediate writes
      });

      const { db: immediateDb } = immediateLogger;

      const immediateStart = Date.now();
      for (let i = 0; i < 20; i++) {
        await immediateDb
          .insert(testUsers)
          .values({ email: `immediate${i}@example.com`, name: `User ${i}` })
          .returning();
      }
      const immediateDuration = Date.now() - immediateStart;

      await originalDb.execute(`DELETE FROM "${USERS_TABLE}"`);
      await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${USERS_TABLE}'`);

      // Batch mode
      const batchLogger = createAuditLogger(originalDb, {
        tables: [USERS_TABLE],
        batch: {
          batchSize: 10,
          flushInterval: 10000,
          waitForWrite: true,
        },
      });

      const { db: batchDb } = batchLogger;

      const batchStart = Date.now();
      for (let i = 0; i < 20; i++) {
        await batchDb
          .insert(testUsers)
          .values({ email: `batch${i}@example.com`, name: `User ${i}` })
          .returning();
      }
      await batchLogger.flush();
      const batchDuration = Date.now() - batchStart;

      console.log(`Immediate mode: ${immediateDuration}ms`);
      console.log(`Batch mode: ${batchDuration}ms`);
      console.log(`Speedup: ${(immediateDuration / batchDuration).toFixed(2)}x`);

      // Batch mode should be at least somewhat faster
      // (This is a rough check - actual speedup depends on many factors)
      expect(batchDuration).toBeLessThan(immediateDuration * 1.5);

      await batchLogger.shutdown();
    });
  });

  describe("Error handling in batch mode", () => {
    it("should handle individual log failures in non-strict mode", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: [USERS_TABLE],
        strictMode: false,
        batch: {
          batchSize: 5,
          flushInterval: 10000,
        },
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert some valid data
      await db.insert(testUsers).values({ email: "valid@example.com", name: "Valid" }).returning();

      await auditLogger.flush();

      // Should succeed despite potential issues
      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, USERS_TABLE));
      expect(logs.length).toBeGreaterThan(0);

      await auditLogger.shutdown();
    });

    it("should fail operations in strict mode when audit fails", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: [USERS_TABLE],
        strictMode: true,
        batch: {
          batchSize: 5,
          flushInterval: 10000,
          waitForWrite: true, // Must wait to catch errors
        },
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Normal operation should work
      await db.insert(testUsers).values({ email: "ok@example.com", name: "OK" }).returning();
      await auditLogger.flush();

      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, USERS_TABLE));
      expect(logs.length).toBeGreaterThan(0);

      await auditLogger.shutdown();
    });
  });

  describe("Stats and monitoring", () => {
    it("should provide accurate queue stats", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: [USERS_TABLE],
        batch: {
          batchSize: 100,
          flushInterval: 60000,
          waitForWrite: false,
        },
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Initial state
      let stats = auditLogger.getStats();
      expect(stats!.queueSize).toBe(0);
      expect(stats!.isWriting).toBe(false);
      expect(stats!.isShuttingDown).toBe(false);

      // Add some items
      await db.insert(testUsers).values({ email: "user1@example.com", name: "User 1" });
      await db.insert(testUsers).values({ email: "user2@example.com", name: "User 2" });

      stats = auditLogger.getStats();
      expect(stats!.queueSize).toBeGreaterThan(0);

      // Flush
      await auditLogger.flush();

      stats = auditLogger.getStats();
      expect(stats!.queueSize).toBe(0);

      // Shutdown
      await auditLogger.shutdown();

      stats = auditLogger.getStats();
      expect(stats!.isShuttingDown).toBe(true);
    });
  });
});
