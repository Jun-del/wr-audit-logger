import { describe, it, expect } from "vitest";
import { extractPrimaryKey } from "../../src/utils/primary-key.js";

/**
 * Tests for critical bug fixes (batch queue coverage lives in batch-queue.test.ts)
 */
describe("Critical Bug Fixes", () => {
  describe("Fix #3: primary key serialization", () => {
    it("stringifies BigInt in composite keys", () => {
      const result = extractPrimaryKey(
        { orgId: BigInt(9007199254740991), entryId: "e1" },
        "ledger",
        { ledger: { primaryKey: ["orgId", "entryId"] } },
      );

      expect(result).toContain('"9007199254740991"');
      expect(result).toContain('"entryId":"e1"');
    });

    it('serializes circular composite key structures as "[Circular]"', () => {
      const circular: { id: number; self?: unknown } = { id: 1 };
      circular.self = circular;

      const result = extractPrimaryKey({ tenant: "acme", composite: circular }, "records", {
        records: { primaryKey: ["tenant", "composite"] },
      });

      expect(result).toContain('"self":"[Circular]"');
    });
  });
});
