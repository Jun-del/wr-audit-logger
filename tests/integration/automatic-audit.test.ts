import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, serial, text, varchar } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createAuditLogger, auditLogs } from "../../src/index.js";

// Generate unique table names to avoid conflicts when running tests in parallel
const TEST_ID = `auto_${Date.now()}_${Math.random().toString(36).substring(7)}`;
const USERS_TABLE = `test_users_${TEST_ID}`;
const VEHICLES_TABLE = `test_vehicles_${TEST_ID}`;

// Test schema with unique table names
const testUsers = pgTable(USERS_TABLE, {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  name: text("name"),
  password: text("password"),
});

const testVehicles = pgTable(VEHICLES_TABLE, {
  id: serial("id").primaryKey(),
  make: varchar("make", { length: 100 }),
  model: varchar("model", { length: 100 }),
  status: varchar("status", { length: 50 }),
});

describe("Automatic Audit Logging (Integration)", () => {
  let client: Client;
  let originalDb: any;
  let db: any;
  let setContext: any;

  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error("DATABASE_URL is not set");
    }

    // Connect to test database
    client = new Client(dbUrl);
    await client.connect();
    originalDb = drizzle(client);

    // Create test tables with unique names (no IF NOT EXISTS needed)
    await originalDb.execute(`
      CREATE TABLE "${USERS_TABLE}" (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        name TEXT,
        password TEXT
      )
    `);

    await originalDb.execute(`
      CREATE TABLE "${VEHICLES_TABLE}" (
        id SERIAL PRIMARY KEY,
        make VARCHAR(100),
        model VARCHAR(100),
        status VARCHAR(50)
      )
    `);

    // Create audit logger
    const auditLogger = createAuditLogger(originalDb, {
      tables: [USERS_TABLE, VEHICLES_TABLE],
      excludeFields: ["password"],
    });

    db = auditLogger.db;
    setContext = auditLogger.setContext;
  });

  afterAll(async () => {
    // Clean up only our test tables
    await originalDb.execute(`DROP TABLE IF EXISTS "${USERS_TABLE}" CASCADE`);
    await originalDb.execute(`DROP TABLE IF EXISTS "${VEHICLES_TABLE}" CASCADE`);
    // Clean up only our audit logs (don't drop the table - other tests may use it)
    await originalDb.execute(
      `DELETE FROM audit_logs WHERE table_name IN ('${USERS_TABLE}', '${VEHICLES_TABLE}')`,
    );
    await client.end();
  });

  beforeEach(async () => {
    // Clear data before each test
    await originalDb.execute(`TRUNCATE TABLE "${USERS_TABLE}" RESTART IDENTITY CASCADE`);
    await originalDb.execute(`TRUNCATE TABLE "${VEHICLES_TABLE}" RESTART IDENTITY CASCADE`);
    // Only delete audit logs for our tables
    await originalDb.execute(
      `DELETE FROM audit_logs WHERE table_name IN ('${USERS_TABLE}', '${VEHICLES_TABLE}')`,
    );
  });

  describe("INSERT operations", () => {
    it("should automatically log single insert", async () => {
      setContext({
        userId: "test-user-123",
        ipAddress: "127.0.0.1",
      });

      // Insert user
      const [user] = await db
        .insert(testUsers)
        .values({
          email: "test@example.com",
          name: "Test User",
          password: "secret",
        })
        .returning();

      // Check audit log was created
      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, USERS_TABLE));

      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].action).toBe("INSERT");
      expect(logs[0].recordId).toBe(String(user.id));
      expect(logs[0].userId).toBe("test-user-123");
      expect(logs[0].ipAddress).toBe("127.0.0.1");
      expect(logs[0].newValues).toMatchObject({
        email: "test@example.com",
        name: "Test User",
      });
      // Password should be excluded
      expect(logs[0].newValues).not.toHaveProperty("password");
    });

    it("should log bulk inserts", async () => {
      const vehicles = await db
        .insert(testVehicles)
        .values([
          { make: "Toyota", model: "Camry", status: "active" },
          { make: "Honda", model: "Civic", status: "active" },
        ])
        .returning();

      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, VEHICLES_TABLE));

      expect(logs).toHaveLength(2);
      expect(logs.every((log) => log.action === "INSERT")).toBe(true);
    });
  });

  describe("UPDATE operations", () => {
    it("should automatically log updates with new values", async () => {
      // Insert user first
      const [user] = await db
        .insert(testUsers)
        .values({
          email: "original@example.com",
          name: "Original Name",
        })
        .returning();

      // Clear insert audit log
      await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${USERS_TABLE}'`);

      // Update user WITH .returning()
      await db
        .update(testUsers)
        .set({
          name: "Updated Name",
          email: "updated@example.com",
        })
        .where(eq(testUsers.id, user.id))
        .returning();

      // Check audit log
      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, USERS_TABLE));

      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe("UPDATE");
      expect(logs[0].newValues).toMatchObject({
        name: "Updated Name",
        email: "updated@example.com",
      });
      // Note: oldValues will be null/undefined because captureOldValues defaults to false
    });

    it("should not log update if nothing changed (when captureOldValues=true)", async () => {
      // Create a new logger with captureOldValues enabled for this test
      const auditLogger = createAuditLogger(originalDb, {
        tables: [USERS_TABLE],
        captureOldValues: true,
      });

      const testDb = auditLogger.db;

      const [user] = await testDb
        .insert(testUsers)
        .values({ email: "test@example.com", name: "Test" })
        .returning();

      await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${USERS_TABLE}'`);

      // Update with same values
      await testDb.update(testUsers).set({ name: "Test" }).where(eq(testUsers.id, user.id));

      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, USERS_TABLE));

      // Should not create log because nothing changed
      expect(logs).toHaveLength(0);
    });
  });

  describe("DELETE operations", () => {
    it("should automatically log deletes", async () => {
      const [user] = await db
        .insert(testUsers)
        .values({ email: "delete@example.com", name: "To Delete" })
        .returning();

      await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${USERS_TABLE}'`);

      // Delete user
      await db.delete(testUsers).where(eq(testUsers.id, user.id));

      // Check audit log
      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, USERS_TABLE));

      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe("DELETE");
      expect(logs[0].oldValues).toMatchObject({
        email: "delete@example.com",
        name: "To Delete",
      });
      expect(logs[0].newValues).toBeNull();
    });
  });

  describe("Transactions", () => {
    it("should log all operations with same transaction_id", async () => {
      await db.transaction(async (tx: any) => {
        await tx
          .insert(testUsers)
          .values({ email: "tx1@example.com", name: "TX User 1" })
          .returning();
        await tx
          .insert(testUsers)
          .values({ email: "tx2@example.com", name: "TX User 2" })
          .returning();
      });

      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, USERS_TABLE));

      expect(logs).toHaveLength(2);
      expect(logs[0].transactionId).toBeTruthy();
      expect(logs[0].transactionId).toBe(logs[1].transactionId);
    });
  });

  describe("Context management", () => {
    it("should use context set via setContext", async () => {
      setContext({
        userId: "context-user",
        ipAddress: "10.0.0.1",
        userAgent: "TestAgent/1.0",
        metadata: { test: "value" },
      });

      await db
        .insert(testUsers)
        .values({ email: "context@example.com", name: "Context Test" })
        .returning();

      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, USERS_TABLE));

      expect(logs[0].userId).toBe("context-user");
      expect(logs[0].ipAddress).toBe("10.0.0.1");
      expect(logs[0].userAgent).toBe("TestAgent/1.0");
      expect(logs[0].metadata).toMatchObject({ test: "value" });
    });
  });

  describe("Manual logging and metadata", () => {
    it("should support custom actions and merge metadata sources", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: [USERS_TABLE],
        getMetadata: () => ({ fromConfig: true, shared: "config" }),
      });

      auditLogger.setContext({
        userId: "manual-user",
        metadata: { fromContext: true, shared: "context" },
      });

      await auditLogger.log({
        action: "READ",
        tableName: USERS_TABLE,
        recordId: "manual-1",
        metadata: { fromLog: true, shared: "log" },
      });

      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, USERS_TABLE));

      const customLog = logs.find((entry) => entry.action === "READ");
      expect(customLog).toBeDefined();
      expect(customLog?.metadata).toMatchObject({
        fromConfig: true,
        fromContext: true,
        fromLog: true,
        shared: "log",
      });
    });
  });

  describe("Table filtering", () => {
    it("should audit configured tables", async () => {
      await db.insert(testUsers).values({ email: "test@example.com", name: "Test" }).returning();
      await db.insert(testVehicles).values({ make: "Toyota", model: "Camry" }).returning();

      const userLogs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, USERS_TABLE));

      const vehicleLogs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, VEHICLES_TABLE));

      expect(userLogs).toHaveLength(1);
      expect(vehicleLogs).toHaveLength(1);
    });

    it("should never audit the audit_logs table itself", async () => {
      // Try to insert into audit logs directly (using original db)
      await originalDb.execute(`
        INSERT INTO audit_logs (action, table_name, record_id, created_at)
        VALUES ('INSERT', 'test', '1', NOW())
      `);

      // Count audit logs for audit_logs table - should be 0
      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, "audit_logs"));

      expect(logs).toHaveLength(0);

      // Clean up our test entry
      await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = 'test'`);
    });
  });
});
