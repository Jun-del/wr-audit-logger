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
      shouldCaptureBeforeState: vi.fn().mockReturnValue(false),
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
