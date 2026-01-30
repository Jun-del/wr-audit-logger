import type { NormalizedConfig } from "../../src/types/config.js";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDeleteAuditLogs } from "../../src/capture/delete.js";
import { createInsertAuditLogs } from "../../src/capture/insert.js";
import { createUpdateAuditLogs } from "../../src/capture/update.js";

describe("Capture Configuration (Unit Tests)", () => {
  let mockConfig: NormalizedConfig;

  beforeEach(() => {
    mockConfig = {
      tables: ["test_users"],
      fields: {},
      excludeFields: ["password"],
      auditTable: "audit_logs",
      strictMode: false,
      getUserId: vi.fn().mockReturnValue(undefined),
      getMetadata: vi.fn().mockReturnValue({}),
      captureOldValues: false,
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
        newValues: {
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

      expect(logs[0].newValues).toMatchObject({
        id: 1,
        email: "test@example.com",
      });
      expect(logs[0].newValues).not.toHaveProperty("password");
    });
  });

  describe("UPDATE capture with captureOldValues=true", () => {
    beforeEach(() => {
      mockConfig.captureOldValues = true;
    });

    it("should capture both old and new values when enabled", () => {
      const beforeRecords = [{ id: 1, email: "old@example.com", name: "Old Name" }];
      const afterRecords = [{ id: 1, email: "new@example.com", name: "New Name" }];

      const logs = createUpdateAuditLogs("test_users", beforeRecords, afterRecords, mockConfig);

      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        action: "UPDATE",
        tableName: "test_users",
        recordId: "1",
        oldValues: {
          id: 1,
          email: "old@example.com",
          name: "Old Name",
        },
        newValues: {
          id: 1,
          email: "new@example.com",
          name: "New Name",
        },
        changedFields: ["email", "name"],
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

      expect(logs[0].changedFields).toEqual(["name"]);
      expect(logs[0].oldValues?.name).toBe("Old Name");
      expect(logs[0].newValues?.name).toBe("New Name");
    });

    it("should log new values when before state is missing", () => {
      const afterRecords = [{ id: 1, email: "new@example.com", name: "New Name" }];

      const logs = createUpdateAuditLogs("test_users", [], afterRecords, mockConfig);

      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        action: "UPDATE",
        tableName: "test_users",
        recordId: "1",
        oldValues: undefined,
        newValues: {
          id: 1,
          email: "new@example.com",
          name: "New Name",
        },
        changedFields: undefined,
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

      expect(logWithBefore?.oldValues).toBeDefined();
      expect(logWithBefore?.changedFields).toEqual(["email", "name"]);
      expect(logWithoutBefore?.oldValues).toBeUndefined();
      expect(logWithoutBefore?.changedFields).toBeUndefined();
    });
  });

  describe("UPDATE capture with captureOldValues=false", () => {
    beforeEach(() => {
      mockConfig.captureOldValues = false;
    });

    it("should NOT capture old values when disabled", () => {
      const beforeRecords: any[] = []; // Empty - no before state captured
      const afterRecords = [{ id: 1, email: "new@example.com", name: "New Name" }];

      const logs = createUpdateAuditLogs("test_users", beforeRecords, afterRecords, mockConfig);

      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        action: "UPDATE",
        tableName: "test_users",
        recordId: "1",
        oldValues: undefined,
        newValues: {
          id: 1,
          email: "new@example.com",
          name: "New Name",
        },
        changedFields: undefined,
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
        expect(log.oldValues).toBeUndefined();
        expect(log.newValues).toBeDefined();
        expect(log.changedFields).toBeUndefined();
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
        oldValues: {
          id: 1,
          email: "deleted@example.com",
          name: "Deleted User",
        },
        newValues: undefined,
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

      expect(logs[0].newValues).toEqual({
        id: 1,
        email: "test@example.com",
      });
      expect(logs[0].newValues).not.toHaveProperty("name");
      expect(logs[0].newValues).not.toHaveProperty("password");
      expect(logs[0].newValues).not.toHaveProperty("internalNote");
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
      expect(logs[0].newValues).toEqual({
        id: 1,
        email: "test@example.com",
      });
    });
  });

  describe("Performance implications", () => {
    it("captureOldValues=false should result in logs without oldValues", () => {
      mockConfig.captureOldValues = false;

      const afterRecords = [{ id: 1, email: "test@example.com", name: "Test" }];

      const logs = createUpdateAuditLogs(
        "test_users",
        [], // Empty before state - simulating no SELECT query
        afterRecords,
        mockConfig,
      );

      expect(logs[0].oldValues).toBeUndefined();
      // This represents the performance benefit: no SELECT query needed
    });

    it("captureOldValues=true should result in logs with oldValues", () => {
      mockConfig.captureOldValues = true;

      const beforeRecords = [{ id: 1, email: "old@example.com", name: "Old" }];
      const afterRecords = [{ id: 1, email: "new@example.com", name: "New" }];

      const logs = createUpdateAuditLogs("test_users", beforeRecords, afterRecords, mockConfig);

      expect(logs[0].oldValues).toBeDefined();
      // This represents the cost: SELECT query was executed
    });
  });
});
