import { expect, test } from "bun:test";
import {
  agentMailSessionId,
  parseMailStatus,
  renderStatus,
} from "./index.ts";

test("OMP status preserves an unknown final Weft field", () => {
  expect(parseMailStatus("Quiet Lantern\t2\t0\tpush\t\n")).toEqual({
    name: "Quiet Lantern",
    peers: 2,
    unread: 0,
    delivery: "push",
    unprocessed: undefined,
  });
});

test("OMP status rejects malformed agent-mail fields", () => {
  expect(parseMailStatus("Quiet Lantern\tmany\t0\tpush\t0\n")).toBeUndefined();
  expect(parseMailStatus("Quiet Lantern\t2\tmany\tpush\t0\n")).toBeUndefined();
  expect(parseMailStatus("Quiet Lantern\t2\t0\tdirect\t0\n")).toBeUndefined();
  expect(parseMailStatus("Quiet Lantern\t2\t0\tpush\t-1\n")).toBeUndefined();
});

test("OMP shares a launcher identity only when minted for this process", () => {
  expect(agentMailSessionId("omp-native", "launcher-shared", "42", 42)).toBe(
    "launcher-shared",
  );
  expect(agentMailSessionId("omp-native", "parent-agent", "41", 42)).toBe(
    "omp-native",
  );
  expect(agentMailSessionId("omp-native", "  ", "42", 42)).toBe("omp-native");
});

test("OMP uses its native status slot for agent-mail and Weft state", () => {
  expect(
    renderStatus({
      mail: {
        name: "Quiet Lantern",
        peers: 2,
        unread: 1,
        delivery: "push",
        unprocessed: 3,
      },
      push: "online",
    }),
  ).toBe("mail Quiet Lantern · 2 peers · 1 unread · 3 unprocessed");
});
