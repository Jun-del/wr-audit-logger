import type { NormalizedConfig } from "../../src/types/config.js";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDeleteAuditLogs } from "../../src/capture/delete.js";
import { createInsertAuditLogs } from "../../src/capture/insert.js";
import { createUpdateAuditLogs } from "../../src/capture/update.js";
import { DEFAULT_AUDIT_COLUMN_MAP } from "../../src/storage/column-map.js";

describe("Capture Configuration (Unit Tests)", () => {
  let mockConfig: NormalizedConfig;

  beforeEach(() => {
    mockConfig = {
      tables: ["test_users"],
      fields: {},
      primaryKeyMap: {},
      excludeFields: ["password"],
      auditTable: "audit_logs",
      auditColumnMap: DEFAULT_AUDIT_COLUMN_MAP,
      strictMode: false,
      getUserId: vi.fn().mockReturnValue(undefined),
      getMetadata: vi.fn().mockReturnValue({}),
      logError: vi.fn(),
      updateValuesMode: "full",
      batch: null,
      customWriter: undefined,
    };
  });

  describe("INSERT capture", () => {
    it("should capture inserted records", () => {
      const records = [
        { id: 1, email: "test@example.com", name: "Test User" },
        { id: 2, email: "test2@example.com", name: "Test User 2" },
      ];

      const logs = createInsertAuditLogs("test_users", records, mockConfig);

      expect(logs).toHaveLength(2);
      expect(logs[0]).toMatchObject({
        action: "INSERT",
        tableName: "test_users",
        recordId: "1",
        values: {
          id: 1,
          email: "test@example.com",
          name: "Test User",
        },
      });
    });

    it("should exclude configured fields from capture", () => {
      const record = {
        id: 1,
        email: "test@example.com",
        password: "secret123",
      };

      const logs = createInsertAuditLogs("test_users", [record], mockConfig);

      expect(logs[0].values).toMatchObject({
        id: 1,
        email: "test@example.com",
      });
      expect(logs[0].values).not.toHaveProperty("password");
    });
  });

  describe('UPDATE capture with updateValuesMode="changed"', () => {
    beforeEach(() => {
      mockConfig.updateValuesMode = "changed";
    });

    it("should capture only changed values when enabled", () => {
      const beforeRecords = [{ id: 1, email: "old@example.com", name: "Old Name" }];
      const afterRecords = [{ id: 1, email: "new@example.com", name: "New Name" }];

      const logs = createUpdateAuditLogs("test_users", beforeRecords, afterRecords, mockConfig);

      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        action: "UPDATE",
        tableName: "test_users",
        recordId: "1",
        values: {
          email: "new@example.com",
          name: "New Name",
        },
      });
    });

    it("should not create log if nothing changed", () => {
      const record = { id: 1, email: "same@example.com", name: "Same" };

      const logs = createUpdateAuditLogs("test_users", [record], [record], mockConfig);

      expect(logs).toHaveLength(0);
    });

    it("should detect partial changes", () => {
      const beforeRecords = [{ id: 1, email: "test@example.com", name: "Old Name" }];
      const afterRecords = [{ id: 1, email: "test@example.com", name: "New Name" }];

      const logs = createUpdateAuditLogs("test_users", beforeRecords, afterRecords, mockConfig);

      expect(logs[0].values).toMatchObject({ name: "New Name" });
    });

    it("should log new values when before state is missing", () => {
      const afterRecords = [{ id: 1, email: "new@example.com", name: "New Name" }];

      const logs = createUpdateAuditLogs("test_users", [], afterRecords, mockConfig);

      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        action: "UPDATE",
        tableName: "test_users",
        recordId: "1",
        values: {
          id: 1,
          email: "new@example.com",
          name: "New Name",
        },
      });
    });

    it("should mix old+new and new-only logs when partial before state is missing", () => {
      const beforeRecords = [{ id: 1, email: "old@example.com", name: "Old Name" }];
      const afterRecords = [
        { id: 1, email: "new@example.com", name: "New Name" },
        { id: 2, email: "missing@example.com", name: "Missing Before" },
      ];

      const logs = createUpdateAuditLogs("test_users", beforeRecords, afterRecords, mockConfig);

      expect(logs).toHaveLength(2);

      const logWithBefore = logs.find((log) => log.recordId === "1");
      const logWithoutBefore = logs.find((log) => log.recordId === "2");

      expect(logWithBefore?.values).toMatchObject({ email: "new@example.com", name: "New Name" });
      expect(logWithoutBefore?.values).toMatchObject({
        id: 2,
        email: "missing@example.com",
        name: "Missing Before",
      });
    });
  });

  describe('UPDATE capture with updateValuesMode="full"', () => {
    beforeEach(() => {
      mockConfig.updateValuesMode = "full";
    });

    it("should capture full after values when in full mode", () => {
      const beforeRecords: any[] = []; // Empty - no before state captured
      const afterRecords = [{ id: 1, email: "new@example.com", name: "New Name" }];

      const logs = createUpdateAuditLogs("test_users", beforeRecords, afterRecords, mockConfig);

      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        action: "UPDATE",
        tableName: "test_users",
        recordId: "1",
        values: {
          id: 1,
          email: "new@example.com",
          name: "New Name",
        },
      });
    });

    it("should still create audit log even without old values", () => {
      const afterRecords = [
        { id: 1, email: "updated@example.com", name: "Updated" },
        { id: 2, email: "updated2@example.com", name: "Updated 2" },
      ];

      const logs = createUpdateAuditLogs("test_users", [], afterRecords, mockConfig);

      expect(logs).toHaveLength(2);
      logs.forEach((log) => {
        expect(log.values).toBeDefined();
      });
    });
  });

  describe("DELETE capture", () => {
    it("should capture deleted records", () => {
      const deletedRecords = [{ id: 1, email: "deleted@example.com", name: "Deleted User" }];

      const logs = createDeleteAuditLogs("test_users", deletedRecords, mockConfig);

      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        action: "DELETE",
        tableName: "test_users",
        recordId: "1",
        values: {
          id: 1,
          email: "deleted@example.com",
          name: "Deleted User",
        },
      });
    });

    it("should handle multiple deletions", () => {
      const deletedRecords = [
        { id: 1, email: "user1@example.com", name: "User 1" },
        { id: 2, email: "user2@example.com", name: "User 2" },
        { id: 3, email: "user3@example.com", name: "User 3" },
      ];

      const logs = createDeleteAuditLogs("test_users", deletedRecords, mockConfig);

      expect(logs).toHaveLength(3);
      expect(logs.map((l) => l.recordId)).toEqual(["1", "2", "3"]);
    });
  });

  describe("Primary key overrides", () => {
    it("should use primaryKeyMap for recordId", () => {
      mockConfig.primaryKeyMap = { electricity_bill: "jobid" };
      const records = [{ jobid: "job-1", amount: 100 }];

      const logs = createInsertAuditLogs("electricity_bill", records, mockConfig);

      expect(logs[0].recordId).toBe("job-1");
    });

    it("should match updates using configured primary key", () => {
      mockConfig.primaryKeyMap = { electricity_bill: "jobid" };
      mockConfig.updateValuesMode = "changed";
      const beforeRecords = [{ jobid: "job-1", amount: 100 }];
      const afterRecords = [{ jobid: "job-1", amount: 120 }];

      const logs = createUpdateAuditLogs(
        "electricity_bill",
        beforeRecords,
        afterRecords,
        mockConfig,
      );

      expect(logs).toHaveLength(1);
      expect(logs[0].recordId).toBe("job-1");
      expect(logs[0].values).toEqual({ amount: 120 });
    });

    it("should support composite primary keys", () => {
      mockConfig.primaryKeyMap = { ledger: ["org_id", "entry_id"] };
      const records = [{ org_id: 7, entry_id: "e-9", amount: 50 }];

      const logs = createInsertAuditLogs("ledger", records, mockConfig);

      expect(logs[0].recordId).toBe('{"org_id":7,"entry_id":"e-9"}');
    });
  });

  describe("Field filtering", () => {
    it("should respect fields configuration when provided", () => {
      mockConfig.fields = {
        test_users: ["id", "email"], // Only track these fields
      };

      const record = {
        id: 1,
        email: "test@example.com",
        name: "Test User",
        password: "secret",
        internalNote: "Some note",
      };

      const logs = createInsertAuditLogs("test_users", [record], mockConfig);

      expect(logs[0].values).toEqual({
        id: 1,
        email: "test@example.com",
      });
      expect(logs[0].values).not.toHaveProperty("name");
      expect(logs[0].values).not.toHaveProperty("password");
      expect(logs[0].values).not.toHaveProperty("internalNote");
    });

    it("should apply both fields and excludeFields filters", () => {
      mockConfig.fields = {
        test_users: ["id", "email", "password"], // Include password in allowed fields
      };
      mockConfig.excludeFields = ["password"]; // But exclude it globally

      const record = {
        id: 1,
        email: "test@example.com",
        password: "secret",
        name: "Test",
      };

      const logs = createInsertAuditLogs("test_users", [record], mockConfig);

      // Should have id and email, but not password (excluded) or name (not in fields)
      expect(logs[0].values).toEqual({
        id: 1,
        email: "test@example.com",
      });
    });
  });

  describe("Performance implications", () => {
    it('updateValuesMode="full" should result in logs with full values', () => {
      mockConfig.updateValuesMode = "full";

      const afterRecords = [{ id: 1, email: "test@example.com", name: "Test" }];

      const logs = createUpdateAuditLogs(
        "test_users",
        [], // Empty before state - simulating no SELECT query
        afterRecords,
        mockConfig,
      );

      expect(logs[0].values).toBeDefined();
      // This represents the performance benefit: no SELECT query needed
    });

    it('updateValuesMode="changed" should result in logs with diff values', () => {
      mockConfig.updateValuesMode = "changed";

      const beforeRecords = [{ id: 1, email: "old@example.com", name: "Old" }];
      const afterRecords = [{ id: 1, email: "new@example.com", name: "New" }];

      const logs = createUpdateAuditLogs("test_users", beforeRecords, afterRecords, mockConfig);

      expect(logs[0].values).toMatchObject({ email: "new@example.com", name: "New" });
      // This represents the cost: SELECT query was executed
    });
  });
});
