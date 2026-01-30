import { sql } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInterceptedDb } from "../../src/core/interceptor.js";

describe("Raw SQL execution", () => {
  let executeMock: ReturnType<typeof vi.fn>;
  let db: any;
  let auditLogger: any;

  beforeEach(() => {
    executeMock = vi.fn().mockResolvedValue({ rows: [] });
    db = { execute: executeMock };
    auditLogger = {
      shouldAudit: vi.fn().mockReturnValue(true),
      shouldCaptureOldValues: vi.fn().mockReturnValue(false),
      logInsert: vi.fn(),
      logUpdate: vi.fn(),
      logDelete: vi.fn(),
      getContext: vi.fn(),
      withContext: vi.fn(),
    };
  });

  it("does not auto-audit when using db.execute with a raw SQL string", async () => {
    const auditedDb = createInterceptedDb(db, auditLogger);

    await auditedDb.execute("INSERT INTO users (id, name) VALUES (1, 'Alice')");

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(auditLogger.shouldAudit).not.toHaveBeenCalled();
    expect(auditLogger.logInsert).not.toHaveBeenCalled();
    expect(auditLogger.logUpdate).not.toHaveBeenCalled();
    expect(auditLogger.logDelete).not.toHaveBeenCalled();
  });

  it("does not auto-audit when using db.execute with drizzle sql`...`", async () => {
    const auditedDb = createInterceptedDb(db, auditLogger);

    await auditedDb.execute(sql`INSERT INTO users (id, name) VALUES (2, 'Bob')`);

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(auditLogger.shouldAudit).not.toHaveBeenCalled();
    expect(auditLogger.logInsert).not.toHaveBeenCalled();
    expect(auditLogger.logUpdate).not.toHaveBeenCalled();
    expect(auditLogger.logDelete).not.toHaveBeenCalled();
  });
});

describe("sql`...` inside query builders", () => {
  const makeAuditLogger = () => ({
    shouldAudit: vi.fn().mockReturnValue(true),
    shouldCaptureOldValues: vi.fn().mockReturnValue(false),
    logInsert: vi.fn(),
    logUpdate: vi.fn(),
    logDelete: vi.fn(),
    getContext: vi.fn(),
    withContext: vi.fn(),
  });

  it("still audits when used in insert values", async () => {
    const table = { _: { name: "users" } };
    const resultRows = [{ id: 1, name: "Alice" }];

    const builder = {
      table,
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnThis(),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(resultRows).then(onFulfilled, onRejected),
    };

    const db = {
      insert: vi.fn().mockReturnValue(builder),
    };

    const auditLogger = makeAuditLogger();

    const auditedDb = createInterceptedDb(db as any, auditLogger as any);

    await auditedDb.insert(table).values({ name: sql`NOW()` });

    expect(auditLogger.shouldAudit).toHaveBeenCalledWith("users");
    expect(auditLogger.logInsert).toHaveBeenCalledWith("users", resultRows);
    expect(auditLogger.logUpdate).not.toHaveBeenCalled();
    expect(auditLogger.logDelete).not.toHaveBeenCalled();
  });

  it("still audits when used in update set", async () => {
    const table = { _: { name: "users" } };
    const beforeRows = [{ id: 1, name: "Old" }];
    const afterRows = [{ id: 1, name: "New" }];

    const builder = {
      table,
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnThis(),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(afterRows).then(onFulfilled, onRejected),
      config: { where: { id: 1 } },
    };

    const db = {
      update: vi.fn().mockReturnValue(builder),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(beforeRows),
      }),
    };

    const auditLogger = makeAuditLogger();
    auditLogger.shouldCaptureOldValues.mockReturnValue(true);

    const auditedDb = createInterceptedDb(db as any, auditLogger as any);

    await auditedDb
      .update(table)
      .set({ name: sql`LOWER(name)` })
      .where({ id: 1 });

    expect(auditLogger.shouldAudit).toHaveBeenCalledWith("users");
    expect(auditLogger.logUpdate).toHaveBeenCalledWith("users", beforeRows, afterRows);
    expect(auditLogger.logInsert).not.toHaveBeenCalled();
    expect(auditLogger.logDelete).not.toHaveBeenCalled();
  });

  it("still audits when used in delete returning", async () => {
    const table = { _: { name: "users" } };
    const deletedRows = [{ id: 1, name: "Alice" }];

    const builder = {
      table,
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnThis(),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(deletedRows).then(onFulfilled, onRejected),
    };

    const db = {
      delete: vi.fn().mockReturnValue(builder),
    };

    const auditLogger = makeAuditLogger();

    const auditedDb = createInterceptedDb(db as any, auditLogger as any);

    await auditedDb.delete(table).where(sql`id = 1`);

    expect(auditLogger.shouldAudit).toHaveBeenCalledWith("users");
    expect(auditLogger.logDelete).toHaveBeenCalledWith("users", deletedRows);
    expect(auditLogger.logInsert).not.toHaveBeenCalled();
    expect(auditLogger.logUpdate).not.toHaveBeenCalled();
  });

  it("does not audit when shouldAudit returns false", async () => {
    const table = { _: { name: "users" } };
    const builder = {
      table,
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnThis(),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve([{ id: 1 }]).then(onFulfilled, onRejected),
    };

    const db = {
      insert: vi.fn().mockReturnValue(builder),
    };

    const auditLogger = makeAuditLogger();
    auditLogger.shouldAudit.mockReturnValue(false);

    const auditedDb = createInterceptedDb(db as any, auditLogger as any);

    await auditedDb.insert(table).values({ name: sql`NOW()` });

    expect(auditLogger.shouldAudit).toHaveBeenCalledWith("users");
    expect(auditLogger.logInsert).not.toHaveBeenCalled();
    expect(auditLogger.logUpdate).not.toHaveBeenCalled();
    expect(auditLogger.logDelete).not.toHaveBeenCalled();
  });
});
