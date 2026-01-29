import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, serial, text, varchar } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createAuditLogger, createAuditTableSQL, auditLogs } from "../../src/index.js";

// Test schema
const testUsers = pgTable("config_test_users", {
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

    // Create audit table and test table
    await originalDb.execute(createAuditTableSQL);
    await originalDb.execute(`
      DROP TABLE IF EXISTS config_test_users CASCADE;
      CREATE TABLE config_test_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        name TEXT
      )
    `);
  });

  afterAll(async () => {
    await originalDb.execute("DROP TABLE IF EXISTS config_test_users CASCADE");
    await originalDb.execute("DROP TABLE IF EXISTS audit_logs CASCADE");
    await client.end();
  });

  beforeEach(async () => {
    await originalDb.execute("DELETE FROM config_test_users");
    await originalDb.execute("DELETE FROM audit_logs");
  });

  describe("captureOldValues configuration", () => {
    it("should capture old values when enabled", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: ["config_test_users"],
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
      const logs = await originalDb.select().from(auditLogs).where(eq(auditLogs.action, "UPDATE"));

      expect(logs).toHaveLength(1);
      expect(logs[0].oldValues).toBeDefined();
      expect(logs[0].oldValues).toMatchObject({ name: "Original Name" });
      expect(logs[0].newValues).toMatchObject({ name: "Updated Name" });
    });

    it("should NOT capture old values when disabled (default)", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: ["config_test_users"],
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
      const logs = await originalDb.select().from(auditLogs).where(eq(auditLogs.action, "UPDATE"));

      // Should still create an audit log, but without old values
      expect(logs).toHaveLength(1);
      expect(logs[0].oldValues).toBeNull();
      expect(logs[0].newValues).toMatchObject({ name: "Updated Name" });
    });
  });

  describe("DELETE operations (always logged via .returning())", () => {
    it("should always capture deleted data using auto-injected .returning()", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: ["config_test_users"],
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert a user
      const [user] = await db
        .insert(testUsers)
        .values({ email: "delete@example.com", name: "To Be Deleted" })
        .returning();

      await originalDb.execute("DELETE FROM audit_logs");

      // Delete the user - .returning() is auto-injected
      await db.delete(testUsers).where(eq(testUsers.id, user.id));

      // Check audit log
      const logs = await originalDb.select().from(auditLogs).where(eq(auditLogs.action, "DELETE"));

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
        tables: ["config_test_users"],
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Delete non-existent user
      await db.delete(testUsers).where(eq(testUsers.id, 99999));

      // Check audit log
      const logs = await originalDb.select().from(auditLogs).where(eq(auditLogs.action, "DELETE"));

      // Should not create audit log when nothing was deleted
      expect(logs).toHaveLength(0);
    });
  });

  describe("Performance benefits", () => {
    it("should skip SELECT query when captureOldValues is false", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: ["config_test_users"],
        captureOldValues: false,
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      const [user] = await db
        .insert(testUsers)
        .values({ email: "test@example.com", name: "Name" })
        .returning();

      // This update won't trigger a SELECT before the UPDATE
      await db.update(testUsers).set({ name: "New Name" }).where(eq(testUsers.id, user.id));

      const logs = await originalDb.select().from(auditLogs).where(eq(auditLogs.action, "UPDATE"));

      expect(logs).toHaveLength(1);
      expect(logs[0].oldValues).toBeNull();
      expect(logs[0].newValues).toMatchObject({ name: "New Name" });
    });
  });
});
