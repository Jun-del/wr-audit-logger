import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getAuditStats } from "../../src/index.js";

const TEST_ID = `stats_${Date.now()}_${Math.random().toString(36).substring(7)}`;
const TABLE_NAME = `stats_table_${TEST_ID}`;

describe("Audit stats (Integration)", () => {
  let client: Client;
  let db: any;

  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error("DATABASE_URL is not set");
    }

    client = new Client(dbUrl);
    await client.connect();
    db = drizzle(client);
  });

  afterAll(async () => {
    await db.execute(`DELETE FROM audit_logs WHERE table_name = '${TABLE_NAME}'`);
    await client.end();
  });

  it("computes totals and aggregates correctly", async () => {
    await db.execute(`DELETE FROM audit_logs WHERE table_name = '${TABLE_NAME}'`);
    const before = await getAuditStats(db);

    await db.execute(`
      INSERT INTO audit_logs (action, table_name, record_id, created_at)
      VALUES
        ('READ', '${TABLE_NAME}', '1', NOW()),
        ('READ', '${TABLE_NAME}', '2', NOW()),
        ('EXPORT', '${TABLE_NAME}', '3', NOW())
    `);

    const after = await getAuditStats(db);

    const beforeRead = Number(before.logsByAction?.READ ?? 0);
    const beforeExport = Number(before.logsByAction?.EXPORT ?? 0);
    const beforeTable = Number(before.logsByTable?.[TABLE_NAME] ?? 0);

    expect(Number(after.logsByAction?.READ ?? 0)).toBe(beforeRead + 2);
    expect(Number(after.logsByAction?.EXPORT ?? 0)).toBe(beforeExport + 1);
    expect(Number(after.logsByTable?.[TABLE_NAME] ?? 0)).toBe(beforeTable + 3);
  });
});
