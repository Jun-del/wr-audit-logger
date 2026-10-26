import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { checkAuditSetup, createAuditLogger, getAuditStats } from "../../src/index.js";

const SRC_INDEX = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

describe("batch mode process lifecycle", () => {
  it("does not install SIGINT/SIGTERM handlers", async () => {
    const sigint = process.listenerCount("SIGINT");
    const sigterm = process.listenerCount("SIGTERM");

    const logger = createAuditLogger(
      { execute: vi.fn() } as any,
      {
        tables: { users: { primaryKey: "id" } },
        batch: { flushInterval: 60000 },
      } as any,
    );

    expect(process.listenerCount("SIGINT")).toBe(sigint);
    expect(process.listenerCount("SIGTERM")).toBe(sigterm);
    await logger.shutdown();
  });

  it("lets the process exit and flushes queued logs before it does", () => {
    const script = `
      const { createAuditLogger } = await import(${JSON.stringify(SRC_INDEX)});
      const db = { execute: async () => { console.log("FLUSHED"); return { rows: [] }; } };
      const logger = createAuditLogger(db, {
        tables: { users: { primaryKey: "id" } },
        batch: { flushInterval: 60000 },
      });
      await logger.log({ action: "EXPORT", tableName: "users", recordId: "1" });
    `;

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 10000 },
    );

    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("FLUSHED");
  });
});

describe("driver result shapes", () => {
  it("checkAuditSetup understands array results (postgres-js)", async () => {
    const db = { execute: vi.fn().mockResolvedValue([{ exists: true }]) };
    await expect(checkAuditSetup(db as any)).resolves.toBe(true);
  });

  it("getAuditStats understands array results (postgres-js)", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        {
          total_logs: 3,
          logs_by_action: { INSERT: 3 },
          logs_by_table: { users: 3 },
          oldest_log: null,
          newest_log: null,
        },
      ]),
    };
    await expect(getAuditStats(db as any)).resolves.toMatchObject({ totalLogs: 3 });
  });
});
