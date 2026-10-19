import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, serial, text, varchar } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createAuditLogger, auditLogs } from "../../src/index.js";

// Generate unique table name to avoid conflicts
const TEST_ID = `returning_${Date.now()}_${Math.random().toString(36).substring(7)}`;
const TABLE_NAME = `auto_returning_test_users_${TEST_ID}`;

// Test schema with unique table name
const testUsers = pgTable(TABLE_NAME, {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  name: text("name"),
});

const describeIntegration =
  process.env.AUDIT_RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeIntegration("Automatic .returning() Injection", () => {
  let client: Client;
  let originalDb: any;

  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error("DATABASE_URL is not set");
    }

    client = new Client(dbUrl);
    await client.connect();
    originalDb = drizzle({ client });

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
    if (!originalDb || !client) {
      return;
    }

    // Clean up only our test table
    await originalDb.execute(`DROP TABLE IF EXISTS "${TABLE_NAME}" CASCADE`);
    // Clean up only our audit logs
    await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${TABLE_NAME}'`);
    await client.end();
  });

  beforeEach(async () => {
    if (!originalDb) {
      return;
    }

    // Clear data before each test
    await originalDb.execute(`TRUNCATE TABLE "${TABLE_NAME}" RESTART IDENTITY CASCADE`);
    // Only delete audit logs for our table
    await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${TABLE_NAME}'`);
  });

  describe("INSERT without .returning()", () => {
    it("should automatically capture inserted data and create audit log", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: { [TABLE_NAME]: { primaryKey: "id" } },
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert WITHOUT .returning() - this should still be audited
      await db.insert(testUsers).values({
        email: "auto@example.com",
        name: "Auto Test",
      });

      // Check that audit log was created
      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "INSERT"), eq(auditLogs.tableName, TABLE_NAME)));

      expect(logs).toHaveLength(1);
      expect(logs[0].tableName).toBe(TABLE_NAME);
      expect(logs[0].values).toBeDefined();
      expect(logs[0].values).toMatchObject({
        email: "auto@example.com",
        name: "Auto Test",
      });
      // The ID should also be captured since .returning() was auto-injected
      expect(logs[0].values).toHaveProperty("id");
      expect(logs[0].recordId).toBeTruthy();
    });

    it("should work with bulk inserts without .returning()", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: { [TABLE_NAME]: { primaryKey: "id" } },
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
      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "INSERT"), eq(auditLogs.tableName, TABLE_NAME)));

      expect(logs).toHaveLength(3);
      expect(logs[0].values).toHaveProperty("email");
      expect(logs[1].values).toHaveProperty("email");
      expect(logs[2].values).toHaveProperty("email");
    });
  });

  describe("UPDATE without .returning()", () => {
    it("should automatically capture updated data and create audit log", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: { [TABLE_NAME]: { primaryKey: "id" } },
        updateValuesMode: "changed", // Store only changed fields
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // First, insert a user WITH .returning() to get the ID
      const [user] = await db
        .insert(testUsers)
        .values({ email: "original@example.com", name: "Original Name" })
        .returning();

      // Clear audit logs from insert
      await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${TABLE_NAME}'`);

      // Update WITHOUT .returning() - should still be audited
      await db.update(testUsers).set({ name: "Updated Name" }).where(eq(testUsers.id, user.id));

      // Check that update was audited
      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "UPDATE"), eq(auditLogs.tableName, TABLE_NAME)));

      expect(logs).toHaveLength(1);
      expect(logs[0].values).toMatchObject({ name: "Updated Name" });
    });

    it('should work when updateValuesMode is "full"', async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: { [TABLE_NAME]: { primaryKey: "id" } },
        updateValuesMode: "full",
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert first
      const [user] = await db
        .insert(testUsers)
        .values({ email: "test@example.com", name: "Name" })
        .returning();

      await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${TABLE_NAME}'`);

      // Update WITHOUT .returning() and with updateValuesMode="full"
      await db.update(testUsers).set({ name: "New Name" }).where(eq(testUsers.id, user.id));

      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "UPDATE"), eq(auditLogs.tableName, TABLE_NAME)));

      expect(logs).toHaveLength(1);
      expect(logs[0].values).toMatchObject({ name: "New Name" });
    });
  });

  describe("DELETE without .returning()", () => {
    it("should automatically capture deleted data", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: { [TABLE_NAME]: { primaryKey: "id" } },
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      // Insert a user
      const [user] = await db
        .insert(testUsers)
        .values({ email: "delete@example.com", name: "To Delete" })
        .returning();

      await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${TABLE_NAME}'`);

      // Delete WITHOUT .returning() - should still be audited
      await db.delete(testUsers).where(eq(testUsers.id, user.id));

      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "DELETE"), eq(auditLogs.tableName, TABLE_NAME)));

      expect(logs).toHaveLength(1);
      expect(logs[0].values).toMatchObject({
        email: "delete@example.com",
        name: "To Delete",
      });
    });
  });

  describe("WITH explicit .returning() - should still work", () => {
    it("should respect user's explicit .returning() call", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: { [TABLE_NAME]: { primaryKey: "id" } },
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
      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "INSERT"), eq(auditLogs.tableName, TABLE_NAME)));

      expect(logs).toHaveLength(1);
      expect(logs[0].values).toMatchObject({
        email: "explicit@example.com",
        name: "Explicit",
      });
    });

    it("should audit UPDATE when returning a selected column set", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: { [TABLE_NAME]: { primaryKey: "id" } },
        updateValuesMode: "changed",
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      const [user] = await db
        .insert(testUsers)
        .values({ email: "returning@example.com", name: "Before" })
        .returning();

      await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${TABLE_NAME}'`);

      await db
        .update(testUsers)
        .set({ name: "After" })
        .where(eq(testUsers.id, user.id))
        .returning({ id: testUsers.id, name: testUsers.name });

      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "UPDATE"), eq(auditLogs.tableName, TABLE_NAME)));

      expect(logs).toHaveLength(1);
      expect(logs[0].values).toMatchObject({ name: "After" });
    });

    it("should preserve user selection for INSERT returning({ id })", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: { [TABLE_NAME]: { primaryKey: "id" } },
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      const result = await db
        .insert(testUsers)
        .values({ email: "return-insert@example.com", name: "Insert Me" })
        .returning({ id: testUsers.id });

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty("id");
      expect(Object.keys(result[0])).toEqual(["id"]);

      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "INSERT"), eq(auditLogs.tableName, TABLE_NAME)));

      expect(logs).toHaveLength(1);
      expect(logs[0].values).toMatchObject({
        email: "return-insert@example.com",
        name: "Insert Me",
      });
    });

    it("should audit DELETE when returning a selected column set", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: { [TABLE_NAME]: { primaryKey: "id" } },
      });

      const { db, setContext } = auditLogger;
      setContext({ userId: "test-user" });

      const [user] = await db
        .insert(testUsers)
        .values({ email: "return-delete@example.com", name: "Delete Me" })
        .returning();

      await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${TABLE_NAME}'`);

      const deleted = await db
        .delete(testUsers)
        .where(eq(testUsers.id, user.id))
        .returning({ id: testUsers.id });

      expect(deleted).toHaveLength(1);
      expect(deleted[0]).toEqual({ id: user.id });

      const logs = await originalDb
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "DELETE"), eq(auditLogs.tableName, TABLE_NAME)));

      expect(logs).toHaveLength(1);
      expect(logs[0].values).toMatchObject({
        email: "return-delete@example.com",
        name: "Delete Me",
      });
    });
  });

  describe("Return value handling", () => {
    it("should return data when .returning() is auto-injected", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: { [TABLE_NAME]: { primaryKey: "id" } },
      });

      const { db } = auditLogger;

      // Without .returning(), Drizzle normally returns query metadata
      const result = await db.insert(testUsers).values({
        email: "no-return@example.com",
        name: "No Return",
      });

      // Auto-injected .returning() returns inserted rows
      expect(Array.isArray(result)).toBe(true);
      expect(result[0]).toHaveProperty("id");
      expect(result[0].email).toBe("no-return@example.com");
    });

    it("should return inserted data when user calls .returning()", async () => {
      const auditLogger = createAuditLogger(originalDb, {
        tables: { [TABLE_NAME]: { primaryKey: "id" } },
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
