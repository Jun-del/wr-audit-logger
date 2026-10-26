import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createAuditLogger, auditLogs } from "../../src/index.js";

const TEST_ID = `sqlb_${Date.now()}_${Math.random().toString(36).substring(7)}`;
const TABLE = `sql_builder_users_${TEST_ID}`;
const users = pgTable(TABLE, { id: serial("id").primaryKey(), name: text("name") });

const describeIntegration =
  process.env.AUDIT_RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeIntegration("sql`...` inside query builders", () => {
  let client: Client;
  let originalDb: any;
  let db: any;

  const auditRows = () => originalDb.select().from(auditLogs).where(eq(auditLogs.tableName, TABLE));

  beforeAll(async () => {
    client = new Client(process.env.DATABASE_URL);
    await client.connect();
    originalDb = drizzle({ client });
    await originalDb.execute(`CREATE TABLE "${TABLE}" (id SERIAL PRIMARY KEY, name TEXT)`);
    db = createAuditLogger(originalDb, { tables: { [TABLE]: { primaryKey: "id" } } } as any).db;
  });

  afterAll(async () => {
    await originalDb.execute(`DROP TABLE IF EXISTS "${TABLE}"`);
    await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${TABLE}'`);
    await client.end();
  });

  beforeEach(async () => {
    await originalDb.execute(`TRUNCATE TABLE "${TABLE}" RESTART IDENTITY`);
    await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${TABLE}'`);
  });

  it("audits inserts with sql values", async () => {
    await db.insert(users).values({ name: sql`upper('alice')` });

    const logs = await auditRows();
    expect(logs).toHaveLength(1);
    expect(logs[0].values).toEqual({ id: 1, name: "ALICE" });
  });

  it("audits updates with sql in set", async () => {
    await originalDb.insert(users).values({ name: "OLD" });

    await db
      .update(users)
      .set({ name: sql`lower(${users.name})` })
      .where(eq(users.id, 1));

    const logs = await auditRows();
    expect(logs).toHaveLength(1);
    expect(logs[0].values).toEqual({ id: 1, name: "old" });
  });

  it("audits deletes with a raw sql where clause", async () => {
    await originalDb.insert(users).values({ name: "Alice" });

    await db.delete(users).where(sql`id = 1`);

    const logs = await auditRows();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("DELETE");
  });
});
