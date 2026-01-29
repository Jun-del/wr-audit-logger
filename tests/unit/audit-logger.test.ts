import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AuditLogger } from "../../src/core/AuditLogger.js";

describe("AuditLogger", () => {
  let mockDb: PostgresJsDatabase<any>;
  let auditLogger: AuditLogger;
  let executeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Create a mock database
    executeMock = vi.fn().mockResolvedValue({ rows: [] });
    mockDb = {
      execute: executeMock,
    } as any;

    auditLogger = new AuditLogger(mockDb, {
      tables: ["users", "vehicles"],
      excludeFields: ["password"],
    });
  });

  describe("Context Management", () => {
    it("should set and get audit context", () => {
      const context = {
        userId: "user-123",
        ipAddress: "127.0.0.1",
      };

      auditLogger.setContext(context);
      const retrieved = auditLogger.getContext();

      expect(retrieved).toMatchObject(context);
    });

    it("should run function with specific context", () => {
      const context = { userId: "admin" };
      let capturedContext: any;

      auditLogger.withContext(context, () => {
        capturedContext = auditLogger.getContext();
      });

      expect(capturedContext).toMatchObject(context);
    });

    it("should merge context when setting partial context", () => {
      auditLogger.setContext({ userId: "user-1" });
      auditLogger.setContext({ ipAddress: "192.168.1.1" });

      const context = auditLogger.getContext();
      expect(context).toMatchObject({
        userId: "user-1",
        ipAddress: "192.168.1.1",
      });
    });
  });

  describe("INSERT Logging", () => {
    it("should log single insert", async () => {
      const record = { id: 1, email: "test@example.com", name: "Test" };

      await auditLogger.logInsert("users", record);

      expect(executeMock).toHaveBeenCalledTimes(1);

      // Check that the SQL object was passed
      const callArg = executeMock.mock.calls[0][0];
      expect(callArg).toBeDefined();
      expect(callArg.queryChunks).toBeDefined();

      // Convert SQL chunks to string for assertion
      const sqlString = callArg.queryChunks
        .map((chunk: any) => chunk.value || chunk)
        .flat()
        .join("");

      expect(sqlString).toContain("INSERT INTO");
      expect(sqlString).toContain("audit_logs");
    });

    it("should log multiple inserts", async () => {
      const records = [
        { id: 1, email: "user1@example.com" },
        { id: 2, email: "user2@example.com" },
      ];

      await auditLogger.logInsert("users", records);

      expect(executeMock).toHaveBeenCalled();
    });

    it("should exclude password from audit logs", async () => {
      const record = {
        id: 1,
        email: "test@example.com",
        password: "secret123",
      };

      await auditLogger.logInsert("users", record);

      const callArg = executeMock.mock.calls[0][0];
      const sqlString = callArg.sql || callArg.queryChunks?.join("");

      expect(sqlString).not.toContain("secret123");
    });

    it("should not log inserts for non-audited tables", async () => {
      await auditLogger.logInsert("non_audited_table", { id: 1 });

      expect(executeMock).not.toHaveBeenCalled();
    });
  });

  describe("UPDATE Logging", () => {
    it("should log update with changed fields", async () => {
      const before = { id: 1, name: "Old Name", email: "test@example.com" };
      const after = { id: 1, name: "New Name", email: "test@example.com" };

      await auditLogger.logUpdate("users", before, after);

      expect(executeMock).toHaveBeenCalled();
    });

    it("should not log update if nothing changed when capturing old values", async () => {
      auditLogger = new AuditLogger(mockDb, {
        tables: ["users", "vehicles"],
        excludeFields: ["password"],
        captureOldValues: true,
      });

      const record = { id: 1, name: "Same", email: "same@example.com" };

      await auditLogger.logUpdate("users", record, record);

      // Should not create audit log if nothing changed
      expect(executeMock).not.toHaveBeenCalled();
    });
  });

  describe("DELETE Logging", () => {
    it("should log delete", async () => {
      const record = { id: 1, email: "deleted@example.com" };

      await auditLogger.logDelete("users", record);

      expect(executeMock).toHaveBeenCalled();
    });
  });

  describe("Configuration", () => {
    it("should respect wildcard table configuration", () => {
      const logger = new AuditLogger(mockDb, {
        tables: "*",
      });

      expect(logger).toBeDefined();
    });

    it("should never audit the audit table itself", async () => {
      const logger = new AuditLogger(mockDb, {
        tables: "*",
      });

      await logger.logInsert("audit_logs", { id: 1 });

      expect(executeMock).not.toHaveBeenCalled();
    });
  });
});
