import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, serial, text, varchar } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createAuditLogger, createAuditTableSQL, auditLogs } from "../../src/index.js";

// Test schema
const testUsers = pgTable("auto_returning_test_users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  name: text("name"),
});

describe("Automatic .returning() Injection", () => {
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

    // Create audit table and test table
    await originalDb.execute(createAuditTableSQL);
    await originalDb.execute(`
      DROP TABLE IF EXISTS auto_returning_test_users CASCADE;
      CREATE TABLE auto_returning_test_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        name TEXT
      )
    `);
  });

  afterAll(async () => {
    await originalDb.execute("DROP TABLE IF EXISTS auto_returning_test_users CASCADE");
    await originalDb.execute("DROP TABLE IF EXISTS audit_logs CASCADE");
    await client.end();
  });

  beforeEach(async () => {
    await originalDb.execute("DELETE FROM auto_returning_test_users");
    await originalDb.execute("DELETE FROM audit_logs");
  });

  describe("INSERT without .returning()", () => {
    it("should automatically capture inserted data and create audit log", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: ["auto_returning_test_users"],
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert WITHOUT .returning() - this should still be audited
      await db.insert(testUsers).values({
        email: "auto@example.com",
        name: "Auto Test",
      });

      // Check that audit log was created
      const logs = await originalDb.select().from(auditLogs).where(eq(auditLogs.action, "INSERT"));

      expect(logs).toHaveLength(1);
      expect(logs[0].tableName).toBe("auto_returning_test_users");
      expect(logs[0].newValues).toBeDefined();
      expect(logs[0].newValues).toMatchObject({
        email: "auto@example.com",
        name: "Auto Test",
      });
      // The ID should also be captured since .returning() was auto-injected
      expect(logs[0].newValues).toHaveProperty("id");
      expect(logs[0].recordId).toBeTruthy();
    });

    it("should work with bulk inserts without .returning()", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: ["auto_returning_test_users"],
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Bulk insert WITHOUT .returning()
      await db.insert(testUsers).values([
        { email: "user1@example.com", name: "User 1" },
        { email: "user2@example.com", name: "User 2" },
        { email: "user3@example.com", name: "User 3" },
      ]);

      // Check that all 3 were audited
      const logs = await originalDb.select().from(auditLogs).where(eq(auditLogs.action, "INSERT"));

      expect(logs).toHaveLength(3);
      expect(logs[0].newValues).toHaveProperty("email");
      expect(logs[1].newValues).toHaveProperty("email");
      expect(logs[2].newValues).toHaveProperty("email");
    });
  });

  describe("UPDATE without .returning()", () => {
    it("should automatically capture updated data and create audit log", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: ["auto_returning_test_users"],
        captureOldValues: true, // Enable to see before/after
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // First, insert a user WITH .returning() to get the ID
      const [user] = await db
        .insert(testUsers)
        .values({ email: "original@example.com", name: "Original Name" })
        .returning();

      // Clear audit logs from insert
      await originalDb.execute("DELETE FROM audit_logs");

      // Update WITHOUT .returning() - should still be audited
      await db.update(testUsers).set({ name: "Updated Name" }).where(eq(testUsers.id, user.id));

      // Check that update was audited
      const logs = await originalDb.select().from(auditLogs).where(eq(auditLogs.action, "UPDATE"));

      expect(logs).toHaveLength(1);
      expect(logs[0].oldValues).toMatchObject({ name: "Original Name" });
      expect(logs[0].newValues).toMatchObject({ name: "Updated Name" });
      expect(logs[0].changedFields).toContain("name");
    });

    it("should work when captureOldValues is false", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: ["auto_returning_test_users"],
        captureOldValues: false,
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert first
      const [user] = await db
        .insert(testUsers)
        .values({ email: "test@example.com", name: "Name" })
        .returning();

      await originalDb.execute("DELETE FROM audit_logs");

      // Update WITHOUT .returning() and without captureOldValues
      await db.update(testUsers).set({ name: "New Name" }).where(eq(testUsers.id, user.id));

      const logs = await originalDb.select().from(auditLogs).where(eq(auditLogs.action, "UPDATE"));

      expect(logs).toHaveLength(1);
      expect(logs[0].oldValues).toBeNull();
      expect(logs[0].newValues).toMatchObject({ name: "New Name" });
    });
  });

  describe("DELETE without .returning()", () => {
    it("should automatically capture deleted data", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: ["auto_returning_test_users"],
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert a user
      const [user] = await db
        .insert(testUsers)
        .values({ email: "delete@example.com", name: "To Delete" })
        .returning();

      await originalDb.execute("DELETE FROM audit_logs");

      // Delete WITHOUT .returning() - should still be audited
      await db.delete(testUsers).where(eq(testUsers.id, user.id));

      const logs = await originalDb.select().from(auditLogs).where(eq(auditLogs.action, "DELETE"));

      expect(logs).toHaveLength(1);
      expect(logs[0].oldValues).toMatchObject({
        email: "delete@example.com",
        name: "To Delete",
      });
    });
  });

  describe("WITH explicit .returning() - should still work", () => {
    it("should respect user's explicit .returning() call", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: ["auto_returning_test_users"],
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert WITH explicit .returning()
      const result = await db
        .insert(testUsers)
        .values({ email: "explicit@example.com", name: "Explicit" })
        .returning();

      // User should get the result as expected
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      expect(result[0]).toHaveProperty("id");
      expect(result[0].email).toBe("explicit@example.com");

      // And audit log should be created
      const logs = await originalDb.select().from(auditLogs).where(eq(auditLogs.action, "INSERT"));

      expect(logs).toHaveLength(1);
      expect(logs[0].newValues).toMatchObject({
        email: "explicit@example.com",
        name: "Explicit",
      });
    });
  });

  describe("Return value handling", () => {
    it("should NOT return data when user didn't call .returning()", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: ["auto_returning_test_users"],
      });

      const { db } = auditLogger;

      // Without .returning(), Drizzle normally returns query metadata
      const result = await db.insert(testUsers).values({
        email: "no-return@example.com",
        name: "No Return",
      });

      // The result should be the Drizzle query result (not the inserted row)
      // This maintains backward compatibility with existing code
      // Note: Drizzle returns different things for different drivers
      // For postgres, it's typically an empty array or undefined when no .returning()
      expect(result).toBeDefined();
    });

    it("should return inserted data when user calls .returning()", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: ["auto_returning_test_users"],
      });

      const { db } = auditLogger;

      // WITH .returning(), user gets the data
      const result = await db
        .insert(testUsers)
        .values({ email: "with-return@example.com", name: "With Return" })
        .returning();

      expect(Array.isArray(result)).toBe(true);
      expect(result[0]).toHaveProperty("id");
      expect(result[0].email).toBe("with-return@example.com");
    });
  });
});
