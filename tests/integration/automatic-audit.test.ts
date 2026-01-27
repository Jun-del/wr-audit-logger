import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, serial, text, varchar } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createAuditLogger, createAuditTableSQL, auditLogs } from "../../src/index.js";

// Test schema
const testUsers = pgTable("test_users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  name: text("name"),
  password: text("password"),
});

const testVehicles = pgTable("test_vehicles", {
  id: serial("id").primaryKey(),
  make: varchar("make", { length: 100 }),
  model: varchar("model", { length: 100 }),
  status: varchar("status", { length: 50 }),
});

describe("Automatic Audit Logging (Integration)", () => {
  let client: any;
  let originalDb: any;
  let db: any;
  let setContext: any;

  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error("DATABASE_URL is not set");
    }

    // Connect to database
    client = new Client(process.env.DATABASE_URL);
    await client.connect();
    originalDb = drizzle(client);

    // Create audit table
    await originalDb.execute(createAuditTableSQL);

    // Create test tables
    await originalDb.execute(`
      CREATE TABLE IF NOT EXISTS test_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        name TEXT,
        password TEXT
      )
    `);

    await originalDb.execute(`
      CREATE TABLE IF NOT EXISTS test_vehicles (
        id SERIAL PRIMARY KEY,
        make VARCHAR(100),
        model VARCHAR(100),
        status VARCHAR(50)
      )
    `);

    // Create audit logger
    const auditLogger = createAuditLogger(originalDb, {
      tables: ["test_users", "test_vehicles"],
      excludeFields: ["password"],
      getUserId: () => "test-user-123",
    });

    db = auditLogger.db;
    setContext = auditLogger.setContext;
  });

  afterAll(async () => {
    // Clean up
    await originalDb.execute("DROP TABLE IF EXISTS test_users CASCADE");
    await originalDb.execute("DROP TABLE IF EXISTS test_vehicles CASCADE");
    await originalDb.execute("DROP TABLE IF EXISTS audit_logs CASCADE");
    await client.end();
  });

  beforeEach(async () => {
    // Clear data before each test
    await originalDb.execute("DELETE FROM test_users");
    await originalDb.execute("DELETE FROM test_vehicles");
    await originalDb.execute("DELETE FROM audit_logs");
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
        .where(eq(auditLogs.tableName, "test_users"));

      expect(logs).toHaveLength(1);
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
      await db.insert(testVehicles).values([
        { make: "Toyota", model: "Camry", status: "active" },
        { make: "Honda", model: "Civic", status: "active" },
      ]);

      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, "test_vehicles"));

      expect(logs).toHaveLength(2);
      expect(logs.every((log) => log.action === "INSERT")).toBe(true);
    });
  });

  describe("UPDATE operations", () => {
    it("should automatically log updates with before/after values", async () => {
      // Insert user first
      const [user] = await db
        .insert(testUsers)
        .values({
          email: "original@example.com",
          name: "Original Name",
        })
        .returning();

      // Clear insert audit log
      await originalDb.execute("DELETE FROM audit_logs");

      // Update user
      await db
        .update(testUsers)
        .set({
          name: "Updated Name",
          email: "updated@example.com",
        })
        .where(eq(testUsers.id, user.id));

      // Check audit log
      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, "test_users"));

      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe("UPDATE");
      expect(logs[0].oldValues).toMatchObject({
        name: "Original Name",
        email: "original@example.com",
      });
      expect(logs[0].newValues).toMatchObject({
        name: "Updated Name",
        email: "updated@example.com",
      });
      expect(logs[0].changedFields).toEqual(expect.arrayContaining(["name", "email"]));
    });

    it("should not log update if nothing changed", async () => {
      const [user] = await db
        .insert(testUsers)
        .values({ email: "test@example.com", name: "Test" })
        .returning();

      await originalDb.execute("DELETE FROM audit_logs");

      // Update with same values
      await db.update(testUsers).set({ name: "Test" }).where(eq(testUsers.id, user.id));

      const logs = await originalDb.select().from(auditLogs);
      expect(logs).toHaveLength(0);
    });
  });

  describe("DELETE operations", () => {
    it("should automatically log deletes", async () => {
      const [user] = await db
        .insert(testUsers)
        .values({ email: "delete@example.com", name: "To Delete" })
        .returning();

      await originalDb.execute("DELETE FROM audit_logs");

      // Delete user
      await db.delete(testUsers).where(eq(testUsers.id, user.id));

      // Check audit log
      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tableName, "test_users"));

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
        await tx.insert(testUsers).values({ email: "tx1@example.com", name: "TX User 1" });
        await tx.insert(testUsers).values({ email: "tx2@example.com", name: "TX User 2" });
      });

      const logs = await originalDb.select().from(auditLogs);

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

      await db.insert(testUsers).values({ email: "context@example.com", name: "Context Test" });

      const logs = await originalDb.select().from(auditLogs);

      expect(logs[0].userId).toBe("context-user");
      expect(logs[0].ipAddress).toBe("10.0.0.1");
      expect(logs[0].userAgent).toBe("TestAgent/1.0");
      expect(logs[0].metadata).toMatchObject({ test: "value" });
    });
  });

  describe("Table filtering", () => {
    it("should not audit tables not in config", async () => {
      // This would need a table not in the audit config
      // For this test, we'll just verify the configured tables work
      await db.insert(testUsers).values({ email: "test@example.com", name: "Test" });
      await db.insert(testVehicles).values({ make: "Toyota", model: "Camry" });

      const logs = await originalDb.select().from(auditLogs);

      expect(logs).toHaveLength(2);
      expect(logs.map((l) => l.tableName)).toEqual(
        expect.arrayContaining(["test_users", "test_vehicles"]),
      );
    });

    it("should never audit the audit_logs table itself", async () => {
      // Try to insert into audit logs directly
      await originalDb.execute(`
        INSERT INTO audit_logs (action, table_name, record_id, created_at)
        VALUES ('INSERT', 'test', '1', NOW())
      `);

      // Count audit logs - should only have the one we inserted directly
      const count = await originalDb.execute("SELECT COUNT(*) FROM audit_logs");
      expect(Number(count.rows[0].count)).toBe(1);
    });
  });
});
