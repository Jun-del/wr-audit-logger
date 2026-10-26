import { describe, it, expect, vi } from "vitest";
import { createAuditLogger } from "../../src/index.js";
import { BatchQueue } from "../../src/storage/batch-queue.js";

const options = {
  batchSize: 5,
  maxQueueSize: 100,
  flushInterval: 60000,
  logError: () => {},
};

describe("BatchQueue", () => {
  it("does not lose items queued while a write is in flight", async () => {
    const written: number[][] = [];
    const queue = new BatchQueue<number>(async (items) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      written.push(items);
    }, options);

    const first = [0, 1, 2, 3, 4].map((i) => queue.enqueue([i])); // fills the batch
    const second = [5, 6, 7].map((i) => queue.enqueue([i])); // queued during the write

    await queue.flush();
    await Promise.all([...first, ...second]);
    await queue.shutdown();

    expect(written).toEqual([
      [0, 1, 2, 3, 4],
      [5, 6, 7],
    ]);
  });

  it("rejects the items of a failed batch and the flush that wrote it", async () => {
    const queue = new BatchQueue<number>(async () => {
      throw new Error("write failed");
    }, options);

    const written = queue.enqueue([1]);
    await expect(queue.flush()).rejects.toThrow("write failed");
    await expect(written).rejects.toThrow("write failed");
    await queue.shutdown();
  });

  it("tracks queue size", async () => {
    const queue = new BatchQueue<number>(async () => {}, { ...options, batchSize: 100 });

    for (let i = 0; i < 10; i++) void queue.enqueue([i]);
    expect(queue.getStats().queueSize).toBe(10);

    await queue.flush();
    expect(queue.getStats().queueSize).toBe(0);
    await queue.shutdown();
  });

  it("rejects items beyond maxQueueSize and after shutdown", async () => {
    const queue = new BatchQueue<number>(async () => {}, {
      ...options,
      batchSize: 10,
      maxQueueSize: 10,
    });

    await expect(queue.enqueue(Array.from({ length: 11 }, (_, i) => i))).rejects.toThrow(
      "capacity exceeded",
    );
    await queue.shutdown();
    await expect(queue.enqueue([1])).rejects.toThrow("shutting down");
  });

  it("shares one beforeExit listener and removes it after the last shutdown", async () => {
    const before = process.listenerCount("beforeExit");
    const a = new BatchQueue<number>(async () => {}, options);
    const b = new BatchQueue<number>(async () => {}, options);
    expect(process.listenerCount("beforeExit")).toBe(before + 1);

    await a.shutdown();
    expect(process.listenerCount("beforeExit")).toBe(before + 1);
    await b.shutdown();
    expect(process.listenerCount("beforeExit")).toBe(before);
  });
});

describe("batch mode through createAuditLogger", () => {
  const entry = { action: "EXPORT", tableName: "users", recordId: "1" } as const;

  it("does not emit unhandledRejection when writes fail and nobody waits", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const logError = vi.fn();

    const logger = createAuditLogger(
      { execute: vi.fn().mockRejectedValue(new Error("write failed")) } as any,
      { tables: { users: { primaryKey: "id" } }, batch: { batchSize: 1 }, logError } as any,
    );

    await logger.log(entry);
    await new Promise((resolve) => setImmediate(resolve));

    expect(unhandled).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("[AUDIT]"), expect.any(Error));

    await logger.shutdown();
    process.off("unhandledRejection", unhandled);
  });

  it("writes immediately when waitForWrite is set, even if the batch isn't full", async () => {
    const customWriter = vi.fn();
    const logger = createAuditLogger(
      {} as any,
      {
        tables: { users: { primaryKey: "id" } },
        batch: { batchSize: 10, waitForWrite: true },
        customWriter,
      } as any,
    );

    await logger.log(entry);

    expect(customWriter).toHaveBeenCalledTimes(1);
    await logger.shutdown();
  });

  it("stores null metadata when merged metadata is empty", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const logger = createAuditLogger(
      { execute } as any,
      {
        tables: { users: { primaryKey: "id" } },
        batch: { batchSize: 1, waitForWrite: true },
      } as any,
    );

    await logger.withContext({ metadata: {} }, () => logger.log(entry));

    expect(execute).toHaveBeenCalledTimes(1);
    const params: unknown[] = execute.mock.calls[0]![0].queryChunks.filter(
      (chunk: unknown) => typeof chunk === "string" && chunk.startsWith("["),
    );
    expect(JSON.parse(params[0] as string)[0].metadata).toBeNull();
    await logger.shutdown();
  });
});
