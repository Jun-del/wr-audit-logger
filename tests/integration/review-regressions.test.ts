import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, serial, text, varchar } from "drizzle-orm/pg-core";
import { Client, Pool } from "pg";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createAuditLogger, auditLogs, AuditDeliveryError } from "../../src/index.js";

const TEST_ID = `regress_${Date.now()}_${Math.random().toString(36).substring(7)}`;
const USERS_TABLE = `regress_users_${TEST_ID}`;

const users = pgTable(USERS_TABLE, {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: text("name"),
  password: text("password"),
});

const describeIntegration =
  process.env.AUDIT_RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;

/** Fails the test instead of hanging forever when a promise never settles. */
function settleWithin<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`promise did not settle within ${ms}ms`)), ms),
    ),
  ]);
}

describeIntegration("Review regressions", () => {
  let client: Client;
  let originalDb: any;

  const auditRows = () =>
    originalDb.select().from(auditLogs).where(eq(auditLogs.tableName, USERS_TABLE));

  const makeLogger = (config: Record<string, unknown> = {}, db = originalDb) =>
    createAuditLogger(db, {
      tables: { [USERS_TABLE]: { primaryKey: "id" } },
      excludeFields: ["password"],
      ...config,
    } as any);

  beforeAll(async () => {
    client = new Client(process.env.DATABASE_URL);
    await client.connect();
    originalDb = drizzle({ client });
    await originalDb.execute(`
      CREATE TABLE "${USERS_TABLE}" (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        name TEXT,
        password TEXT
      )
    `);
  });

  afterAll(async () => {
    await originalDb.execute(`DROP TABLE IF EXISTS "${USERS_TABLE}" CASCADE`);
    await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${USERS_TABLE}'`);
    await client.end();
  });

  beforeEach(async () => {
    await originalDb.execute(`TRUNCATE TABLE "${USERS_TABLE}" RESTART IDENTITY CASCADE`);
    await originalDb.execute(`DELETE FROM audit_logs WHERE table_name = '${USERS_TABLE}'`);
  });

  describe("failed queries", () => {
    it("rejects an awaited query instead of hanging", async () => {
      const { db } = makeLogger();
      await db.insert(users).values({ email: "dup@example.com" });

      const attempt = (async () => {
        try {
          await db.insert(users).values({ email: "dup@example.com" });
          return "inserted";
        } catch {
          return "caught";
        }
      })();

      await expect(settleWithin(attempt)).resolves.toBe("caught");
    });

    it("passes errors to .then(_, onRejected) and .catch()", async () => {
      const { db } = makeLogger();
      await db.insert(users).values({ email: "dup@example.com" });

      const viaThen = db
        .insert(users)
        .values({ email: "dup@example.com" })
        .then(
          () => "fulfilled",
          () => "rejected",
        );
      await expect(settleWithin(viaThen)).resolves.toBe("rejected");

      const viaCatch = db
        .insert(users)
        .values({ email: "dup@example.com" })
        .catch(() => "caught");
      await expect(settleWithin(viaCatch)).resolves.toBe("caught");
    });
  });

  describe(".execute() and prepared statements", () => {
    it("audits .execute() without throwing", async () => {
      const { db } = makeLogger();

      await db.insert(users).values({ email: "exec@example.com" }).execute();

      const logs = await auditRows();
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe("INSERT");
      expect(logs[0].recordId).toBe("1");
    });

    it("audits prepared statements with placeholders", async () => {
      const { db } = makeLogger();
      await originalDb.insert(users).values({ email: "prep@example.com", name: "Old" });

      const prepared = db
        .update(users)
        .set({ name: sql.placeholder("name") })
        .where(eq(users.id, sql.placeholder("id")))
        .prepare(`regress_update_${TEST_ID}`);

      await prepared.execute({ id: 1, name: "New" });

      const logs = await auditRows();
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe("UPDATE");
      expect(logs[0].values).toEqual({ id: 1, email: "prep@example.com", name: "New" });
    });

    it("captures a locked diff for prepared updates inside a transaction", async () => {
      const { db } = makeLogger();
      await originalDb.insert(users).values({ email: "prep-tx@example.com", name: "Old" });

      await db.transaction(async (tx: any) => {
        const prepared = tx
          .update(users)
          .set({ name: sql.placeholder("name") })
          .where(eq(users.id, sql.placeholder("id")))
          .prepare(`regress_tx_update_${TEST_ID}`);
        await prepared.execute({ id: 1, name: "New" });
      });

      expect((await auditRows())[0].values).toEqual({ name: "New" });
    });
  });

  describe("result shape without .returning()", () => {
    it("still exposes the affected row count", async () => {
      const { db } = makeLogger();
      await originalDb
        .insert(users)
        .values([{ email: "a@example.com" }, { email: "b@example.com" }]);

      const result: any = await db.delete(users);

      expect(result.rowCount).toBe(2);
      expect((await auditRows()).filter((l: any) => l.action === "DELETE")).toHaveLength(2);
    });
  });

  describe("partial .returning() selections", () => {
    it.each([false, true])(
      "keeps audit columns separate from reserved-looking aliases (prepared=%s)",
      async (prepared) => {
        const { db } = makeLogger();
        const query = db
          .insert(users)
          .values({ email: "collision@example.com", name: "Alias" })
          .returning({
            __audit__id: users.name,
            __audit__id_: users.email,
            __audit__forged: sql<string>`'not a real column'`,
          });

        const rows = prepared
          ? await query.prepare(`alias_collision_${TEST_ID}`).execute()
          : await query;

        expect(rows).toEqual([
          {
            __audit__id: "Alias",
            __audit__id_: "collision@example.com",
            __audit__forged: "not a real column",
          },
        ]);
        const logs = await auditRows();
        expect(logs).toHaveLength(1);
        expect(logs[0].recordId).toBe("1");
        expect(logs[0].values).toEqual({ id: 1, email: "collision@example.com", name: "Alias" });
      },
    );

    it("returns renamed fields and still audits the full row", async () => {
      const { db } = makeLogger();

      const rows = await db
        .insert(users)
        .values({ email: "alias@example.com", name: "Alias" })
        .returning({ userId: users.id, upper: sql<string>`upper(${users.email})` });

      expect(rows).toEqual([{ userId: 1, upper: "ALIAS@EXAMPLE.COM" }]);

      const logs = await auditRows();
      expect(logs).toHaveLength(1);
      expect(logs[0].values).toMatchObject({ id: 1, email: "alias@example.com", name: "Alias" });
    });
  });

  describe("transactions", () => {
    it.each(["await", "execute", "prepared"])(
      "does not lose a concurrent update outside a transaction (%s)",
      async (execution) => {
        await originalDb.insert(users).values({ email: "race@example.com", name: "Alice" });
        const competitor = new Client(process.env.DATABASE_URL);
        await competitor.connect();
        const originalQuery = client.query.bind(client);
        let raced = false;
        const querySpy = vi.spyOn(client, "query").mockImplementation(async (...args: any[]) => {
          const queryText = typeof args[0] === "string" ? args[0] : args[0].text;
          if (!raced && queryText.startsWith(`update "${USERS_TABLE}"`)) {
            raced = true;
            // If the logger took an unlocked snapshot, it still says Alice here.
            await competitor.query(`UPDATE "${USERS_TABLE}" SET name = 'Bob' WHERE id = 1`);
          }
          return (originalQuery as any)(...args);
        });

        try {
          const { db } = makeLogger();
          const query = db.update(users).set({ name: "Alice" }).where(eq(users.id, 1));
          if (execution === "prepared") {
            await query.prepare(`race_${TEST_ID}`).execute();
          } else if (execution === "execute") {
            await query.execute();
          } else {
            await query;
          }

          expect(raced).toBe(true);
          const logs = await auditRows();
          expect(logs).toHaveLength(1);
          expect(logs[0].values).toEqual({ id: 1, email: "race@example.com", name: "Alice" });
        } finally {
          querySpy.mockRestore();
          await competitor.end();
        }
      },
    );

    it.each(["immediate", "batch", "nested"])(
      "distinguishes custom-writer errors after commit (%s)",
      async (mode) => {
        const cause = new Error("sink unavailable");
        const logger = makeLogger({
          strictMode: true,
          customWriter: vi.fn().mockRejectedValue(cause),
          ...(mode === "batch" ? { batch: { batchSize: 100 } } : {}),
        });
        try {
          const attempt = logger.db.transaction(async (tx: any) => {
            const insert = (executor: any) =>
              executor.insert(users).values({ email: "committed@example.com" });
            if (mode === "nested") {
              await tx.transaction(insert);
            } else {
              await insert(tx);
            }
          });

          await expect(attempt).rejects.toBeInstanceOf(AuditDeliveryError);
          await expect(attempt).rejects.toMatchObject({
            name: "AuditDeliveryError",
            code: "AUDIT_DELIVERY_FAILED_AFTER_COMMIT",
            committed: true,
            transactionId: expect.any(String),
            cause,
          });
          expect(await originalDb.select().from(users)).toHaveLength(1);
        } finally {
          await logger.shutdown();
        }
      },
    );

    it("reports non-strict custom-writer failures as committed without rejecting", async () => {
      const cause = new Error("sink unavailable");
      const logError = vi.fn();
      const { db } = makeLogger({ customWriter: vi.fn().mockRejectedValue(cause), logError });

      await expect(
        db.transaction(async (tx: any) => {
          await tx.insert(users).values({ email: "non-strict-committed@example.com" });
          return "committed";
        }),
      ).resolves.toBe("committed");

      expect(logError).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          name: "AuditDeliveryError",
          committed: true,
          cause,
        }),
      );
    });

    it("writes no audit rows when the transaction rolls back", async () => {
      const { db } = makeLogger();

      await expect(
        db.transaction(async (tx: any) => {
          await tx.insert(users).values({ email: "rollback@example.com" });
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");

      expect(await auditRows()).toHaveLength(0);
    });

    it("writes audit rows atomically with a committed transaction", async () => {
      const { db } = makeLogger();

      await db.transaction(async (tx: any) => {
        await tx.insert(users).values({ email: "t1@example.com" });
        await tx.insert(users).values({ email: "t2@example.com" });
      });

      const logs = await auditRows();
      expect(logs).toHaveLength(2);
      expect(logs[0].transactionId).toBeTruthy();
      expect(logs[1].transactionId).toBe(logs[0].transactionId);
    });

    it("does not deadlock on a single-connection pool", async () => {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
      try {
        const { db } = makeLogger({}, drizzle({ client: pool }));

        await settleWithin(
          db.transaction(async (tx: any) => {
            await tx.insert(users).values({ email: "pool@example.com" });
          }),
        );

        expect(await auditRows()).toHaveLength(1);
      } finally {
        await pool.end();
      }
    });

    it("keeps the user's transaction alive when a non-strict audit write fails", async () => {
      const logError = vi.fn();
      const { db } = makeLogger({ auditTable: "missing_audit_table", logError });

      await db.transaction(async (tx: any) => {
        await tx.insert(users).values({ email: "survivor@example.com" });
        await tx.insert(users).values({ email: "survivor2@example.com" });
      });

      const rows = await originalDb.select().from(users);
      expect(rows).toHaveLength(2);
      expect(logError).toHaveBeenCalled();
    });

    it("locks before-state rows inside a transaction", async () => {
      const queries: string[] = [];
      const loggedDb = drizzle({
        client,
        logger: { logQuery: (query: string) => queries.push(query) },
      });
      const { db } = makeLogger({}, loggedDb);
      await originalDb.insert(users).values({ email: "lock@example.com", name: "Old" });

      await db.transaction(async (tx: any) => {
        await tx.update(users).set({ name: "New" }).where(eq(users.id, 1));
      });

      expect(queries.some((q) => /select .* for update/i.test(q))).toBe(true);
      expect((await auditRows())[0].values).toEqual({ name: "New" });
    });

    it("skips unlocked snapshots outside transactions", async () => {
      await originalDb.insert(users).values({ email: "snapshot@example.com", name: "Old" });
      const queries: string[] = [];
      const { db } = makeLogger(
        {},
        drizzle({
          client,
          logger: { logQuery: (query: string) => queries.push(query) },
        }),
      );

      await db.update(users).set({ name: "New" }).where(eq(users.id, 1));

      expect(queries.some((q) => /^select /i.test(q))).toBe(false);
      expect((await auditRows())[0].values).toEqual({
        id: 1,
        email: "snapshot@example.com",
        name: "New",
      });
    });

    it("logs matched unchanged rows outside transactions as full after-state", async () => {
      const { db } = makeLogger();
      await originalDb.insert(users).values({ email: "noop@example.com", name: "Same" });
      await db.update(users).set({ name: "Same" }).where(eq(users.id, 1));
      const logs = await auditRows();
      expect(logs).toHaveLength(1);
      expect(logs[0].values).toEqual({ id: 1, email: "noop@example.com", name: "Same" });
    });

    it("runs custom writers only after commit", async () => {
      const customWriter = vi.fn();
      const { db } = makeLogger({ customWriter });
      const abort = new Error("abort");

      await expect(
        db.transaction(async (tx: any) => {
          await tx.insert(users).values({ email: "cw-rollback@example.com" });
          throw abort;
        }),
      ).rejects.toBe(abort);
      expect(customWriter).not.toHaveBeenCalled();

      await db.transaction(async (tx: any) => {
        await tx.insert(users).values({ email: "cw-commit@example.com" });
        expect(customWriter).not.toHaveBeenCalled();
      });
      expect(customWriter).toHaveBeenCalledTimes(1);
    });
  });

  describe("excluded fields", () => {
    it("records a redacted change when only an excluded field changes", async () => {
      const { db } = makeLogger();
      await originalDb.insert(users).values({ email: "pw@example.com", password: "old-hash" });

      await db.transaction(async (tx: any) => {
        await tx.update(users).set({ password: "new-hash" }).where(eq(users.id, 1));
      });

      const logs = await auditRows();
      expect(logs).toHaveLength(1);
      expect(logs[0].values).toEqual({ password: "[REDACTED]" });
    });

    it("logs excluded-only updates outside a transaction without storing their values", async () => {
      const { db } = makeLogger();
      await originalDb.insert(users).values({ email: "pw-full@example.com", password: "old-hash" });

      await db.update(users).set({ password: "new-hash" }).where(eq(users.id, 1));

      const logs = await auditRows();
      expect(logs).toHaveLength(1);
      expect(logs[0].values).toEqual({ id: 1, email: "pw-full@example.com", name: null });
    });
  });

  describe("non-strict mode", () => {
    it("does not fail the user's query when building the audit log fails", async () => {
      const logError = vi.fn();
      const { db } = createAuditLogger(originalDb, {
        tables: { [USERS_TABLE]: { primaryKey: "missing_column" } },
        logError,
      } as any);

      const rows = await db.insert(users).values({ email: "pk@example.com" }).returning();

      expect(rows).toHaveLength(1);
      expect(logError).toHaveBeenCalled();
    });

    it("still fails the query in strict mode", async () => {
      const { db } = createAuditLogger(originalDb, {
        tables: { [USERS_TABLE]: { primaryKey: "missing_column" } },
        strictMode: true,
      } as any);

      await expect(db.insert(users).values({ email: "strict@example.com" })).rejects.toThrow(
        /primaryKey/,
      );
    });
  });

  describe("context resolution", () => {
    it("prefers the explicit context userId over getUserId()", async () => {
      const { db, withContext } = makeLogger({ getUserId: () => "fallback-user" });

      await withContext({ userId: "explicit-user" }, async () => {
        await db.insert(users).values({ email: "ctx@example.com" });
      });
      await db.insert(users).values({ email: "ctx2@example.com" });

      const logs = await auditRows();
      expect(logs.map((l: any) => l.userId).sort()).toEqual(["explicit-user", "fallback-user"]);
    });

    it("passes getUserId/getMetadata through to custom writers", async () => {
      const customWriter = vi.fn();
      const { db } = makeLogger({
        customWriter,
        getUserId: () => "resolved-user",
        getMetadata: () => ({ requestId: "req-1" }),
      });

      await db.insert(users).values({ email: "cw@example.com" });

      const [logs, context] = customWriter.mock.calls[0]!;
      expect(context.userId).toBe("resolved-user");
      expect(logs[0].metadata).toEqual({ requestId: "req-1" });
    });

    it("keeps each log's context in batched custom writers", async () => {
      const customWriter = vi.fn();
      const logger = makeLogger({ customWriter, batch: { batchSize: 100, flushInterval: 60000 } });

      await logger.withContext({ userId: "u1", ipAddress: "10.0.0.1" }, async () => {
        await logger.db.insert(users).values({ email: "b1@example.com" });
      });
      await logger.withContext({ userId: "u1", ipAddress: "10.0.0.2" }, async () => {
        await logger.db.insert(users).values({ email: "b2@example.com" });
      });
      await logger.shutdown();

      const ips = customWriter.mock.calls.map(([, context]) => context.ipAddress).sort();
      expect(ips).toEqual(["10.0.0.1", "10.0.0.2"]);
    });
  });
});
