import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, serial, text, varchar } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createAuditLogger, auditLogs } from "../../src/index.js";

// Generate unique table name to avoid conflicts
const TEST_ID = `config_${Date.now()}_${Math.random().toString(36).substring(7)}`;
const TABLE_NAME = `config_test_users_${TEST_ID}`;

// Test schema with unique table name
const testUsers = pgTable(TABLE_NAME, {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  name: text("name"),
});

describe("Capture Configuration", () => {
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

    // Create test table with unique name
    await originalDb.execute(`
      CREATE TABLE "${TABLE_NAME}" (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        name TEXT
      )
    `);
  });

  afterAll(async () => {
    // Clean up only our test table
    await originalDb.execute(`DROP TABLE IF EXISTS "${TABLE_NAME}" CASCADE`);
    // Clean up only our audit logs
    await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${TABLE_NAME}'`);
    await client.end();
  });

  beforeEach(async () => {
    // Clear data before each test
    await originalDb.execute(`TRUNCATE TABLE "${TABLE_NAME}" RESTART IDENTITY CASCADE`);
    // Only delete audit logs for our table
    await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${TABLE_NAME}'`);
  });

  describe("captureOldValues configuration", () => {
    it("should capture old values when enabled", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: [TABLE_NAME],
        captureOldValues: true,
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert a user
      const [user] = await db
        .insert(testUsers)
        .values({ email: "test@example.com", name: "Original Name" })
        .returning();

      // Update the user
      await db.update(testUsers).set({ name: "Updated Name" }).where(eq(testUsers.id, user.id));

      // Check audit log
      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "UPDATE"), eq(auditLogs.tableName, TABLE_NAME)));

      expect(logs).toHaveLength(1);
      expect(logs[0].oldValues).toBeDefined();
      expect(logs[0].oldValues).toMatchObject({ name: "Original Name" });
      expect(logs[0].newValues).toMatchObject({ name: "Updated Name" });
    });

    it("should NOT capture old values when disabled (default)", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: [TABLE_NAME],
        captureOldValues: false, // Default
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert a user
      const [user] = await db
        .insert(testUsers)
        .values({ email: "test@example.com", name: "Original Name" })
        .returning();

      // Update the user
      await db.update(testUsers).set({ name: "Updated Name" }).where(eq(testUsers.id, user.id));

      // Check audit log
      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "UPDATE"), eq(auditLogs.tableName, TABLE_NAME)));

      // Should still create an audit log, but without old values
      expect(logs).toHaveLength(1);
      expect(logs[0].oldValues).toBeNull();
      expect(logs[0].newValues).toMatchObject({ name: "Updated Name" });
    });
  });

  describe("DELETE operations (always logged via .returning())", () => {
    it("should always capture deleted data using auto-injected .returning()", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: [TABLE_NAME],
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert a user
      const [user] = await db
        .insert(testUsers)
        .values({ email: "delete@example.com", name: "To Be Deleted" })
        .returning();

      // Clear insert audit log
      await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${TABLE_NAME}'`);

      // Delete the user - .returning() is auto-injected
      await db.delete(testUsers).where(eq(testUsers.id, user.id));

      // Check audit log
      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "DELETE"), eq(auditLogs.tableName, TABLE_NAME)));

      expect(logs).toHaveLength(1);
      expect(logs[0].oldValues).toBeDefined();
      expect(logs[0].oldValues).toMatchObject({
        email: "delete@example.com",
        name: "To Be Deleted",
      });
      expect(logs[0].newValues).toBeNull();
    });

    it("should not create audit log when DELETE matches no records", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: [TABLE_NAME],
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Delete non-existent user
      await db.delete(testUsers).where(eq(testUsers.id, 99999));

      // Check audit log
      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "DELETE"), eq(auditLogs.tableName, TABLE_NAME)));

      // Should not create audit log when nothing was deleted
      expect(logs).toHaveLength(0);
    });
  });

  describe("Performance benefits", () => {
    it("should skip SELECT query when captureOldValues is false", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: [TABLE_NAME],
        captureOldValues: false,
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      const [user] = await db
        .insert(testUsers)
        .values({ email: "test@example.com", name: "Name" })
        .returning();

      // Clear insert audit log
      await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${TABLE_NAME}'`);

      // This update won't trigger a SELECT before the UPDATE
      await db.update(testUsers).set({ name: "New Name" }).where(eq(testUsers.id, user.id));

      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "UPDATE"), eq(auditLogs.tableName, TABLE_NAME)));

      expect(logs).toHaveLength(1);
      expect(logs[0].oldValues).toBeNull();
      expect(logs[0].newValues).toMatchObject({ name: "New Name" });
    });
  });
});
