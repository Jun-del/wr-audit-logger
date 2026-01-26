import { test, expect } from "vitest";
import { add } from "../../src/utils.js";

test("add", () => {
  expect(add(1, 2)).toBe(3);
});
