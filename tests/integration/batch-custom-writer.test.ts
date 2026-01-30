import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, serial, text, varchar } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createAuditLogger } from "../../src/index.js";

// Test schema
const testUsers = pgTable("custom_batch_test_users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  name: text("name"),
});

// Custom audit table
const customAuditTable = pgTable("custom_batch_audit_logs", {
  id: serial("id").primaryKey(),
  companyId: varchar("company_id", { length: 255 }),
  action: varchar("action", { length: 50 }),
  tableName: varchar("table_name", { length: 255 }),
  recordId: varchar("record_id", { length: 255 }),
  data: text("data"),
});

describe("Batch Mode with Custom Writer", () => {
  let client: Client;
  let originalDb: any;
  let customLogs: any[] = [];

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
      DROP TABLE IF EXISTS custom_batch_test_users CASCADE;
      CREATE TABLE custom_batch_test_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        name TEXT
      )
    `);
  });

  afterAll(async () => {
    await originalDb.execute("DROP TABLE IF EXISTS custom_batch_test_users CASCADE");
    await client.end();
  });

  beforeEach(async () => {
    await originalDb.execute("DELETE FROM custom_batch_test_users");
    customLogs = []; // Clear in-memory logs
  });

  describe("Custom writer with batching", () => {
    it("should batch custom writer calls", async () => {
      const writeCalls: any[] = [];

      // Custom writer that tracks calls
      const customWriter = async (logs: any[], context: any) => {
        writeCalls.push({ logs, context, timestamp: Date.now() });
        // Simulate writing to custom storage
        customLogs.push(...logs);
      };

      const auditLogger = createAuditLogger(originalDb, {
        tables: ["custom_batch_test_users"],
        batch: {
          batchSize: 5,
          flushInterval: 10000, // High interval
          waitForWrite: false,
        },
        customWriter,
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert 3 users (below batch size)
      await db.insert(testUsers).values({ email: "user1@example.com", name: "User 1" });
      await db.insert(testUsers).values({ email: "user2@example.com", name: "User 2" });
      await db.insert(testUsers).values({ email: "user3@example.com", name: "User 3" });

      // Queue should have items
      const stats = auditLogger.getStats();
      expect(stats).toBeDefined();
      expect(stats!.queueSize).toBeGreaterThan(0);

      // Custom writer not called yet
      expect(writeCalls.length).toBe(0);

      // Manual flush
      await auditLogger.flush();

      // Custom writer should be called once with all 3 logs
      expect(writeCalls.length).toBe(1);
      expect(writeCalls[0].logs.length).toBe(3);
      expect(customLogs.length).toBe(3);

      await auditLogger.shutdown();
    });

    it("should auto-flush when batch size is reached", async () => {
      const writeCalls: any[] = [];

      const customWriter = async (logs: any[], context: any) => {
        writeCalls.push({ logs, context });
        customLogs.push(...logs);
      };

      const auditLogger = createAuditLogger(originalDb, {
        tables: ["custom_batch_test_users"],
        batch: {
          batchSize: 3, // Small batch size
          flushInterval: 10000,
          waitForWrite: true, // Wait for writes
        },
        customWriter,
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert exactly 3 users
      await db.insert(testUsers).values({ email: "user1@example.com", name: "User 1" });
      await db.insert(testUsers).values({ email: "user2@example.com", name: "User 2" });
      await db.insert(testUsers).values({ email: "user3@example.com", name: "User 3" });

      // Should auto-flush (waitForWrite: true)
      expect(writeCalls.length).toBe(1);
      expect(customLogs.length).toBe(3);

      await auditLogger.shutdown();
    });

    it("should flush on time interval", async () => {
      const writeCalls: any[] = [];

      const customWriter = async (logs: any[], context: any) => {
        writeCalls.push({ logs, context });
        customLogs.push(...logs);
      };

      const auditLogger = createAuditLogger(originalDb, {
        tables: ["custom_batch_test_users"],
        batch: {
          batchSize: 100,
          flushInterval: 200, // 200ms
          waitForWrite: false,
        },
        customWriter,
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert 2 users
      await db.insert(testUsers).values({ email: "user1@example.com", name: "User 1" });
      await db.insert(testUsers).values({ email: "user2@example.com", name: "User 2" });

      // Wait for auto-flush
      await new Promise((resolve) => setTimeout(resolve, 400));

      // Should have flushed
      expect(writeCalls.length).toBe(1);
      expect(customLogs.length).toBe(2);

      await auditLogger.shutdown();
    });

    it("should flush all pending logs on shutdown", async () => {
      const writeCalls: any[] = [];

      const customWriter = async (logs: any[], context: any) => {
        writeCalls.push({ logs, context });
        customLogs.push(...logs);
      };

      const auditLogger = createAuditLogger(originalDb, {
        tables: ["custom_batch_test_users"],
        batch: {
          batchSize: 100,
          flushInterval: 60000, // Very high
          waitForWrite: false,
        },
        customWriter,
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert 5 users
      for (let i = 1; i <= 5; i++) {
        await db.insert(testUsers).values({ email: `user${i}@example.com`, name: `User ${i}` });
      }

      // Not flushed yet
      expect(writeCalls.length).toBe(0);

      // Shutdown should flush
      await auditLogger.shutdown();

      // All logs should be written
      expect(writeCalls.length).toBe(1);
      expect(customLogs.length).toBe(5);
    });

    it("should group logs by context", async () => {
      const writeCalls: any[] = [];

      const customWriter = async (logs: any[], context: any) => {
        writeCalls.push({ logs, context });
        customLogs.push(...logs);
      };

      const auditLogger = createAuditLogger(originalDb, {
        tables: ["custom_batch_test_users"],
        batch: {
          batchSize: 100,
          flushInterval: 10000,
          waitForWrite: false,
        },
        customWriter,
      });

      const { db, setContext } = auditLogger;

      // Insert with different contexts
      setContext({ userId: "user-1", transactionId: "tx-1" });
      await db.insert(testUsers).values({ email: "user1@example.com", name: "User 1" });

      setContext({ userId: "user-2", transactionId: "tx-2" });
      await db.insert(testUsers).values({ email: "user2@example.com", name: "User 2" });

      setContext({ userId: "user-1", transactionId: "tx-1" });
      await db.insert(testUsers).values({ email: "user3@example.com", name: "User 3" });

      // Flush
      await auditLogger.flush();

      // Should group by context
      expect(writeCalls.length).toBeGreaterThan(0);
      expect(customLogs.length).toBe(3);

      await auditLogger.shutdown();
    });

    it("should handle errors in custom writer", async () => {
      const writeCalls: any[] = [];
      let shouldFail = false;

      const customWriter = async (logs: any[], context: any) => {
        writeCalls.push({ logs, context });
        if (shouldFail) {
          throw new Error("Custom writer error");
        }
        customLogs.push(...logs);
      };

      const auditLogger = createAuditLogger(originalDb, {
        tables: ["custom_batch_test_users"],
        strictMode: false, // Non-strict
        batch: {
          batchSize: 5,
          flushInterval: 10000,
          waitForWrite: false,
        },
        customWriter,
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert successfully
      await db.insert(testUsers).values({ email: "user1@example.com", name: "User 1" });
      await auditLogger.flush();

      expect(customLogs.length).toBe(1);

      // Now fail
      shouldFail = true;
      await db.insert(testUsers).values({ email: "user2@example.com", name: "User 2" });

      try {
        await auditLogger.flush();
      } catch (error) {
        // Error is expected
      }

      // First log should still be there
      expect(customLogs.length).toBe(1);

      await auditLogger.shutdown();
    });

    it("should respect waitForWrite configuration", async () => {
      const writeCalls: any[] = [];
      let writeDelay = 0;

      const customWriter = async (logs: any[], context: any) => {
        await new Promise((resolve) => setTimeout(resolve, writeDelay));
        writeCalls.push({ logs, context });
        customLogs.push(...logs);
      };

      // Test with waitForWrite: true
      const syncAudit = createAuditLogger(originalDb, {
        tables: ["custom_batch_test_users"],
        batch: {
          batchSize: 5,
          flushInterval: 10000,
          waitForWrite: true, // Sync
        },
        customWriter,
      });

      writeDelay = 100; // Slow write
      const start = Date.now();
      await syncAudit.db.insert(testUsers).values({ email: "sync@example.com", name: "Sync" });
      await syncAudit.flush();
      const duration = Date.now() - start;

      // Should wait for write to complete
      expect(duration).toBeGreaterThan(50);
      expect(customLogs.length).toBe(1);

      await syncAudit.shutdown();
    });
  });

  describe("Custom writer WITHOUT batching", () => {
    it("should call custom writer immediately without batch config", async () => {
      const writeCalls: any[] = [];

      const customWriter = async (logs: any[], context: any) => {
        writeCalls.push({ logs, context });
        customLogs.push(...logs);
      };

      const auditLogger = createAuditLogger(originalDb, {
        tables: ["custom_batch_test_users"],
        // No batch config
        customWriter,
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      await db.insert(testUsers).values({ email: "immediate@example.com", name: "Immediate" });

      // Should call immediately
      expect(writeCalls.length).toBe(1);
      expect(customLogs.length).toBe(1);

      // Stats should be undefined (no batch mode)
      const stats = auditLogger.getStats();
      expect(stats).toBeUndefined();
    });
  });
});
