import { describe, it, expect, vi } from "vitest";
import { BatchedCustomWriter } from "../../src/storage/batched-custom-writer.js";

describe("BatchedCustomWriter", () => {
  it("attaches listeners once and cleans up on shutdown", async () => {
    const onSpy = vi.spyOn(process, "on");
    const offSpy = vi.spyOn(process, "off");

    const config = {
      batchSize: 10,
      maxQueueSize: 100,
      flushInterval: 60000,
      strictMode: false,
      waitForWrite: false,
      logError: () => {},
    };

    const writer1 = new BatchedCustomWriter(async () => {}, config);
    const onCallsAfterFirst = onSpy.mock.calls.length;

    const writer2 = new BatchedCustomWriter(async () => {}, config);
    const onCallsAfterSecond = onSpy.mock.calls.length;

    expect(onCallsAfterSecond).toBe(onCallsAfterFirst);

    await writer1.shutdown();
    const offCallsAfterFirstShutdown = offSpy.mock.calls.length;

    await writer2.shutdown();
    const offCallsAfterSecondShutdown = offSpy.mock.calls.length;

    expect(offCallsAfterSecondShutdown).toBeGreaterThan(offCallsAfterFirstShutdown);

    onSpy.mockRestore();
    offSpy.mockRestore();
  });

  it("flushes immediately when waitForWrite is true even if batch not full", async () => {
    const customWriter = vi.fn(async () => {});

    const config = {
      batchSize: 10,
      maxQueueSize: 100,
      flushInterval: 60000,
      strictMode: false,
      waitForWrite: true,
      logError: () => {},
    };

    const writer = new BatchedCustomWriter(customWriter, config);

    await writer.queueAuditLogs(
      [
        {
          action: "INSERT",
          tableName: "users",
          recordId: "1",
        },
      ],
      { userId: "u1" },
    );

    expect(customWriter).toHaveBeenCalledTimes(1);

    await writer.shutdown();
  });
});
