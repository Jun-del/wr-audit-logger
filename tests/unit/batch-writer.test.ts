import { describe, it, expect, vi } from "vitest";
import { BatchAuditWriter } from "../../src/storage/batch-writer.js";

describe("BatchAuditWriter", () => {
  it("does not emit unhandledRejection when writes fail and not awaited", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    const db = {
      execute: vi.fn().mockRejectedValue(new Error("write failed")),
    };

    const writer = new BatchAuditWriter(db as any, {
      auditTable: "audit_logs",
      batchSize: 1,
      flushInterval: 60000,
      strictMode: false,
      waitForWrite: false,
      getUserId: () => undefined,
      getMetadata: () => ({}),
    });

    await writer.queueAuditLogs(
      [
        {
          action: "INSERT",
          tableName: "test_users",
          recordId: "1",
          newValues: { id: 1 },
        },
      ],
      undefined,
    );

    await new Promise((resolve) => setImmediate(resolve));

    expect(unhandled).not.toHaveBeenCalled();

    await writer.shutdown();

    process.off("unhandledRejection", unhandled);
  });
});
