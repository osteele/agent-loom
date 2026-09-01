import { expect, test } from "bun:test";
import { parseMailStatus } from "./index.ts";

test("OMP status preserves an unknown final Weft field", () => {
  expect(parseMailStatus("Quiet Lantern\t2\t0\tpush\t\n")).toEqual({
    name: "Quiet Lantern",
    unread: 0,
    unprocessed: undefined,
  });
});

test("OMP status rejects malformed counts instead of implying zero", () => {
  expect(parseMailStatus("Quiet Lantern\t2\tmany\tpush\t0\n")).toBeUndefined();
  expect(parseMailStatus("Quiet Lantern\t2\t0\tpush\t-1\n")).toBeUndefined();
});
