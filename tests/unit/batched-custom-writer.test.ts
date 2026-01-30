import { describe, it, expect, vi } from "vitest";
import { BatchedCustomWriter } from "../../src/storage/batched-custom-writer.js";

describe("BatchedCustomWriter", () => {
  it("attaches listeners once and cleans up on shutdown", async () => {
    const onSpy = vi.spyOn(process, "on");
    const offSpy = vi.spyOn(process, "off");

    const config = {
      batchSize: 10,
      flushInterval: 60000,
      strictMode: false,
      waitForWrite: false,
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
});
